// Electronic workshop waivers.
//
// Public (no sign-in, gated by the workshop's unguessable link token):
//   info  — workshop details + the current agreement texts to display
//   sign  — validates and records one participant's signed agreement,
//           stores a PDF copy, emails the signer a copy, returns the PDF
// Staff (CRM sign-in required; anything sensitive is owner-only):
//   link, rotate, summary, detail*, pdf*, paper, resolve, media_withdraw, purge_notes*
//   (* owner only — date of birth, health notes, signing metadata, PDFs)
//
// Legal texts come from public.legal_documents and are never edited here;
// signed records are append-only (enforced by database triggers).
const crypto = require('crypto');
const S = require('../lib/session');
const { Doc } = require('../lib/pdf');
const { sendEmail, validEmail } = require('../lib/mailer');

const BUCKET = 'workshop-waivers';
const TZ = 'America/New_York';

// The signing page is also served at noblesmartialarts.com/waiver and calls this
// function directly (not through a proxy) so each signer's real IP is recorded.
const PUBLIC_ORIGINS = ['https://noblesmartialarts.com', 'https://www.noblesmartialarts.com'];
function corsFor(event) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || '';
  if (!PUBLIC_ORIGINS.includes(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' };
}
exports.handler = async (event) => {
  const res = await route(event);
  // Cross-site callers may only use the public signing operations.
  const cors = corsFor(event);
  if (Object.keys(cors).length) res.headers = Object.assign({}, res.headers, cors);
  return res;
};
async function route(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Cache-Control': 'no-store' }, body: '' };
  if (event.httpMethod !== 'POST') return S.json(405, { error: 'method_not_allowed' });
  if (!S.configured()) return S.json(503, { error: 'not_configured', message: 'Waivers are not set up on the server yet.' });
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return S.json(400, { error: 'bad_json' }); }
  const op = String(body.op || '');
  try {
    if (op === 'info') return await opInfo(body, event);
    if (op === 'sign') return await opSign(body, event);
    if (Object.keys(corsFor(event)).length) return S.json(403, { error: 'forbidden' });
    const auth = await S.requireUser(event);
    if (auth.error) return auth.error;
    const actor = auth.email, owner = actor === S.OWNER_EMAIL;
    const ownerOnly = () => S.json(403, { error: 'owner_only', message: 'Only the account owner can view this.' });
    if (op === 'link') return await opLink(body, actor, false);
    if (op === 'rotate') return await opLink(body, actor, true);
    if (op === 'summary') return await opSummary(body);
    if (op === 'paper') return await opPaper(body, actor);
    if (op === 'resolve') return await opResolve(body, actor);
    if (op === 'media_withdraw') return await opMediaWithdraw(body, actor);
    if (op === 'detail') return owner ? await opDetail(body, actor) : ownerOnly();
    if (op === 'pdf') return owner ? await opPdf(body, actor) : ownerOnly();
    if (op === 'purge_notes') return owner ? await opPurgeNotes(body, actor) : ownerOnly();
    return S.json(400, { error: 'unknown_op' });
  } catch (e) {
    console.error('waiver.js', op, e && e.stack || e);
    return S.json(500, { error: 'server_error', message: 'Something went wrong on our end. Please try again.' });
  }
}

