// Exchange a Google sign-in credential for a CRM session.
// POST { credential }  → { token, exp, user:{email,name,picture} }
// GET  (Authorization: Bearer <token>) → { ok, email } — checks a saved session.
const S = require('../lib/session');

exports.handler = async (event) => {
  if (!S.configured()) return S.json(503, { error: 'not_configured', message: 'SUPABASE_SERVICE_KEY is not set for this Netlify site' });

  if (event.httpMethod === 'GET') {
    const r = await S.requireUser(event);
    if (r.error) return r.error;
    return S.json(200, { ok: true, email: r.email });
  }
  if (event.httpMethod !== 'POST') return S.json(405, { error: 'method_not_allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return S.json(400, { error: 'bad_json' }); }
  if (!body.credential) return S.json(400, { error: 'missing_credential' });

  const user = await S.verifyGoogleCredential(body.credential);
  if (!user) return S.json(401, { error: 'invalid_credential', message: 'Google sign-in could not be verified' });
  if (!(await S.isAllowed(user.email))) return S.json(403, { error: 'forbidden', message: user.email + ' is not on the CRM access list', user });

  const s = S.signSession(user);
  return S.json(200, { token: s.token, exp: s.exp, user });
};
