export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    if (request.method === 'POST' && new URL(request.url).pathname === '/api/rewrite') {
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

        // Get user plan and rewrite count from DB
        const dbRes = await fetch(`${env.SUPABASE_URL}/rest/v1/users?id=eq.${userId}&select=subscription_status,rewrite_count`, {
          headers: { 'Authorization': `Bearer ${token}`, 'apikey': env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }
        });
        const dbData = await dbRes.json();
        const userRow = dbData && dbData[0];
        const plan = (userRow && userRow.subscription_status) || 'free';
        const rewriteCount = (userRow && userRow.rewrite_count) || 0;

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
