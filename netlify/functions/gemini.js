exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: { message: 'GEMINI_API_KEY env var not set in Netlify' } }) };
  }

  try {
    const body = JSON.parse(event.body);

    // Ordered by availability — skip deprecated gemini-2.0-flash
    const candidates = [
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
      'gemini-1.5-flash-latest',
      'gemini-1.5-flash-8b',
      'gemini-1.0-pro',
    ];

    let lastError = null;

    for (const model of candidates) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: body.contents,
          generationConfig: body.generationConfig || { temperature: 0.7, maxOutputTokens: 1024 }
        })
      });

      const data = await response.json();

      if (!response.ok) {
        // Skip to next model on ANY failure — don't stop on first error
        lastError = `${model}: ${data.error?.message || response.status}`;
        continue;
      }

      // Success
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'X-Model-Used': model },
        body: JSON.stringify(data)
      };
    }

    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'No Gemini models available. Last error: ' + lastError } })
    };

  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: e.message } })
    };
  }
};
