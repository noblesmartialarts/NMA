// Connect / disconnect the CRM's Gmail once, server-side.
// POST { code }        → exchanges the one-time Google code for a refresh token and stores it
// POST { disconnect }  → revokes and forgets it
// Requires GOOGLE_CLIENT_SECRET in Netlify (the secret of the CRM's Google OAuth client).
const S = require('../lib/session');
const G = require('../lib/gmail');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return S.json(405, { error: 'method_not_allowed' });
  const user = await S.requireUser(event);
  if (user.error) return user.error;
  if (!G.clientSecret()) return S.json(503, { error: 'not_configured', message: 'GOOGLE_CLIENT_SECRET is not set for this Netlify site' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return S.json(400, { error: 'bad_json' }); }

  try {
    if (body.disconnect) {
      const sec = await G.getSecret();
      if (sec && sec.refresh_token) {
        await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(sec.refresh_token), { method: 'POST' }).catch(() => {});
      }
      await G.deleteSecret();
      return S.json(200, { ok: true });
    }

    if (!body.code) return S.json(400, { error: 'missing_code' });
    const t = await G.tokenRequest({ code: body.code, grant_type: 'authorization_code', redirect_uri: 'postmessage' });
    if (!t.ok) return S.json(400, { error: 'exchange_failed', message: t.data.error_description || t.data.error || ('Google error ' + t.status) });

    let refresh = t.data.refresh_token;
    if (!refresh) {
      // Google only issues a refresh token on first consent; keep an existing one if we have it.
      const prev = await G.getSecret();
      if (prev && prev.refresh_token) refresh = prev.refresh_token;
    }
    if (!refresh) {
      return S.json(409, { error: 'no_refresh_token', message: 'Google did not grant lasting access. Remove "Noble\'s Martial Arts CRM" at myaccount.google.com/permissions, then connect Gmail again.' });
    }
    const email = await G.emailForAccessToken(t.data.access_token);
    await G.putSecret({ refresh_token: refresh, scope: t.data.scope || '', email, connectedBy: user.email, connectedAt: new Date().toISOString() });
    return S.json(200, { ok: true, email, access_token: t.data.access_token, expires_in: t.data.expires_in || 3600 });
  } catch (e) {
    return S.json(500, { error: 'server_error', message: e.message });
  }
};
