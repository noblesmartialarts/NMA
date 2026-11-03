// Parent portal API (noblesmartialarts.com/family proxies /api/portal here).
//
// Parent ops (POST JSON, no CRM access):
//   request-code {email}            → emails a 6-digit sign-in code (same reply whether or not the email is on file)
//   verify-code  {email, code}      → {token, exp}
//   redeem-link  {link}             → {token, exp}   (single-use invite links from the CRM)
//   device-code  {token}            → {code} to sign in on another device (shown on screen, not emailed)
//   request-guardian {token, name, email, phone, relationship, studentIds} → Sensei approves in the CRM
//   me           {token}            → the family's portal view, filtered to the guardian's kids
//   submit-intent{token, studentId, eventId, answers, note, focus, programFeedback, signedBy, affirm, studentSigned}
//
// Staff ops (CRM session in Authorization header, owner/authorized users only):
//   staff-publish {guardians:[…], views:[{id,data}], familyIds:[…]}   → sync access list and family views
//   staff-link    {familyId, contactId}                               → {url} invite link (14 days, 3 uses)
//   staff-revoke  {familyId}                                          → signs out every device for that family
//   staff-inbox   {status?}                                           → submissions to review
//   staff-inbox-mark {id, status}
//   staff-activity {familyId?}                                        → recent sign-ins
//
// The portal never touches crm_data. Views are built by the CRM (same belt
// logic as everywhere else) and parents' submissions wait in portal_inbox.
const crypto = require('crypto');
const S = require('../lib/session');
const G = require('../lib/gmail');

const PORTAL_URL = process.env.PORTAL_URL || 'https://noblesmartialarts.com/family';
const SESSION_DAYS = 90;
const CODE_MINUTES = 10;
const LINK_DAYS = 3, LINK_USES = 1; // invite links: one sign-in, then codes
const PF_KEYS = ['practices_home', 'no_talk_back', 'shares', 'chores', 'attention_school', 'listens', 'bedtime', 'honest', 'respectful', 'academics'];
const PF_THEMES = ['Respect & manners', 'Listening', 'Interrupting / talking back', 'Self-control & calm', 'Frustration / perseverance', 'Focus & attention', 'Practice at home', 'Chores & responsibility', 'Bedtime & routines', 'Honesty', 'Sharing & kindness', 'Schoolwork', 'Confidence'];

const json = S.json;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const now = () => new Date().toISOString();
const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
const enc = encodeURIComponent;
const str = (v, max) => String(v == null ? '' : v).slice(0, max);

function portalSecret() {
  if (process.env.PORTAL_SESSION_SECRET) return process.env.PORTAL_SESSION_SECRET;
  return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || '').update('nma-portal-session-v1').digest('hex');
}
const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function signPortal(email) {
  const iat = Math.floor(Date.now() / 1000), exp = iat + SESSION_DAYS * 86400;
  const payload = b64u(JSON.stringify({ p: 1, e: email, i: iat, x: exp }));
  return { token: payload + '.' + b64u(crypto.createHmac('sha256', portalSecret()).update(payload).digest()), exp };
}
function verifyPortal(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [payload, sig] = token.split('.');
  const want = b64u(crypto.createHmac('sha256', portalSecret()).update(payload).digest());
  const a = Buffer.from(sig || ''), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(unb64u(payload)); return p.p === 1 && p.e && p.x > Date.now() / 1000 ? p : null; } catch (e) { return null; }
}

function clientIp(event) {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || h['client-ip'] || '').trim().slice(0, 64);
}
async function rows(path) {
  const r = await S.supa('GET', '/rest/v1/' + path);
  if (!r.ok) throw new Error('Database error ' + r.status);
  return r.json();
}
async function write(method, path, body, prefer) {
  const r = await S.supa(method, '/rest/v1/' + path, body, prefer || 'return=minimal');
  if (!r.ok) throw new Error('Database error ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r;
}
async function log(evt, email, familyId, ip) {
  try { await write('POST', 'portal_log', { event: evt, email: email || null, family_id: familyId || null, ip: ip || null, at: now() }); } catch (e) { /* best effort */ }
}

// Guardian rows this session may use: enabled, and issued after any "sign out everywhere".
async function guardiansFor(email, iat) {
  const list = await rows('portal_guardians?email=eq.' + enc(email) + '&enabled=is.true&select=*');
  return list.filter(g => !g.revoked_after || new Date(g.revoked_after).getTime() / 1000 <= iat);
}

// ── Email (sign-in codes): Gmail via the CRM's stored connection, else Resend ──
async function sendEmail(to, subject, text, replyTo) {
  const rt = replyTo && validEmail(normEmail(replyTo)) ? normEmail(replyTo) : '';
  if (G.clientSecret()) {
    try {
      const sec = await G.getSecret();
      if (sec && sec.refresh_token) {
        const t = await G.tokenRequest({ refresh_token: sec.refresh_token, grant_type: 'refresh_token' });
        if (t.ok) {
          const subj = /[^\x00-\x7F]/.test(subject) ? '=?UTF-8?B?' + Buffer.from(subject).toString('base64') + '?=' : subject;
          const raw = ['From: "Noble\'s Martial Arts" <' + (sec.email || S.OWNER_EMAIL) + '>', 'To: ' + to, 'Subject: ' + subj].concat(rt ? ['Reply-To: ' + rt] : []).concat(['MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', text]).join('\r\n');
          const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST', headers: { Authorization: 'Bearer ' + t.data.access_token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw: b64u(Buffer.from(raw)) }),
          });
          if (r.ok) return true;
        }
      }
    } catch (e) { /* fall through */ }
  }
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RESEND_FROM, to: [to], subject, text, reply_to: rt || S.OWNER_EMAIL }),
    });
    if (r.ok) return true;
  }
  return false;
}