// ── helpers ──
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, n);
const normName = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const shortId = id => 'WS-' + String(id || '').replace(/-/g, '').slice(0, 8).toUpperCase();
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
function clientIp(event) {
  const h = event.headers || {};
  return String(h['x-nf-client-connection-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || h['client-ip'] || '').trim().slice(0, 64);
}
function ua(event) { const h = event.headers || {}; return clip(h['user-agent'] || h['User-Agent'] || '', 300); }
async function q(method, path, body, prefer) {
  const r = await S.supa(method, path, body, prefer);
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!r.ok) { const err = new Error('DB ' + method + ' ' + path.split('?')[0] + ' ' + r.status + ': ' + text.slice(0, 300)); err.status = r.status; throw err; }
  return data;
}
async function audit(event, fields) {
  try {
    await q('POST', '/rest/v1/waiver_audit', Object.assign({
      ip: event ? clientIp(event) : null, user_agent: event ? ua(event) : null, detail: {},
    }, fields), 'return=minimal');
  } catch (e) { console.error('audit failed', e.message); }
}
function publicTitle(w) {
  if (w.public_title) return w.public_title;
  if (/mother|women/i.test(w.type || '')) return "Women's Self-Defense Workshop";
  return (w.organization ? w.organization + ' — ' : '') + 'Self-Defense Workshop';
}
function fmtDate(d) {
  if (!d) return 'To be announced';
  const [y, m, dd] = String(d).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
function fmtTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); if (!m) return '';
  let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return h + ':' + m[2] + ' ' + ap;
}
function snapshotOf(w) {
  return {
    workshop_id: w.id, workshop_ref: shortId(w.id), name: publicTitle(w),
    date: w.session_date || null, time: w.session_time || null,
    date_display: fmtDate(w.session_date) + (w.session_time ? ' at ' + fmtTime(w.session_time) : ''),
    location: w.location || 'To be announced',
  };
}
function eastern(iso) {
  return new Date(iso).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'long', timeStyle: 'long' });
}
function ageOn(dob, onDate) {
  const [y, m, d] = dob.split('-').map(Number);
  const [oy, om, od] = onDate.split('-').map(Number);
  let a = oy - y; if (om < m || (om === m && od < d)) a--; return a;
}
function todayEastern() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p; // YYYY-MM-DD
}
function addYears(isoDate, n) { const [y, m, d] = isoDate.split('-').map(Number); return String(y + n).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(Math.min(d, 28)).padStart(2, '0'); }
async function workshopByToken(token) {
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(String(token || ''))) return null;
  const rows = await q('GET', '/rest/v1/workshop_leads?waiver_token=eq.' + encodeURIComponent(token) + '&select=id,organization,type,status,public_title,session_date,session_time,location&limit=1');
  const w = rows && rows[0];
  if (!w || w.status === 'Declined') return null;
  return w;
}
async function currentDocs() {
  const rows = await q('GET', '/rest/v1/legal_documents?is_current=eq.true&select=id,kind,version_label,title,body,body_sha256,status');
  const out = {}; (rows || []).forEach(r => { out[r.kind] = r; });
  return out;
}

// ── public: info ──
async function opInfo(body, event) {
  const w = await workshopByToken(body.token);
  if (!w) return S.json(404, { error: 'not_found', message: 'This waiver link is not valid. Please ask the workshop organizer for the current link.' });
  const docs = await currentDocs();
  if (!docs.workshop_waiver || !docs.media_consent) return S.json(503, { error: 'not_ready', message: 'The waiver is not available yet.' });
  await audit(event, { event: 'link_opened', workshop_id: w.id });
  const pick = d => ({ id: d.id, version: d.version_label, title: d.title, body: d.body, sha256: d.body_sha256, status: d.status });
  return S.json(200, { workshop: snapshotOf(w), waiver: pick(docs.workshop_waiver), media: pick(docs.media_consent) });
}

