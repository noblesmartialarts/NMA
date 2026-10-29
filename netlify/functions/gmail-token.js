// Fresh Gmail access token for a signed-in CRM user, from the stored refresh token.
// GET → { connected:true, access_token, expires_in, email } | { connected:false, reason }
const S = require('../lib/session');
const G = require('../lib/gmail');

exports.handler = async (event) => {
  const user = await S.requireUser(event);
  if (user.error) return user.error;
  if (!G.clientSecret()) return S.json(503, { error: 'not_configured', message: 'GOOGLE_CLIENT_SECRET is not set for this Netlify site' });
  try {
    const sec = await G.getSecret();
    if (!sec || !sec.refresh_token) return S.json(200, { connected: false, reason: 'not_connected' });
    const t = await G.tokenRequest({ refresh_token: sec.refresh_token, grant_type: 'refresh_token' });
    if (!t.ok) {
      if (t.data && t.data.error === 'invalid_grant') {
        // Revoked, password changed, or (if the Google app is in "Testing") expired after 7 days.
        await G.deleteSecret();
        return S.json(200, { connected: false, reason: 'revoked' });
      }
      return S.json(502, { error: 'refresh_failed', message: t.data.error_description || t.data.error || ('Google error ' + t.status) });
    }
    return S.json(200, { connected: true, access_token: t.data.access_token, expires_in: t.data.expires_in || 3600, email: sec.email || null });
  } catch (e) {
    return S.json(500, { error: 'server_error', message: e.message });
  }
};