// ── Build what a guardian sees (their kids only) ──
function scopeView(view, guardian, pending) {
  const ids = Array.isArray(guardian.student_ids) && guardian.student_ids.length ? guardian.student_ids.map(String) : null;
  const allow = s => !ids || ids.includes(String(s.id));
  const students = (view.students || []).filter(allow).map(s => {
    const out = Object.assign({}, s);
    if (out.intent && out.intent.open && pending.some(p => String(p.student_id) === String(s.id) && String(p.event_id) === String(out.intent.eventId))) {
      out.intent = Object.assign({}, out.intent, { status: 'submitted' });
    }
    return out;
  });
  const visibleIds = new Set(students.map(s => String(s.id)));
  const items = ((view.balance && view.balance.items) || []).filter(i => !i.studentId || visibleIds.has(String(i.studentId)));
  return Object.assign({}, view, {
    students,
    balance: { items, total: Math.round(items.reduce((a, i) => a + (+i.amount || 0), 0) * 100) / 100 },
    // Only the signed-in guardian's own contact details — never another guardian's.
    guardians: (view.guardians || []).filter(g => g.email === guardian.email),
    you: { name: guardian.name || '', email: guardian.email },
  });
}

// Monthly RecDesk links live in the website's admin (nma_site_content), so read them fresh.
let _site = { at: 0, regUrls: {} };
async function siteRegUrls() {
  if (Date.now() - _site.at < 5 * 60e3) return _site.regUrls;
  try {
    const r = await rows('nma_site_content?id=eq.main&select=reg:data->regUrls');
    _site = { at: Date.now(), regUrls: (r[0] && r[0].reg) || {} };
  } catch (e) { _site.at = Date.now(); }
  return _site.regUrls;
}
const groupKey = g => String(g || '').toLowerCase().replace(/[^a-z]/g, '');

// What one guardian sees for each of their families, plus their own pending submissions.
async function familiesFor(gs) {
  const famIds = [...new Set(gs.map(g => g.family_id))];
  if (!famIds.length) return [];
  const list = famIds.map(enc).join(',');
  const views = await rows('portal_views?id=in.(' + list + ')&select=id,data,updated_at');
  const inbox = await rows('portal_inbox?family_id=in.(' + list + ')&kind=in.(intent,absence,contact,guardian,reg)&select=id,family_id,email,kind,student_id,event_id,payload,status,created_at&order=created_at.desc&limit=200');
  const reg = await siteRegUrls();
  const regBy = {}; Object.keys(reg || {}).forEach(k => { if (reg[k]) regBy[groupKey(k)] = reg[k]; });
  const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10); // Eastern-ish
  return gs.map(g => {
    const v = views.find(x => x.id === g.family_id); if (!v) return null;
    const mine = inbox.filter(i => i.family_id === g.family_id);
    const out = Object.assign(scopeView(v.data, g, mine.filter(i => i.kind === 'intent' && i.status === 'new')), { familyId: g.family_id, updatedAt: v.updated_at });
    out.students.forEach(s => {
      s.regLinkAll = regBy[groupKey(s.group)] || s.regLink || ''; // for the registration-deadline banner
      if (s.regEligible) s.regLink = s.regLinkAll; else s.regLink = '';
      const r = s.notRegistered && mine.find(i => i.kind === 'reg' && i.status === 'new' && String(i.student_id) === String(s.id) && (i.payload || {}).month === s.notRegistered.month);
      if (r) s.notRegistered = Object.assign({}, s.notRegistered, { pending: r.payload.choice });
    });
    const ids = new Set(out.students.map(s => String(s.id)));
    out.absences = mine.filter(i => i.kind === 'absence' && i.status !== 'dismissed' && ids.has(String(i.student_id)))
      .flatMap(i => (i.payload.dates || []).filter(d => d >= today).map(d => ({ studentId: i.student_id, first: i.payload.first || '', date: d, reason: i.payload.reason || '' })))
      .sort((a, b) => a.date.localeCompare(b.date));
    const pc = mine.find(i => i.kind === 'contact' && i.status === 'new' && i.email === g.email);
    out.contactPending = pc ? pc.payload.next : null;
    out.guardianPending = mine.filter(i => i.kind === 'guardian' && i.status === 'new').map(i => ({ name: i.payload.next.name, email: i.payload.next.email }));
    return out;
  }).filter(Boolean);
}