// ── public: sign ──
async function opSign(body, event) {
  if (body.website) return S.json(200, { ok: true }); // honeypot: bots fill hidden fields
  const ip = clientIp(event);
  if (ip) {
    const since = new Date(Date.now() - 3600e3).toISOString();
    const recent = await q('GET', '/rest/v1/waiver_audit?select=id&event=eq.signed&ip=eq.' + encodeURIComponent(ip) + '&at=gte.' + encodeURIComponent(since) + '&limit=31');
    if ((recent || []).length >= 30) return S.json(429, { error: 'rate_limited', message: 'Too many waivers from this connection in the last hour. Please try again later.' });
  }
  const w = await workshopByToken(body.token);
  if (!w) return S.json(404, { error: 'not_found', message: 'This waiver link is not valid. Please ask the workshop organizer for the current link.' });
  const docs = await currentDocs();
  const wd = docs.workshop_waiver, md = docs.media_consent;
  if (!wd || !md) return S.json(503, { error: 'not_ready', message: 'The waiver is not available yet.' });
  if (body.waiver_doc_id !== wd.id || body.waiver_sha256 !== wd.body_sha256 || body.media_doc_id !== md.id || body.media_sha256 !== md.body_sha256) {
    return S.json(409, { error: 'version_changed', message: 'The agreement was updated while this page was open. Please reload the page, review the current version, and sign again.' });
  }

  // Validate input
  const errs = [];
  const p = body.participant || {}, sg = body.signer || {}, em = body.emergency || {}, ack = body.ack || {}, media = body.media || {};
  const legalName = clip(p.legal_name, 120);
  const dob = clip(p.dob, 10);
  if (legalName.split(' ').filter(Boolean).length < 2) errs.push("Enter the participant's full legal name (first and last).");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || isNaN(Date.parse(dob + 'T00:00:00Z'))) errs.push("Enter the participant's date of birth.");
  const today = todayEastern();
  const onDate = w.session_date && w.session_date > today ? w.session_date : today;
  let age = null, minor = false;
  if (!errs.length) {
    if (dob >= today) errs.push('Date of birth must be in the past.');
    age = ageOn(dob, onDate);
    if (age > 110) errs.push('Please check the date of birth.');
    if (age < 3) errs.push('Please check the date of birth.');
    minor = age < 18;
  }
  const signerName = minor ? clip(sg.legal_name, 120) : legalName;
  const relationship = minor ? clip(sg.relationship, 40) : '';
  const signerEmail = clip(sg.email, 160).toLowerCase();
  const signerPhone = clip(sg.phone, 40);
  if (minor) {
    if (signerName.split(' ').filter(Boolean).length < 2) errs.push("Enter the parent or legal guardian's full legal name.");
    if (!['Parent', 'Legal Guardian'].includes(relationship)) errs.push('Select your relationship to the minor (parent or legal guardian).');
    if (normName(signerName) === normName(legalName)) errs.push('A minor cannot sign for themselves — a parent or legal guardian must sign.');
    if (!signerPhone || signerPhone.replace(/\D/g, '').length < 10) errs.push("Enter the parent or guardian's phone number.");
    if (!validEmail(signerEmail)) errs.push("Enter the parent or guardian's email address.");
    if (ack.guardian !== true) errs.push('Confirm that you are the parent or legal guardian of the minor participant.');
  } else if (!errs.length) {
    if (!validEmail(signerEmail) && signerPhone.replace(/\D/g, '').length < 10) errs.push('Enter an email address or phone number.');
  }
  if (signerEmail && !validEmail(signerEmail)) errs.push('Check the email address.');
  const emName = clip(em.name, 120), emPhone = clip(em.phone, 40);
  if (!emName) errs.push('Enter an emergency contact name.');
  if (!emPhone || emPhone.replace(/\D/g, '').length < 10) errs.push('Enter an emergency contact phone number.');
  const notes = clip(body.medical_notes, 1000) || null;
  if (ack.read !== true) errs.push('Confirm that you have read the full agreement.');
  if (ack.liability !== true) errs.push('Acknowledge the assumption of risk and release of liability terms.');
  if (ack.electronic !== true) errs.push('Agree to sign electronically.');
  const signature = clip(body.signature, 120);
  if (!signature || normName(signature) !== normName(signerName)) errs.push('Type your full legal name exactly as entered above to sign' + (minor ? ' (the parent or guardian’s name).' : '.'));
  const mediaChoice = media.consent === 'Yes' ? 'Yes' : media.consent === 'No' ? 'No' : null;
  if (!mediaChoice) errs.push('Choose YES or NO for photography and video consent.');
  const mediaSig = clip(media.signature, 120);
  if (mediaChoice === 'Yes' && normName(mediaSig) !== normName(signerName)) errs.push('Type your full legal name to sign the photography and video consent.');
  if (errs.length) return S.json(422, { error: 'invalid', messages: errs });

  const signedAt = new Date().toISOString();
  const snap = snapshotOf(w);

  // Match to an existing roster entry for this workshop, or add one.
  const roster = await q('GET', '/rest/v1/workshop_participants?workshop_id=eq.' + w.id + '&select=id,full_name,role,paired_with,email,phone,current_waiver_id');
  const same = (roster || []).filter(r => normName(r.full_name) === normName(legalName));
  let participant = null, attention = null, prior = null;
  if (same.length === 1) {
    participant = same[0];
    if (participant.current_waiver_id) {
      const pw = await q('GET', '/rest/v1/workshop_waivers?id=eq.' + participant.current_waiver_id + '&select=id,participant_dob');
      prior = pw && pw[0];
      if (prior && prior.participant_dob !== dob) { participant = null; prior = null; attention = 'Same name as another participant on this roster but a different date of birth — check whether these are two people.'; }
    }
  } else if (same.length > 1) {
    attention = 'Name matches more than one roster entry — merge or remove duplicates.';
  }
  if (!participant) {
    const ins = await q('POST', '/rest/v1/workshop_participants', {
      workshop_id: w.id, full_name: legalName, role: minor ? 'Teen' : 'Adult', waiver_status: 'Pending',
    }, 'return=representation');
    participant = ins[0];
  }

  const retain = minor ? [addYears(signedAt.slice(0, 10), 4), addYears(dob, 22)].sort().pop() : addYears(signedAt.slice(0, 10), 4);
  const rec = {
    workshop_id: w.id, participant_id: participant.id,
    waiver_doc_id: wd.id, waiver_doc_sha256: wd.body_sha256, media_doc_id: md.id, media_doc_sha256: md.body_sha256,
    workshop_snapshot: snap,
    participant_legal_name: legalName, participant_dob: dob, participant_type: minor ? 'Minor' : 'Adult', age_at_workshop: age,
    signer_legal_name: signerName, signer_role: minor ? 'Parent/Legal Guardian' : 'Participant', signer_relationship: relationship || null,
    signer_email: signerEmail || null, signer_phone: signerPhone || null,
    emergency_contact_name: emName, emergency_contact_phone: emPhone, medical_notes: notes,
    ack_read: true, ack_liability: true, ack_electronic: true, ack_guardian: minor ? true : null,
    signature_text: signature,
    media_consent: mediaChoice, media_signer_name: signerName, media_signer_role: minor ? 'Parent/Legal Guardian' : 'Adult Participant',
    media_signature_text: mediaChoice === 'Yes' ? mediaSig : (mediaSig || null),
    signed_at: signedAt, signer_ip: ip || null, signer_user_agent: ua(event) || null, retain_until: retain,
  };
  const saved = (await q('POST', '/rest/v1/workshop_waivers', rec, 'return=representation'))[0];
  if (prior) await q('PATCH', '/rest/v1/workshop_waivers?id=eq.' + prior.id, { superseded_by: saved.id }, 'return=minimal');

  const pPatch = {
    full_name: participant.full_name || legalName,
    age, age_category: minor ? 'Minor' : 'Adult',
    role: minor ? (participant.role === 'Parent/Guardian' || participant.role === 'Adult' ? 'Teen' : (participant.role || 'Teen')) : (participant.role === 'Teen' ? 'Adult' : (participant.role || 'Adult')),
    emergency_contact: emName + ' — ' + emPhone,
    waiver_signed: !attention, waiver_status: attention ? 'Needs Attention' : 'Signed', waiver_signed_at: signedAt,
    current_waiver_id: saved.id, media_consent: mediaChoice, paper_waiver: false, attention_reason: attention,
    updated_at: signedAt,
  };
  if (minor && !participant.paired_with) pPatch.paired_with = signerName;
  if (!participant.email && signerEmail) pPatch.email = signerEmail;
  if (!participant.phone && signerPhone) pPatch.phone = signerPhone;
  await q('PATCH', '/rest/v1/workshop_participants?id=eq.' + participant.id, pPatch, 'return=minimal');
  await audit(event, { event: 'signed', workshop_id: w.id, participant_id: participant.id, waiver_id: saved.id, actor: 'signer:' + signerName,
    detail: { waiver_doc: wd.id, media_doc: md.id, media: mediaChoice, type: rec.participant_type, superseded: prior ? prior.id : null, attention } });

  // PDF copy → private storage
  let pdf = null;
  try {
    pdf = buildPdf(saved, wd, md);
    const path = w.id + '/' + participant.id + '/' + saved.id + '.pdf';
    const up = await fetch(S.SUPA_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/pdf', 'x-upsert': 'false' },
      body: pdf,
    });
    if (!up.ok) throw new Error('upload ' + up.status + ' ' + (await up.text()).slice(0, 200));
    await q('PATCH', '/rest/v1/workshop_waivers?id=eq.' + saved.id, { pdf_path: path, pdf_sha256: sha256(pdf) }, 'return=minimal');
    await audit(event, { event: 'pdf_stored', workshop_id: w.id, participant_id: participant.id, waiver_id: saved.id, detail: { bytes: pdf.length } });
  } catch (e) {
    console.error('waiver pdf', e.message);
    await audit(event, { event: 'pdf_failed', workshop_id: w.id, participant_id: participant.id, waiver_id: saved.id, detail: { error: e.message.slice(0, 300) } });
    if (!attention) await q('PATCH', '/rest/v1/workshop_participants?id=eq.' + participant.id, { attention_reason: 'Signed, but the PDF copy could not be saved — open the waiver record.' }, 'return=minimal').catch(() => {});
  }

  // Email the signer a copy
  let emailed = false;
  if (pdf && signerEmail) {
    const text = [
      'Hi ' + signerName.split(' ')[0] + ',',
      '',
      'Thank you for completing the workshop agreement for ' + legalName + '.',
      '',
      'Workshop: ' + snap.name,
      'Date: ' + snap.date_display,
      'Location: ' + snap.location,
      'Photography/video consent: ' + (mediaChoice === 'Yes' ? 'YES' : 'NO'),
      '',
      'A read-only copy of the signed agreement is attached for your records.',
      'To withdraw photography/video consent for future use, or if anything looks wrong, just reply to this email.',
      '',
      "Noble's Martial Arts",
      'noblesmartialarts.com',
    ].join('\n');
    try {
      emailed = await sendEmail({ to: signerEmail, subject: 'Your signed workshop agreement — ' + legalName, text, attachment: { filename: 'NMA-Workshop-Agreement-' + legalName.replace(/[^A-Za-z0-9]+/g, '-') + '.pdf', content: pdf } });
    } catch (e) { emailed = false; }
    if (emailed) await q('PATCH', '/rest/v1/workshop_waivers?id=eq.' + saved.id, { emailed_copy_at: new Date().toISOString() }, 'return=minimal').catch(() => {});
    await audit(event, { event: emailed ? 'email_sent' : 'email_failed', workshop_id: w.id, participant_id: participant.id, waiver_id: saved.id });
  }

  return S.json(200, {
    ok: true, participant_name: legalName, participant_type: rec.participant_type, receipt: saved.id.slice(0, 8).toUpperCase(),
    emailed, email: signerEmail || null, media: mediaChoice,
    pdf_base64: pdf && pdf.length < 1.5e6 ? pdf.toString('base64') : null,
    pdf_filename: 'NMA-Workshop-Agreement-' + legalName.replace(/[^A-Za-z0-9]+/g, '-') + '.pdf',
    // so a parent signing for several people doesn't retype contact details
    carry: { signer_name: signerName, relationship, email: signerEmail, phone: signerPhone, emergency_name: emName, emergency_phone: emPhone },
  });
}

