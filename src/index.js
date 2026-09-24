export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // ── SECURE REWRITE ENDPOINT ──────────────────────────────
    if (url.pathname === '/api/rewrite' && request.method === 'POST') {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      };

      try {
        const body = await request.json();
        const { prompt } = body;

        if (!prompt) {
          return new Response(
            JSON.stringify({ error: 'No prompt provided' }),
            { status: 400, headers: corsHeaders }
          );
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1000,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const data = await response.json();

        if (!response.ok) {
          return new Response(
            JSON.stringify({ error: data.error?.message || 'API error' }),
            { status: response.status, headers: corsHeaders }
          );
        }

        const result = data.content && data.content[0] ? data.content[0].text : '';

        return new Response(
          JSON.stringify({ result }),
          { status: 200, headers: corsHeaders }
        );

      } catch (err) {
        return new Response(
          JSON.stringify({ error: err.message || 'Server error' }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // ── STATIC ASSETS ────────────────────────────────────────
    return env.ASSETS.fetch(request);
  }
};
