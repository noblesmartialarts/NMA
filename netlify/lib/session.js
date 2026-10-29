// Shared helpers for the CRM's server-side data path.
// - Sessions: after Google sign-in is verified, the browser gets a signed
//   session token (HMAC) so it never needs database keys.
// - Allowlist: the owner plus DB.authorizedUsers (same list as the Access UI).
// - supa(): PostgREST calls with the service key (kept in Netlify env only).
const crypto = require('crypto');

const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';
const OWNER_EMAIL = 'noblesmartialarts@gmail.com';
const GOOGLE_CLIENT_ID = '198044968744-8sr41pe9995b07pg0c9l55h9pp1ff0j7.apps.googleusercontent.com';
const SESSION_DAYS = 30;

function serviceKey() { return process.env.SUPABASE_SERVICE_KEY || ''; }
function configured() { return !!serviceKey(); }

function secret() {
  if (process.env.CRM_SESSION_SECRET) return process.env.CRM_SESSION_SECRET;
  // Derived from the service key so no extra setup is needed; rotating the
  // service key (or setting CRM_SESSION_SECRET) signs everyone out.
  return crypto.createHmac('sha256', serviceKey()).update('nma-crm-session-v1').digest('hex');
}
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function signSession(user) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = b64u(JSON.stringify({ e: String(user.email).toLowerCase(), x: exp }));
  const sig = b64u(crypto.createHmac('sha256', secret()).update(payload).digest());
  return { token: payload + '.' + sig, exp };
}
function verifySession(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const expect = b64u(crypto.createHmac('sha256', secret()).update(payload).digest());
  const a = Buffer.from(sig || ''), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(unb64u(payload));
    if (!p.e || !p.x || p.x < Date.now() / 1000) return null;
    return p.e;
  } catch (e) { return null; }
}
function bearer(event) {
  const h = event.headers || {};
  const v = h.authorization || h.Authorization || '';
  return v.replace(/^Bearer\s+/i, '');
}

async function supa(method, path, body, prefer, extra) {
  const headers = Object.assign({
    apikey: serviceKey(),
    Authorization: 'Bearer ' + serviceKey(),
    'Content-Type': 'application/json',
  }, extra || {});
  if (prefer) headers.Prefer = prefer;
  return fetch(SUPA_URL + path, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
}

let _allowCache = { at: 0, list: [] };
async function allowedEmails() {
  if (Date.now() - _allowCache.at < 60000) return _allowCache.list;
  const res = await supa('GET', '/rest/v1/crm_data?id=eq.main&select=users:data->authorizedUsers');
  const rows = res.ok ? await res.json() : [];
  const raw = (rows[0] && rows[0].users) || [];
  const list = [OWNER_EMAIL].concat((Array.isArray(raw) ? raw : []).map(u => (typeof u === 'string' ? u : (u && u.email)) || ''))
    .map(e => e.toLowerCase().trim()).filter(Boolean);
  _allowCache = { at: Date.now(), list };
  return list;
}
async function isAllowed(email) {
  if (!email) return false;
  return (await allowedEmails()).includes(String(email).toLowerCase());
}
// Returns the signed-in email, or a ready-made error response.
async function requireUser(event) {
  if (!configured()) return { error: json(503, { error: 'not_configured', message: 'SUPABASE_SERVICE_KEY is not set for this Netlify site' }) };
  const email = verifySession(bearer(event));
  if (!email) return { error: json(401, { error: 'unauthorized', message: 'Sign in again' }) };
  if (!(await isAllowed(email))) return { error: json(403, { error: 'forbidden', message: email + ' is not on the CRM access list' }) };
  return { email };
}

async function verifyGoogleCredential(credential) {
  const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!res.ok) return null;
  const t = await res.json();
  if (t.aud !== GOOGLE_CLIENT_ID) return null;
  if (!(t.email_verified === true || t.email_verified === 'true')) return null;
  if (Number(t.exp) < Date.now() / 1000) return null;
  return { email: String(t.email).toLowerCase(), name: t.name || '', picture: t.picture || '' };
}

function json(statusCode, obj, headers) {
  return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, headers || {}), body: JSON.stringify(obj) };
}

module.exports = { SUPA_URL, OWNER_EMAIL, configured, signSession, verifySession, bearer, supa, isAllowed, requireUser, verifyGoogleCredential, json };