// Fills the template's bracketed placeholders with this signing's values.
// The agreement wording itself is never changed.
function fillWaiver(body, r) {
  const s = r.workshop_snapshot, minor = r.participant_type === 'Minor';
  const sig = '/s/ ' + r.signature_text + '  (typed electronic signature)';
  return String(body).split('\n').map(line => {
    if (/^\*\*Adult Participant Signature:\*\*/.test(line)) return line.replace('[Electronic Signature, if applicable]', minor ? 'Not applicable — minor participant' : sig);
    if (/^\*\*Parent\/Legal Guardian Signature:\*\*/.test(line)) return line.replace('[Electronic Signature, if applicable]', minor ? sig : 'Not applicable — adult participant');
    return line
      .replace('[Workshop Name]', s.name).replace('[Workshop Date]', s.date_display).replace('[Workshop Location]', s.location)
      .replace('[Participant Name]', r.participant_legal_name).replace('[Date of Birth]', fmtDate(r.participant_dob).replace(/^\w+, /, ''))
      .replace('[Adult / Minor]', r.participant_type)
      .replace('[Parent/Guardian Name, if applicable]', minor ? r.signer_legal_name : 'Not applicable')
      .replace('[Relationship]', minor ? (r.signer_relationship || '') : 'Not applicable')
      .replace('[System Timestamp]', r.signed_at + ' (UTC) — ' + eastern(r.signed_at))
      .replace('[System-Generated Workshop ID]', s.workshop_ref + '  (' + s.workshop_id + ')')
      .replace('[Waiver Version]', r.waiver_doc_id);
  }).join('\n');
}
function fillMedia(body, r) {
  const yes = r.media_consent === 'Yes';
  return String(body)
    .replace('[Participant Name]', r.participant_legal_name)
    .replace('[Adult Participant / Parent or Legal Guardian]', r.media_signer_role)
    .replace('[Consenting Adult Name]', r.media_signer_name)
    .replace('[Signature]', r.media_signature_text ? '/s/ ' + r.media_signature_text + '  (typed electronic signature)' : 'Not signed (consent declined)')
    .replace('[Timestamp]', r.signed_at + ' (UTC) — ' + eastern(r.signed_at))
    + '\n\n**Selection recorded: ' + (yes ? 'YES — consent given' : 'NO — consent not given') + '**';
}
function buildPdf(r, wd, md) {
  const d = new Doc({ footer: "Noble's Martial Arts • Signed record " + r.id.slice(0, 8).toUpperCase() + ' • ' + r.participant_legal_name });
  d.para('SIGNED COPY — READ-ONLY RECORD', { size: 9, bold: true, gray: true, after: 2 });
  d.para('Generated ' + r.signed_at + ' UTC. This copy reproduces the agreement version shown to and signed by the signer.', { size: 8, gray: true, after: 8 });
  d.markdown(fillWaiver(wd.body, r));
  d.rule();
  d.heading('Health or accommodation notes', 11);
  d.para(r.medical_notes ? 'Provided by the signer. Held separately in Noble’s Martial Arts records with restricted access; not reproduced on this copy.' : 'None provided.', { size: 10 });
  d.heading('Emergency contact', 11);
  d.kv('Name', r.emergency_contact_name);
  d.kv('Phone', r.emergency_contact_phone);
  d.newPage();
  d.markdown(fillMedia(md.body, r));
  d.rule();
  d.heading('Electronic signing record', 11);
  d.kv('Signed record ID', r.id);
  d.kv('Signed (UTC)', r.signed_at);
  d.kv('Signed (Eastern)', eastern(r.signed_at));
  d.kv('Signer', r.signer_legal_name + ' — ' + r.signer_role + (r.signer_relationship ? ' (' + r.signer_relationship + ')' : ''));
  d.kv('Signer email', r.signer_email || '');
  d.kv('Signer phone', r.signer_phone || '');
  d.kv('Participant', r.participant_legal_name + ' (' + r.participant_type + ', age ' + r.age_at_workshop + ' at workshop)');
  d.kv('Workshop', r.workshop_snapshot.name + ' — ' + r.workshop_snapshot.workshop_ref);
  d.kv('Agreement version', r.waiver_doc_id + '  sha256 ' + r.waiver_doc_sha256.slice(0, 16) + '…');
  d.kv('Media consent version', r.media_doc_id + '  sha256 ' + r.media_doc_sha256.slice(0, 16) + '…');
  d.kv('Read full agreement', 'Yes — checked by signer');
  d.kv('Risk & release acknowledged', 'Yes — checked by signer');
  d.kv('Electronic signing consent', 'Yes — checked by signer');
  if (r.participant_type === 'Minor') d.kv('Parent/guardian authority', 'Yes — certified by signer');
  d.kv('IP address', r.signer_ip || '');
  d.kv('Device', r.signer_user_agent || '');
  return d.build();
}

