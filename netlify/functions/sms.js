// Send one SMS through Twilio for a signed-in CRM user.
// Twilio credentials are read server-side (Netlify env TWILIO_SID / TWILIO_TOKEN /
// TWILIO_FROM if set, otherwise the Twilio settings saved in the CRM) — the
// browser never sends or receives the auth token.
// POST { to, body } → { sid } or { error }
const S = require('../lib/session');

async function twilioConfig() {
  if (process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM) {
    return { sid: process.env.TWILIO_SID, token: process.env.TWILIO_TOKEN, from: process.env.TWILIO_FROM };
  }
  const res = await S.supa('GET', '/rest/v1/crm_data?id=eq.main&select=cfg:data->twilioConfig');
  const rows = res.ok ? await res.json() : [];
  return (rows[0] && rows[0].cfg) || {};
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return S.json(405, { error: 'method_not_allowed' });
  const user = await S.requireUser(event);
  if (user.error) return user.error;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return S.json(400, { error: 'bad_json' }); }
  const to = String(body.to || '').trim();
  const text = String(body.body || '');
  if (!/^\+\d{10,15}$/.test(to)) return S.json(400, { error: 'Invalid phone number (needs +1XXXXXXXXXX format)' });
  if (!text) return S.json(400, { error: 'Empty message' });
  if (text.length > 1600) return S.json(400, { error: 'Message too long' });

  const cfg = await twilioConfig();
  if (!cfg.sid || !cfg.token || !cfg.from) return S.json(400, { error: 'Twilio is not set up — add your Account SID, Auth Token and number in SMS → Twilio Settings' });

  const res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(cfg.sid) + '/Messages.json', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(cfg.sid + ':' + cfg.token).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: cfg.from, Body: text }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return S.json(res.status === 401 ? 400 : 502, { error: data.message || ('Twilio error ' + res.status), code: data.code || null });
  return S.json(200, { sid: data.sid, status: data.status });
};