// ── Devices: alert the guardian by email the first time a new device signs in ──
function deviceLabel(ua) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'a device';
  const br = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? os + ' · ' + br : os;
}
async function noteDevice(email, device, event, ip, how) {
  try {
    const id = /^[A-Za-z0-9_-]{8,64}$/.test(String(device || '')) ? String(device) : 'unknown-' + sha(ip + (event.headers || {})['user-agent']).slice(0, 12);
    const gs = await rows('portal_guardians?email=eq.' + enc(email) + '&select=id,family_id,devices');
    const known = []; gs.forEach(g => (g.devices || []).forEach(d => { if (!known.some(k => k.id === d.id)) known.push(d); }));
    if (known.some(d => d.id === id)) return;
    const label = deviceLabel((event.headers || {})['user-agent']);
    const list = known.concat({ id, label, at: now() }).slice(-12);
    await write('PATCH', 'portal_guardians?email=eq.' + enc(email), { devices: list });
    await log('new_device', email, gs[0] && gs[0].family_id, ip);
    if (!known.length) return; // first device — that's them accepting the invite
    const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    await sendEmail(email, 'New sign-in to your Noble\'s Martial Arts family portal',
      'Hi there,\n\nYour Noble\'s Martial Arts family portal was just opened on a new device:\n\n    ' + label + '\n    ' + when + ' (Eastern)\n    Signed in with ' + how + '\n\nIf this was you, there\'s nothing to do.\n\nIf it wasn\'t you, reply to this email and Sensei Brandon will sign out every device and lock your access.\n\nNoble\'s Martial Arts');
  } catch (e) { /* never block a sign-in on the alert */ }
}

