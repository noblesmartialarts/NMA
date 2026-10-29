// Proxy for the Gemini API — keeps GEMINI_API_KEY server-side.
// Accepts { contents, generationConfig?, systemInstruction? } and tries
// current models in order, falling through on any error.
// Set GEMINI_MODEL in Netlify to force a specific model first.

// Current models per ai.google.dev/models (checked Oct 2026).
// Gemini 2.0 models are shut down; 2.5 is limited to existing users.
const CANDIDATES = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash',
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: { message: 'GEMINI_API_KEY env var not set in Netlify' } }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    if (!Array.isArray(body.contents) || !body.contents.length) {
      return { statusCode: 400, body: JSON.stringify({ error: { message: 'Request needs a non-empty "contents" array' } }) };
    }

    // Caller may ask for a specific model first (e.g. the faster Flash-Lite), then env override, then the default chain.
    const requested = typeof body.model === 'string' && /^gemini-[\w.-]+$/.test(body.model) ? body.model : null;
    const preferred = [requested, process.env.GEMINI_MODEL].filter(Boolean);
    const models = [...new Set([...preferred, ...CANDIDATES])];

    const payload = {
      contents: body.contents,
      // Newer models count "thinking" toward the output limit, so keep this generous.
      generationConfig: Object.assign({ temperature: 0.7, maxOutputTokens: 4096 }, body.generationConfig || {}),
    };
    if (body.systemInstruction) {
      payload.systemInstruction = typeof body.systemInstruction === 'string'
        ? { parts: [{ text: body.systemInstruction }] }
        : body.systemInstruction;
    }

    const errors = [];
    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      let response, data;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
          body: JSON.stringify(payload),
        });
        data = await response.json();
      } catch (e) {
        errors.push(`${model}: ${e.message}`);
        continue;
      }

      if (!response.ok) {
        const msg = (data && data.error && data.error.message) || String(response.status);
        errors.push(`${model}: ${msg}`);
        // A bad/missing key fails the same way on every model — stop early.
        if (response.status === 400 && /API key/i.test(msg)) break;
        if (response.status === 403) break;
        continue;
      }

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'X-Model-Used': model },
        body: JSON.stringify(Object.assign({}, data, { modelUsed: model })),
      };
    }

    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'No Gemini model responded. ' + errors.join(' | ') } }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: e.message } }),
    };
  }
};
