/**
 * VOICEPRINT — Cloudflare Worker
 * 
 * This worker does two things:
 * 1. Serves the static HTML app (index.html)
 * 2. Handles /api/rewrite — calls Anthropic API securely
 *    using the ANTHROPIC_API_KEY environment variable.
 *    The key is NEVER exposed to the browser.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── SECURE REWRITE ENDPOINT ──────────────────────────────
    if (url.pathname === '/api/rewrite' && request.method === 'POST') {
      
      // Only allow POST from your own domain
      const origin = request.headers.get('Origin') || '';
      const allowedOrigins = [
        'https://voiceprint.fistumbellaire123.workers.dev',
        'https://voiceprinthumanizer.com',
        'http://localhost:3000'
      ];

      const corsHeaders = {
        'Access-Control-Allow-Origin': allowedOrigins.includes(origin) ? origin : allowedOrigins[0],
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
      };

      // Handle preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
      }

      try {
        const body = await request.json();
        const { prompt } = body;

        if (!prompt) {
          return new Response(
            JSON.stringify({ error: 'No prompt provided' }),
            { status: 400, headers: corsHeaders }
          );
        }

        // Call Anthropic API — key is securely stored in env variable
        // NEVER exposed to the browser
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,  // secure — from Cloudflare env
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
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
          JSON.stringify({ error: 'Server error — try again' }),
          { status: 500, headers: corsHeaders }
        );
      }
    }

    // ── STATIC ASSETS (serves index.html and other files) ────
    // All other requests are handled by Cloudflare's static asset serving
    return env.ASSETS.fetch(request);
  }
};