async function parentOps(op, body, event) {
  const ip = clientIp(event);

  if (op === 'request-code') {
    const email = normEmail(body.email);
    const generic = json(200, { ok: true, message: 'If that email has portal access, a code is on its way.' });
    if (!validEmail(email)) return json(400, { error: 'Please enter a valid email address.' });
    const recentIp = await rows('portal_log?event=eq.code_sent&ip=eq.' + enc(ip) + '&at=gt.' + enc(new Date(Date.now() - 3600e3).toISOString()) + '&select=id');
    if (recentIp.length >= 10) return json(429, { error: 'Too many requests. Try again in an hour.' });
    const gs = await rows('portal_guardians?email=eq.' + enc(email) + '&enabled=is.true&select=id,family_id');
    if (!gs.length) { await log('code_unknown_email', email, null, ip); return generic; }
    const cur = (await rows('portal_codes?id=eq.' + enc(email) + '&select=*'))[0];
    const sends = ((cur && cur.sends) || []).filter(t => Date.now() - new Date(t).getTime() < 15 * 60e3);
    if (sends.length >= 3) return json(429, { error: 'A few codes were already sent. Check your inbox (and spam), or try again in 15 minutes.' });
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await write('POST', 'portal_codes?on_conflict=id', { id: email, code_hash: sha(email + ':' + code), expires_at: new Date(Date.now() + CODE_MINUTES * 60e3).toISOString(), attempts: 0, sends: sends.concat(now()), paired: false }, 'resolution=merge-duplicates,return=minimal');
    const sent = await sendEmail(email, 'Your Noble\'s Martial Arts sign-in code: ' + code,
      'Hi there,\n\nYour sign-in code for the Noble\'s Martial Arts family portal is:\n\n    ' + code + '\n\nIt expires in ' + CODE_MINUTES + ' minutes. If you didn\'t ask for this, you can ignore this email.\n\nSensei Brandon\nNoble\'s Martial Arts');
    if (!sent) { await log('code_send_failed', email, gs[0].family_id, ip); return json(503, { error: 'email_unavailable', message: 'We couldn\'t send a code right now. Ask Sensei Brandon for a sign-in link.' }); }
    await log('code_sent', email, gs[0].family_id, ip);
    return generic;
  }

  if (op === 'verify-code') {
    const email = normEmail(body.email), code = String(body.code || '').replace(/\D/g, '');
    const cur = (await rows('portal_codes?id=eq.' + enc(email) + '&select=*'))[0];
    const bad = json(401, { error: 'That code isn\'t right or has expired.' });
    if (!cur || !cur.code_hash || new Date(cur.expires_at) < new Date()) return bad;
    if (cur.attempts >= 5) return json(429, { error: 'Too many tries. Request a new code.' });
    if (sha(email + ':' + code) !== cur.code_hash) {
      await write('PATCH', 'portal_codes?id=eq.' + enc(email), { attempts: cur.attempts + 1 });
      await log('code_wrong', email, null, ip);
      return bad;
    }
    await write('PATCH', 'portal_codes?id=eq.' + enc(email), { code_hash: null, attempts: 0, paired: false });
    const gs = await guardiansFor(email, Math.floor(Date.now() / 1000));
    if (!gs.length) return json(403, { error: 'This email doesn\'t have portal access.' });
    await log('signed_in_code', email, gs[0].family_id, ip);
    await noteDevice(email, body.device, event, ip, cur.paired ? 'a code from one of your other devices' : 'an emailed code');
    return json(200, signPortal(email));
  }

  if (op === 'redeem-link') {
    const raw = String(body.link || '');
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(raw)) return json(400, { error: 'This link isn\'t valid.' });
    const l = (await rows('portal_links?id=eq.' + sha(raw) + '&select=*'))[0];
    if (!l || new Date(l.expires_at) < new Date() || l.uses >= LINK_USES) return json(401, { error: 'expired', message: 'This sign-in link has expired. Enter your email to get a code instead.' });
    const gs = await guardiansFor(l.email, Math.floor(Date.now() / 1000));
    if (!gs.length) return json(403, { error: 'This email doesn\'t have portal access.' });
    await write('PATCH', 'portal_links?id=eq.' + l.id, { uses: l.uses + 1 });
    await log('signed_in_link', l.email, l.family_id, ip);
    await noteDevice(l.email, body.device, event, ip, 'your invite link');
    return json(200, Object.assign(signPortal(l.email), { email: l.email }));
  }

  // Everything below needs a portal session.
  const sess = verifyPortal(body.token);
  if (!sess) return json(401, { error: 'signed_out' });
  const gs = await guardiansFor(sess.e, sess.i);
  if (!gs.length) return json(401, { error: 'signed_out' });

  if (op === 'me') {
    const families = await familiesFor(gs);
    const last = gs[0].last_seen ? new Date(gs[0].last_seen).getTime() : 0;
    if (Date.now() - last > 3600e3) { // once an hour is plenty
      await write('PATCH', 'portal_guardians?email=eq.' + enc(sess.e), { last_seen: now() });
      await log('viewed', sess.e, gs[0].family_id, ip);
    }
    return json(200, { email: sess.e, families });
  }

  // Find a student this guardian may act for.
  async function scopedStudent(sid) {
    for (const g of gs) {
      const v = (await rows('portal_views?id=eq.' + enc(g.family_id) + '&select=data'))[0];
      if (!v) continue;
      const s = scopeView(v.data, g, []).students.find(x => String(x.id) === String(sid));
      if (s) return { g, s, view: v.data };
    }
    return null;
  }

  // A signed-in device can show a code for signing in on another device (no email needed).
  if (op === 'device-code') {
    const email = sess.e;
    const cur = (await rows('portal_codes?id=eq.' + enc(email) + '&select=*'))[0];
    const sends = ((cur && cur.sends) || []).filter(t => Date.now() - new Date(t).getTime() < 15 * 60e3);
    if (sends.length >= 5) return json(429, { error: 'Too many codes in a row. Try again in 15 minutes.' });
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    await write('POST', 'portal_codes?on_conflict=id', { id: email, code_hash: sha(email + ':' + code), expires_at: new Date(Date.now() + CODE_MINUTES * 60e3).toISOString(), attempts: 0, sends: sends.concat(now()), paired: true }, 'resolution=merge-duplicates,return=minimal');
    await log('device_code', email, gs[0].family_id, ip);
    return json(200, { code, email, minutes: CODE_MINUTES });
  }

  if (op === 'request-guardian') {
    const next = { name: str(body.name, 120).trim(), email: normEmail(str(body.email, 200)), phone: str(body.phone, 40).trim(), relationship: str(body.relationship, 60).trim() };
    if (!next.name) return json(400, { error: 'Please enter their name.' });
    if (!validEmail(next.email)) return json(400, { error: 'Please enter a valid email for them.' });
    if (next.email === sess.e) return json(400, { error: 'That\'s your email — use "Sign in on another device" instead.' });
    const g = gs[0];
    const v = (await rows('portal_views?id=eq.' + enc(g.family_id) + '&select=data'))[0];
    const mineKids = v ? scopeView(v.data, g, []).students.map(x => String(x.id)) : [];
    const kids = (Array.isArray(body.studentIds) ? body.studentIds : []).map(String).filter(x => mineKids.includes(x));
    next.studentIds = kids.length && kids.length < mineKids.length ? kids : null;
    await write('DELETE', 'portal_inbox?family_id=eq.' + enc(g.family_id) + '&kind=eq.guardian&status=eq.new&payload->next->>email=eq.' + enc(next.email));
    await write('POST', 'portal_inbox', { family_id: g.family_id, email: sess.e, kind: 'guardian', payload: { requestedBy: g.name || sess.e, next }, status: 'new', created_at: now() });
    await log('guardian_requested', sess.e, g.family_id, ip);
    return json(200, { ok: true });
  }

  // "Not on this month's roster" notice: parent says they already registered, or are taking the month off.
  if (op === 'submit-reg') {
    const r = await scopedStudent(body.studentId);
    if (!r || !r.s.notRegistered) return json(400, { error: 'Nothing to update for this student.' });
    const choice = body.choice === 'skip' ? 'skip' : 'registered';
    const month = r.s.notRegistered.month;
    await write('DELETE', 'portal_inbox?family_id=eq.' + enc(r.g.family_id) + '&kind=eq.reg&student_id=eq.' + enc(String(r.s.id)) + '&status=eq.new');
    await write('POST', 'portal_inbox', { family_id: r.g.family_id, email: sess.e, kind: 'reg', student_id: String(r.s.id), payload: { choice, month, note: str(body.note, 500).trim(), studentName: r.s.first + (r.s.last ? ' ' + r.s.last : '') }, status: 'new', created_at: now() });
    await log(choice === 'skip' ? 'month_off_reported' : 'registration_reported', sess.e, r.g.family_id, ip);
    return json(200, { ok: true });
  }

  // Questions for Sensei: emailed to Brandon with Reply-To the parent, and logged on the family's record.
  const TOPICS = { question: 'Question', scheduling: 'Scheduling', billing: 'Billing', private: 'Private lessons', other: 'Message' };
  if (op === 'send-message') {
    const topic = TOPICS[body.topic] ? body.topic : 'other';
    const msg = str(body.message, 3000).trim();
    if (msg.length < 3) return json(400, { error: 'Please write a message.' });
    const recent = await rows('portal_log?event=eq.message_sent&email=eq.' + enc(sess.e) + '&at=gt.' + enc(new Date(Date.now() - 3600e3).toISOString()) + '&select=id');
    if (recent.length >= 8) return json(429, { error: 'You\'ve sent several messages this hour — Sensei Brandon will get back to you soon.' });
    const g = gs[0];
    const v = (await rows('portal_views?id=eq.' + enc(g.family_id) + '&select=data'))[0];
    const sc = v ? scopeView(v.data, g, []) : { students: [], family: {} };
    const ids = (Array.isArray(body.studentIds) ? body.studentIds : []).map(String);
    const kids = sc.students.filter(x => ids.includes(String(x.id)));
    const famName = (sc.family && sc.family.name) || '';
    const about = kids.length ? kids.map(k => k.first + ' (' + k.group + ')').join(', ') : '';
    const subject = '[NMA Portal] ' + TOPICS[topic] + ' — ' + (famName ? famName + ' family' : sess.e) + (kids.length ? ' (' + kids.map(k => k.first).join(', ') + ')' : '');
    const text = msg + '\n\n————\nFrom: ' + (g.name || '') + ' <' + sess.e + '>' + (famName ? '\nFamily: ' + famName : '') + (about ? '\nAbout: ' + about : '') + '\nTopic: ' + TOPICS[topic] + '\n\nReply to this email to answer them directly.';
    const sent = await sendEmail(S.OWNER_EMAIL, subject, text, sess.e);
    await write('POST', 'portal_inbox', { family_id: g.family_id, email: sess.e, kind: 'message', payload: { topic: TOPICS[topic], message: msg, studentIds: kids.map(k => String(k.id)), name: g.name || '', emailed: sent }, status: 'new', created_at: now() });
    await log('message_sent', sess.e, g.family_id, ip);
    return json(200, { ok: true });
  }

  // General feedback, optionally without the parent's name attached.
  if (op === 'send-feedback') {
    const msg = str(body.message, 3000).trim();
    if (msg.length < 3) return json(400, { error: 'Please write your feedback.' });
    const anon = body.anonymous === true;
    const recent = await rows('portal_codes?id=eq.' + enc('fb:' + sess.e) + '&select=sends');
    const sends = ((recent[0] && recent[0].sends) || []).filter(t => Date.now() - new Date(t).getTime() < 3600e3);
    if (sends.length >= 5) return json(429, { error: 'Thanks for all the feedback! Please try again in a bit.' });
    await write('POST', 'portal_codes?on_conflict=id', { id: 'fb:' + sess.e, sends: sends.concat(now()) }, 'resolution=merge-duplicates,return=minimal');
    const g = gs[0];
    let groups = [];
    if (!anon) { const v = (await rows('portal_views?id=eq.' + enc(g.family_id) + '&select=data'))[0]; groups = v ? [...new Set(scopeView(v.data, g, []).students.map(x => x.group))] : []; }
    // Anonymous feedback keeps no family, email or log entry tied to the parent.
    await write('POST', 'portal_inbox', { family_id: anon ? 'anonymous' : g.family_id, email: anon ? null : sess.e, kind: 'feedback', payload: { message: msg, anonymous: anon, name: anon ? '' : (g.name || ''), groups }, status: 'new', created_at: now() });
    await sendEmail(S.OWNER_EMAIL, '[NMA Portal] New ' + (anon ? 'anonymous ' : '') + 'feedback', msg + '\n\n————\n' + (anon ? 'Sent anonymously from the family portal.' : 'From: ' + (g.name || '') + ' <' + sess.e + '>'), anon ? '' : sess.e);
    await log('feedback_sent', anon ? null : sess.e, anon ? null : g.family_id, anon ? null : ip);
    return json(200, { ok: true });
  }

  if (op === 'submit-absence') {
    const sids = (Array.isArray(body.studentIds) ? body.studentIds : []).map(String).slice(0, 10);
    const today = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
    const limit = new Date(Date.now() + 180 * 86400e3).toISOString().slice(0, 10);
    const dates = [...new Set((Array.isArray(body.dates) ? body.dates : []).map(String))].filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today && d <= limit).sort().slice(0, 12);
    if (!sids.length) return json(400, { error: 'Choose which student will be out.' });
    if (!dates.length) return json(400, { error: 'Choose at least one class date.' });
    const reason = str(body.reason, 500).trim();
    const found = [];
    for (const sid of sids) { const r = await scopedStudent(sid); if (!r) return json(400, { error: 'Student not found.' }); found.push(r); }
    for (const r of found) {
      await write('POST', 'portal_inbox', { family_id: r.g.family_id, email: sess.e, kind: 'absence', student_id: String(r.s.id), payload: { dates, reason, first: r.s.first, studentName: r.s.first + (r.s.last ? ' ' + r.s.last : ''), parentName: r.g.name || '', parentEmail: sess.e }, status: 'new', created_at: now() });
    }
    await log('absence_reported', sess.e, found[0].g.family_id, ip);
    return json(200, { ok: true });
  }

  if (op === 'submit-contact') {
    const next = { name: str(body.name, 120).trim(), email: normEmail(str(body.email, 200)), phone: str(body.phone, 40).trim() };
    if (!next.name) return json(400, { error: 'Please enter your name.' });
    if (!validEmail(next.email)) return json(400, { error: 'Please enter a valid email.' });
    const g = gs[0];
    await write('DELETE', 'portal_inbox?family_id=eq.' + enc(g.family_id) + '&kind=eq.contact&email=eq.' + enc(sess.e) + '&status=eq.new');
    await write('POST', 'portal_inbox', { family_id: g.family_id, email: sess.e, kind: 'contact', payload: { guardianId: g.id, contactId: String(g.id).split(':')[1] || '', next }, status: 'new', created_at: now() });
    await log('contact_update_requested', sess.e, g.family_id, ip);
    return json(200, { ok: true });
  }

  if (op === 'submit-intent') {
    const sid = String(body.studentId || ''), evId = String(body.eventId || '');
    let fam = null, student = null;
    for (const g of gs) {
      const v = (await rows('portal_views?id=eq.' + enc(g.family_id) + '&select=data'))[0];
      if (!v) continue;
      const sc = scopeView(v.data, g, []);
      const s = sc.students.find(x => String(x.id) === sid);
      if (s) { fam = g; student = s; break; }
    }
    if (!student || !student.intent || !student.intent.open || String(student.intent.eventId) !== evId) return json(400, { error: 'This letter isn\'t open right now.' });
    const kind = student.intent.kind === 'bb' ? 'bb' : 'standard';
    const answers = {};
    if (kind === 'standard') {
      for (const k of PF_KEYS) {
        const v = body.answers && body.answers[k];
        if (v !== 'yes' && v !== 'no') return json(400, { error: 'Please answer every question.' });
        answers[k] = v;
      }
    } else if (body.affirm !== true || !str(body.signedBy, 100).trim() || !str(body.studentSigned, 100).trim()) {
      return json(400, { error: 'Please check the affirmation and type both names.' });
    }
    if (!str(body.signedBy, 100).trim()) return json(400, { error: 'Please type your name to sign.' });
    const payload = {
      kind, answers,
      note: str(body.note, 2000).trim(),
      focus: (Array.isArray(body.focus) ? body.focus : []).filter(t => PF_THEMES.includes(t)).slice(0, 13),
      programFeedback: str(body.programFeedback, 1000).trim(),
      signedBy: str(body.signedBy, 100).trim(),
      studentSigned: kind === 'bb' ? str(body.studentSigned, 100).trim() : '',
      affirm: kind === 'bb' ? true : undefined,
      studentName: student.first + (student.last ? ' ' + student.last : ''),
      eventName: student.intent.eventName, eventDate: student.intent.eventDate, promotingTo: student.intent.promotingTo,
    };
    // One open submission per child per test — resubmitting replaces it.
    await write('DELETE', 'portal_inbox?family_id=eq.' + enc(fam.family_id) + '&kind=eq.intent&student_id=eq.' + enc(sid) + '&event_id=eq.' + enc(evId) + '&status=eq.new');
    await write('POST', 'portal_inbox', { family_id: fam.family_id, email: sess.e, kind: 'intent', student_id: sid, event_id: evId, payload, status: 'new', created_at: now() });
    await log('intent_submitted', sess.e, fam.family_id, ip);
    return json(200, { ok: true });
  }

  return json(400, { error: 'Unknown request' });
}

