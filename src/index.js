export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    // ─── STRIPE WEBHOOK ────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/webhook') {
      try {
        const body = await request.text();
        const sig = request.headers.get('stripe-signature');

        // Verify webhook signature using Stripe's algorithm
        const secret = env.STRIPE_WEBHOOK_SECRET;
        if (!secret || !sig) {
          return new Response('Missing signature', { status: 400 });
        }

        // Parse timestamp and signatures from header
        const parts = sig.split(',');
        let timestamp = '';
        const signatures = [];
        for (const part of parts) {
          if (part.startsWith('t=')) timestamp = part.slice(2);
          if (part.startsWith('v1=')) signatures.push(part.slice(3));
        }

        // Verify HMAC-SHA256
        const signedPayload = `${timestamp}.${body}`;
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        );
        const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
        const expectedSig = Array.from(new Uint8Array(signatureBytes)).map(b => b.toString(16).padStart(2, '0')).join('');

        const valid = signatures.some(s => s === expectedSig);
        if (!valid) {
          return new Response('Invalid signature', { status: 400 });
        }

        const event = JSON.parse(body);

        if (event.type === 'checkout.session.completed') {
          const session = event.data.object;
          const customerEmail = session.customer_details && session.customer_details.email;
          const priceId = session.line_items && session.line_items.data && session.line_items.data[0] && session.line_items.data[0].price && session.line_items.data[0].price.id;

          // Determine plan from price ID
          let newPlan = null;
          if (priceId === env.STRIPE_PRICE_PLUS) newPlan = 'plus';
          else if (priceId === env.STRIPE_PRICE_PRO) newPlan = 'pro';

          // Also check metadata in case price ID isn't in line_items
          if (!newPlan && session.metadata) {
            if (session.metadata.plan === 'plus') newPlan = 'plus';
            if (session.metadata.plan === 'pro') newPlan = 'pro';
          }

          // Fallback: detect by amount
          if (!newPlan) {
            const amount = session.amount_total;
            if (amount === 499) newPlan = 'plus';
            else if (amount === 799) newPlan = 'pro';
          }

          if (customerEmail && newPlan) {
            // Update user in Supabase using service role key (bypasses RLS)
            await fetch(`${env.SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(customerEmail)}`, {
              method: 'PATCH',
              headers: {
                'apikey': env.SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
              },
              body: JSON.stringify({
                subscription_status: newPlan,
                rewrite_count: 0,
                rewrite_count_reset_at: new Date().toISOString()
              })
            });
          }
        }

        if (event.type === 'customer.subscription.deleted') {
          // Downgrade to free if subscription cancelled
          const subscription = event.data.object;
          const customerId = subscription.customer;

          // Look up customer email from Stripe
          const custRes = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
            headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
          });
          if (custRes.ok) {
            const cust = await custRes.json();
            const email = cust.email;
            if (email) {
              await fetch(`${env.SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}`, {
                method: 'PATCH',
                headers: {
                  'apikey': env.SUPABASE_SERVICE_KEY,
                  'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
                  'Content-Type': 'application/json',
                  'Prefer': 'return=minimal'
                },
                body: JSON.stringify({ subscription_status: 'free' })
              });
            }
          }
        }

        return new Response(JSON.stringify({ received: true }), {
          headers: { 'Content-Type': 'application/json' }
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // ─── REWRITE ───────────────────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/rewrite') {
      try {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }
        const token = authHeader.replace('Bearer ', '');

        // Verify token and get user from Supabase
        const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
          headers: { 'Authorization': `Bearer ${token}`, 'apikey': env.SUPABASE_ANON_KEY }
        });
        if (!userRes.ok) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }
        const userData = await userRes.json();
        const userId = userData.id;

        // Get user plan, rewrite count, and reset date from DB
        const dbRes = await fetch(`${env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=subscription_status,rewrite_count,rewrite_count_reset_at`, {
          headers: { 'Authorization': `Bearer ${token}`, 'apikey': env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }
        });
        const dbData = await dbRes.json();
        const userRow = dbData && dbData[0];
        const plan = (userRow && userRow.subscription_status) || 'free';
        let rewriteCount = (userRow && userRow.rewrite_count) || 0;
        const resetAt = userRow && userRow.rewrite_count_reset_at;

        // Monthly reset for paid plans only — free users keep their 1 rewrite as a permanent trial
        const isPaid = plan === 'plus' || plan === 'pro';
        const needsReset = isPaid && (!resetAt || (Date.now() - new Date(resetAt).getTime()) > 30 * 24 * 60 * 60 * 1000);
        if (needsReset) {
          rewriteCount = 0;
          await fetch(`${env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${token}`,
              'apikey': env.SUPABASE_ANON_KEY,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ rewrite_count: 0, rewrite_count_reset_at: new Date().toISOString() })
          });
        }

        // Enforce limits server-side
        const limits = { free: { rewrites: 1, words: 500 }, plus: { rewrites: 30, words: 1000 }, pro: { rewrites: 60, words: 2000 } };
        const planLimits = limits[plan] || limits.free;

        const body = await request.json();
        const { text, traits, strength } = body;

        // Check word count
        const wordCount = text ? text.split(/\s+/).filter(w => w.length > 0).length : 0;
        if (wordCount > planLimits.words) {
          return new Response(JSON.stringify({ error: `Your plan allows up to ${planLimits.words} words per rewrite.` }), { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }

        // Check rewrite count
        if (rewriteCount >= planLimits.rewrites) {
          return new Response(JSON.stringify({ error: 'limit_reached' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }

        // Build prompt
        const voiceDesc = traits ? `
Voice profile (scores 0-100):
- Formality: ${traits.formality}/100 (0=very casual, 100=very formal)
- Slang usage: ${traits.slang}/100 (0=none, 100=heavy slang)
- Contractions: ${traits.contractions}/100 (0=never, 100=always)
- Sentence length: ${traits.sentenceLength}/100 (0=long sentences, 100=short sentences)
- Emphasis style: ${traits.emphasis}/100 (0=understated, 100=heavy emphasis)
` : 'Match a natural, human writing style.';

        const intensity = strength ? Math.round(strength) : 75;
        const prompt = `You are a writing humanizer. Rewrite the following AI-generated text to sound authentically human, matching this specific voice profile at ${intensity}% intensity.

${voiceDesc}

Rules:
- Preserve ALL meaning and facts
- Match the voice profile naturally
- Remove AI tells (excessive hedging, robotic transitions, unnatural formality)
- Keep it the same approximate length
- Do NOT add explanations or commentary, just return the rewritten text

Text to rewrite:
${text}`;

        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        if (!aiRes.ok) {
          const err = await aiRes.text();
          return new Response(JSON.stringify({ error: 'AI error: ' + err }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }

        const aiData = await aiRes.json();
        const output = aiData.content && aiData.content[0] && aiData.content[0].text;

        // Increment rewrite count server-side
        await fetch(`${env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${token}`,
            'apikey': env.SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ rewrite_count: rewriteCount + 1 })
        });

        return new Response(JSON.stringify({ output, newCount: rewriteCount + 1 }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