// ── staff ──
async function opLink(body, actor, rotate) {
  const id = clip(body.workshop_id, 40);
  const rows = await q('GET', '/rest/v1/workshop_leads?id=eq.' + encodeURIComponent(id) + '&select=id,waiver_token,public_title,organization,type');
  const w = rows && rows[0]; if (!w) return S.json(404, { error: 'not_found' });
  const patch = {};
  if (typeof body.public_title === 'string') patch.public_title = clip(body.public_title, 120) || null;
  let created = false;
  if (!w.waiver_token || rotate) { patch.waiver_token = crypto.randomBytes(24).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); created = true; }
  if (Object.keys(patch).length) await q('PATCH', '/rest/v1/workshop_leads?id=eq.' + w.id, patch, 'return=minimal');
  await q('PATCH', '/rest/v1/workshop_participants?workshop_id=eq.' + w.id + '&waiver_status=eq.Not%20Sent', { waiver_status: 'Pending' }, 'return=minimal');
  if (created) await audit(null, { event: rotate ? 'link_rotated' : 'link_created', workshop_id: w.id, actor });
  const merged = Object.assign({}, w, patch);
  return S.json(200, { token: merged.waiver_token, public_title: merged.public_title || '', title_shown: publicTitle(merged) });
}
async function opSummary(body) {
  const id = clip(body.workshop_id, 40);
  const ws = await q('GET', '/rest/v1/workshop_waivers?workshop_id=eq.' + encodeURIComponent(id) + '&superseded_by=is.null&select=id,participant_id,signed_at,signer_legal_name,signer_role,participant_type,media_consent,waiver_doc_id,pdf_path,emailed_copy_at,medical_notes');
  const docs = await currentDocs();
  const out = {};
  (ws || []).forEach(r => {
    out[r.participant_id] = {
      waiver_id: r.id, signed_at: r.signed_at, signer: r.signer_legal_name, signer_role: r.signer_role, type: r.participant_type,
      media: r.media_consent, version: r.waiver_doc_id, outdated_version: docs.workshop_waiver ? r.waiver_doc_id !== docs.workshop_waiver.id : false,
      has_pdf: !!r.pdf_path, emailed: !!r.emailed_copy_at, has_notes: !!r.medical_notes,
    };
  });
  return S.json(200, { waivers: out, current_version: docs.workshop_waiver ? docs.workshop_waiver.id : null, doc_status: docs.workshop_waiver ? docs.workshop_waiver.status : null });
}
async function opDetail(body, actor) {
  const pid = clip(body.participant_id, 40);
  const ws = await q('GET', '/rest/v1/workshop_waivers?participant_id=eq.' + encodeURIComponent(pid) + '&select=*&order=signed_at.desc');
  const log = await q('GET', '/rest/v1/waiver_audit?participant_id=eq.' + encodeURIComponent(pid) + '&select=at,event,actor,ip,detail&order=at.desc&limit=50');
  await audit(null, { event: 'detail_viewed', participant_id: pid, actor });
  return S.json(200, { waivers: ws || [], audit: log || [] });
}
async function opPdf(body, actor) {
  const wid = clip(body.waiver_id, 40);
  const rows = await q('GET', '/rest/v1/workshop_waivers?id=eq.' + encodeURIComponent(wid) + '&select=id,participant_id,workshop_id,pdf_path');
  const r = rows && rows[0]; if (!r || !r.pdf_path) return S.json(404, { error: 'no_pdf', message: 'No PDF stored for this waiver.' });
  const res = await fetch(S.SUPA_URL + '/storage/v1/object/sign/' + BUCKET + '/' + r.pdf_path, {
    method: 'POST', headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 120 }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.signedURL) return S.json(502, { error: 'sign_failed', message: 'Could not open the PDF right now.' });
  await audit(null, { event: 'pdf_viewed', workshop_id: r.workshop_id, participant_id: r.participant_id, waiver_id: r.id, actor });
  return S.json(200, { url: S.SUPA_URL + '/storage/v1' + j.signedURL });
}
async function opPaper(body, actor) {
  const pid = clip(body.participant_id, 40);
  const note = clip(body.note, 300);
  const rows = await q('PATCH', '/rest/v1/workshop_participants?id=eq.' + encodeURIComponent(pid), {
    waiver_status: 'Signed', waiver_signed: true, paper_waiver: true, waiver_signed_at: new Date().toISOString(), attention_reason: null, updated_at: new Date().toISOString(),
    media_consent: body.media === 'Yes' ? 'Yes' : 'No',
  }, 'return=representation');
  if (!rows || !rows[0]) return S.json(404, { error: 'not_found' });
  await audit(null, { event: 'paper_recorded', workshop_id: rows[0].workshop_id, participant_id: pid, actor, detail: { note, media: body.media === 'Yes' ? 'Yes' : 'No' } });
  return S.json(200, { ok: true });
}
async function opResolve(body, actor) {
  const pid = clip(body.participant_id, 40);
  const rows = await q('GET', '/rest/v1/workshop_participants?id=eq.' + encodeURIComponent(pid) + '&select=id,workshop_id,current_waiver_id,paper_waiver,waiver_status,attention_reason');
  const p = rows && rows[0]; if (!p) return S.json(404, { error: 'not_found' });
  const signed = !!(p.current_waiver_id || p.paper_waiver);
  await q('PATCH', '/rest/v1/workshop_participants?id=eq.' + p.id, { waiver_status: signed ? 'Signed' : 'Pending', waiver_signed: signed, attention_reason: null, updated_at: new Date().toISOString() }, 'return=minimal');
  await audit(null, { event: 'attention_resolved', workshop_id: p.workshop_id, participant_id: p.id, actor, detail: { was: p.attention_reason } });
  return S.json(200, { ok: true, status: signed ? 'Signed' : 'Pending' });
}
async function opMediaWithdraw(body, actor) {
  const pid = clip(body.participant_id, 40);
  const rows = await q('PATCH', '/rest/v1/workshop_participants?id=eq.' + encodeURIComponent(pid), { media_consent: 'No', updated_at: new Date().toISOString() }, 'return=representation');
  if (!rows || !rows[0]) return S.json(404, { error: 'not_found' });
  await audit(null, { event: 'media_withdrawn', workshop_id: rows[0].workshop_id, participant_id: pid, actor, detail: { note: clip(body.note, 300) } });
  return S.json(200, { ok: true });
}
async function opPurgeNotes(body, actor) {
  const id = clip(body.workshop_id, 40);
  const rows = await q('PATCH', '/rest/v1/workshop_waivers?workshop_id=eq.' + encodeURIComponent(id) + '&medical_notes=not.is.null', { medical_notes: null }, 'return=representation');
  await audit(null, { event: 'notes_purged', workshop_id: id, actor, detail: { count: (rows || []).length } });
  return S.json(200, { ok: true, purged: (rows || []).length });
}

module.exports.__test = { buildPdf, fillWaiver, fillMedia, normName, ageOn, publicTitle, snapshotOf };