function longDate(iso) { return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }); }
async function sendIntentNotice(n) {
  const gs = (await rows('portal_guardians?family_id=eq.' + enc(n.familyId) + '&enabled=is.true&select=email,student_ids'))
    .filter(g => !Array.isArray(g.student_ids) || !g.student_ids.length || g.student_ids.map(String).includes(String(n.student.id)));
  if (!gs.length) return 0;
  const s = n.student, it = n.intent;
  const bb = it.kind === 'bb';
  const text = 'Hi there,\n\n' +
    (bb ? 'Congratulations! ' + s.first + ' has been selected as a Black Belt Candidate for the Black Belt Test on ' + longDate(it.eventDate) + '!'
        : 'Congratulations! ' + s.first + ' is testing for ' + it.promotingTo + ' on ' + longDate(it.eventDate) + '.') + '\n\n' +
    'Two quick steps in your family portal:\n' +
    '  1. Fill out ' + s.first + '\'s ' + (bb ? 'Black Belt Intent to Promote letter' : 'Intent to Promote letter') + ' (about 2 minutes)\n' +
    (it.fee && !it.feePaid ? '  2. Pay the $' + it.fee + ' belt testing fee — Venmo preferred, the button fills everything in\n' : '') +
    '\n' + PORTAL_URL + '\n\nPlease finish by ' + s.first + '\'s belt test class. Any questions — just reply here.\n\nSensei Brandon\nNoble\'s Martial Arts';
  let sent = 0;
  for (const g of gs) {
    if (await sendEmail(g.email, s.first + '\'s Intent to Promote letter is ready', text)) { sent++; await log('notified_intent', g.email, n.familyId, null); }
  }
  return sent;
}

