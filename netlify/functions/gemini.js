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

    // Try models in order — gemini-2.0-flash first (requires billing, which is enabled)
    // then stable fallbacks
    const candidates = [
      { model: 'gemini-2.0-flash', api: 'v1beta' },
      { model: 'gemini-2.0-flash-lite', api: 'v1beta' },
      { model: 'gemini-1.5-flash', api: 'v1beta' },
      { model: 'gemini-1.5-flash-latest', api: 'v1beta' },
      { model: 'gemini-1.5-flash-001', api: 'v1beta' },
      { model: 'gemini-1.0-pro', api: 'v1beta' },
    ];

    let lastError = null;

    for (const { model, api } of candidates) {
      const url = `https://generativelanguage.googleapis.com/${api}/models/${model}:generateContent?key=${GEMINI_KEY}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: body.contents,
          generationConfig: body.generationConfig || { temperature: 0.7, maxOutputTokens: 1024 }
        })
      });

      const data = await response.json();

      // Skip to next model if not found or quota exceeded
      if (!response.ok) {
        const errMsg = data.error?.message || '';
        if (errMsg.includes('not found') || errMsg.includes('MODEL_NOT_FOUND') ||
            errMsg.includes('quota') || errMsg.includes('RESOURCE_EXHAUSTED')) {
          lastError = `${model}: ${errMsg}`;
          continue;
        }
      }

      // Return result (success or other error)
      return {
        statusCode: response.status,
        headers: { 'Content-Type': 'application/json', 'X-Model-Used': model },
        body: JSON.stringify(data)
      };
    }

    // All models failed
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
