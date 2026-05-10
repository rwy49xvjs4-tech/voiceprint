// api/rewrite.js
// This file runs on Vercel's servers — your Anthropic API key is never exposed to the browser

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Basic CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  try {
    const { prompt, userId, plan } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'No prompt provided' });
    }

    if (!userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Check word limit for free users (extra server-side protection)
    if (plan === 'free' && prompt.length > 3000) {
      return res.status(403).json({ error: 'Word limit exceeded for free plan' });
    }

    // Call Claude API using the secret key stored in Vercel environment variables
    // ANTHROPIC_API_KEY is set in Vercel dashboard — never in your code
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      return res.status(500).json({ error: 'AI service error — try again' });
    }

    const data = await response.json();
    const result = data.content && data.content[0] ? data.content[0].text : '';

    return res.status(200).json({ result });

  } catch (error) {
    console.error('Rewrite error:', error);
    return res.status(500).json({ error: 'Server error — try again' });
  }
}