async function staffOps(op, body, user) {
  if (op === 'staff-publish') {
    const guardians = Array.isArray(body.guardians) ? body.guardians : [];
    const views = Array.isArray(body.views) ? body.views : [];
    const familyIds = new Set((Array.isArray(body.familyIds) ? body.familyIds : []).map(String));
    const clean = guardians.filter(g => g && g.id && validEmail(normEmail(g.email)) && g.familyId).map(g => ({
      id: str(g.id, 120), email: normEmail(g.email), family_id: str(g.familyId, 80), name: str(g.name, 120),
      student_ids: Array.isArray(g.studentIds) && g.studentIds.length ? g.studentIds.map(String) : null,
      enabled: g.enabled !== false, updated_at: now(),
    }));
    if (clean.length) await write('POST', 'portal_guardians?on_conflict=id', clean, 'resolution=merge-duplicates,return=minimal');
    // Guard against a half-loaded CRM wiping everyone's access.
    if (!clean.length && body.confirmEmpty !== true) return json(400, { error: 'empty_publish' });
    const keep = new Set(clean.map(g => g.id));
    const existing = await rows('portal_guardians?select=id,family_id');
    const drop = existing.filter(g => !keep.has(g.id)).map(g => g.id);
    if (drop.length) await write('DELETE', 'portal_guardians?id=in.(' + drop.map(enc).join(',') + ')');
    const vs = views.filter(v => v && v.id && v.data && familyIds.has(String(v.id))).map(v => ({ id: str(v.id, 80), data: v.data, updated_at: now() }));
    // Emails for things that just became available (e.g. an Intent letter opened).
    const notices = [];
    if (vs.length) {
      const prev = await rows('portal_views?id=in.(' + vs.map(v => enc(v.id)).join(',') + ')&select=id,notified');
      for (const v of vs) {
        const old = prev.find(x => x.id === v.id);
        const notified = Object.assign({}, (old && old.notified) || {});
        for (const st of (v.data.students || [])) {
          const it = st.intent;
          if (!it || !it.open) continue;
          const key = 'intent:' + st.id + ':' + it.eventId;
          if (notified[key]) continue;
          notified[key] = now();
          // First publish for a family: their invite covers what's already open.
          if (old && body.notify && body.notify.letters) notices.push({ familyId: v.id, student: st, intent: it });
        }
        v.notified = notified;
      }
      await write('POST', 'portal_views?on_conflict=id', vs, 'resolution=merge-duplicates,return=minimal');
    }
    let sentNotices = 0;
    for (const n of notices) sentNotices += await sendIntentNotice(n);
    const ev = await rows('portal_views?select=id');
    const dropV = ev.filter(v => !familyIds.has(v.id)).map(v => v.id);
    if (dropV.length) await write('DELETE', 'portal_views?id=in.(' + dropV.map(enc).join(',') + ')');
    return json(200, { ok: true, guardians: clean.length, views: vs.length, removed: drop.length + dropV.length, notices: sentNotices });
  }

  if (op === 'staff-link') {
    const id = str(body.familyId, 80) + ':' + str(body.contactId, 80);
    const g = (await rows('portal_guardians?id=eq.' + enc(id) + '&select=*'))[0];
    if (!g || !g.enabled) return json(400, { error: 'Turn on portal access for this guardian first (and let it sync).' });
    const raw = b64u(crypto.randomBytes(24));
    await write('POST', 'portal_links', { id: sha(raw), email: g.email, family_id: g.family_id, expires_at: new Date(Date.now() + LINK_DAYS * 86400e3).toISOString(), uses: 0, created_at: now() });
    await write('PATCH', 'portal_guardians?id=eq.' + enc(id), { invited_at: now() });
    await log('invite_link', g.email, g.family_id, user.email);
    return json(200, { url: PORTAL_URL + '#link=' + raw, email: g.email, expiresDays: LINK_DAYS });
  }

  if (op === 'staff-revoke') {
    const fid = str(body.familyId, 80);
    await write('PATCH', 'portal_guardians?family_id=eq.' + enc(fid), { revoked_after: now() });
    await write('DELETE', 'portal_links?family_id=eq.' + enc(fid));
    await log('signed_out_everywhere', null, fid, user.email);
    return json(200, { ok: true });
  }

  if (op === 'staff-inbox') {
    const st = ['new', 'accepted', 'dismissed'].includes(body.status) ? body.status : 'new';
    return json(200, { items: await rows('portal_inbox?status=eq.' + st + '&order=created_at.desc&limit=200&select=*') });
  }

  // Exactly what a guardian of this family would see (all kids unless a contact is given).
  if (op === 'staff-preview') {
    const fid = str(body.familyId, 80);
    const gid = body.contactId ? fid + ':' + str(body.contactId, 80) : null;
    const gr = gid ? (await rows('portal_guardians?id=eq.' + enc(gid) + '&select=*'))[0] : null;
    const g = gr || { id: fid + ':preview', email: '', name: '', family_id: fid, student_ids: null };
    return json(200, { email: g.email || 'preview', families: await familiesFor([g]), preview: true });
  }

  if (op === 'staff-inbox-mark') {
    const st = ['accepted', 'dismissed', 'new'].includes(body.status) ? body.status : null;
    const id = parseInt(body.id, 10);
    if (!st || !id) return json(400, { error: 'bad_request' });
    await write('PATCH', 'portal_inbox?id=eq.' + id, { status: st, handled_at: st === 'new' ? null : now() });
    return json(200, { ok: true });
  }

  if (op === 'staff-activity') {
    const f = body.familyId ? '&family_id=eq.' + enc(str(body.familyId, 80)) : '';
    const g = await rows('portal_guardians?select=id,email,family_id,enabled,invited_at,last_seen,revoked_after,devices' + f);
    const l = await rows('portal_log?select=at,email,family_id,event&order=at.desc&limit=60' + f);
    return json(200, { guardians: g, log: l });
  }

  return json(400, { error: 'Unknown request' });
}

