// Server-held Gmail authorization for the CRM.
// The long-lived refresh token lives in public.crm_secrets (service role only);
// browsers only ever receive short-lived access tokens.
const S = require('./session');

const CLIENT_ID = '198044968744-8sr41pe9995b07pg0c9l55h9pp1ff0j7.apps.googleusercontent.com';
const KEY = 'gmail';

function clientSecret() { return process.env.GOOGLE_CLIENT_SECRET || ''; }

async function getSecret() {
  const r = await S.supa('GET', '/rest/v1/crm_secrets?key=eq.' + KEY + '&select=value');
  if (!r.ok) throw new Error('Could not read Gmail settings (' + r.status + ')');
  const rows = await r.json();
  return rows[0] ? rows[0].value : null;
}
async function putSecret(value) {
  const r = await S.supa('POST', '/rest/v1/crm_secrets?on_conflict=key', { key: KEY, value, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
  if (!r.ok) throw new Error('Could not save Gmail settings (' + r.status + ')');
}
async function deleteSecret() {
  await S.supa('DELETE', '/rest/v1/crm_secrets?key=eq.' + KEY);
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_id: CLIENT_ID, client_secret: clientSecret() }, params)).toString(),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function emailForAccessToken(at) {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(at));
    const j = await r.json();
    return j.email || null;
  } catch (e) { return null; }
}

module.exports = { CLIENT_ID, clientSecret, getSecret, putSecret, deleteSecret, tokenRequest, emailForAccessToken };
