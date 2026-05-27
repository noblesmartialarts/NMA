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

    // Try models in order until one works
    const models = [
      'gemini-1.5-flash',
      'gemini-1.5-flash-001',
      'gemini-1.0-pro',
      'gemini-pro'
    ];

    let lastError = null;

    for (const model of models) {
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

      // If model not found, try next
      if (!response.ok && data.error?.message?.includes('not found')) {
        lastError = data.error.message;
        continue;
      }

      // Return whatever Gemini says (success or other error)
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      };
    }

    // All models failed
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'No available Gemini models found. Last error: ' + lastError } })
    };

  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: { message: e.message } })
    };
  }
};