// Daily registration reminder (called by portal-reminders, a scheduled function):
// 3 days before RecDesk closes, email each portal family once with their kids' links.
async function sendRegReminders(today) {
  const views = await rows('portal_views?select=id,data,notified');
  const reg = await siteRegUrls();
  const regBy = {}; Object.keys(reg || {}).forEach(k => { if (reg[k]) regBy[groupKey(k)] = reg[k]; });
  let sent = 0;
  for (const v of views) {
    const sc = (v.data && v.data.school) || {}; const r = sc.regDeadline;
    if (!r || !r.deadline || sc.regReminder === false) continue;
    const days = Math.round((Date.parse(r.deadline + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 86400e3);
    if (days < 0 || days > 3) continue;
    const key = 'regremind:' + r.deadline;
    if ((v.notified || {})[key]) continue;
    const gs = await rows('portal_guardians?family_id=eq.' + enc(v.id) + '&enabled=is.true&select=email,student_ids');
    let any = 0;
    for (const g of gs) {
      const ids = Array.isArray(g.student_ids) && g.student_ids.length ? g.student_ids.map(String) : null;
      const kids = (v.data.students || []).filter(s => !ids || ids.includes(String(s.id)));
      if (!kids.length) continue;
      const lines = kids.map(s => '  • ' + s.first + ' (' + s.group + '): ' + (regBy[groupKey(s.group)] || 'noblesmartialarts.com/family')).join('\n');
      const text = 'Hi there,\n\nQuick reminder: registration for ' + r.month + ' classes closes ' + longDate(r.deadline) + ' at 11:59 PM' + (days === 0 ? ' — that\'s tonight' : '') + '.\n\n' +
        'Register through the Town\'s RecDesk site:\n' + lines + '\n\n' +
        'Already registered? Thank you — you can ignore this. Taking ' + r.month + ' off? Just reply and let me know.\n\n' +
        'Your family portal: ' + PORTAL_URL + '\n\nSensei Brandon\nNoble\'s Martial Arts';
      if (await sendEmail(g.email, r.month + ' registration closes ' + longDate(r.deadline).replace(/^\w+, /, ''), text)) { any++; sent++; await log('notified_reg_reminder', g.email, v.id, null); }
    }
    if (any || !gs.length) await write('PATCH', 'portal_views?id=eq.' + enc(v.id), { notified: Object.assign({}, v.notified || {}, { [key]: now() }) });
  }
  return sent;
}
module.exports.sendRegReminders = sendRegReminders;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (!S.configured()) return json(503, { error: 'not_configured' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_json' }); }
  const op = String(body.op || '');
  try {
    if (op.startsWith('staff-')) {
      const user = await S.requireUser(event);
      if (user.error) return user.error;
      return await staffOps(op, body, user);
    }
    return await parentOps(op, body, event);
  } catch (e) {
    return json(500, { error: 'server_error', message: e.message });
  }
};
