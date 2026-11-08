// Sends email from Noble's Martial Arts: the CRM's connected Gmail first,
// Resend as a fallback (same order as the family portal). Supports one PDF attachment.
const S = require('./session');
const G = require('./gmail');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hdr = s => /[^\x00-\x7F]/.test(s) ? '=?UTF-8?B?' + Buffer.from(s).toString('base64') + '?=' : s;
const validEmail = e => /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(String(e || ''));

async function sendEmail({ to, subject, text, attachment }) {
  if (!validEmail(to)) return false;
  if (G.clientSecret()) {
    try {
      const sec = await G.getSecret();
      if (sec && sec.refresh_token) {
        const t = await G.tokenRequest({ refresh_token: sec.refresh_token, grant_type: 'refresh_token' });
        if (t.ok) {
          const from = '"Noble\'s Martial Arts" <' + (sec.email || S.OWNER_EMAIL) + '>';
          let raw;
          if (attachment) {
            const boundary = 'nma_' + Date.now().toString(36);
            const att = Buffer.from(attachment.content).toString('base64').replace(/(.{76})/g, '$1\r\n');
            raw = ['From: ' + from, 'To: ' + to, 'Subject: ' + hdr(subject), 'Reply-To: ' + S.OWNER_EMAIL, 'MIME-Version: 1.0',
              'Content-Type: multipart/mixed; boundary="' + boundary + '"', '',
              '--' + boundary, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text, '',
              '--' + boundary, 'Content-Type: application/pdf; name="' + attachment.filename + '"',
              'Content-Disposition: attachment; filename="' + attachment.filename + '"', 'Content-Transfer-Encoding: base64', '', att, '',
              '--' + boundary + '--', ''].join('\r\n');
          } else {
            raw = ['From: ' + from, 'To: ' + to, 'Subject: ' + hdr(subject), 'Reply-To: ' + S.OWNER_EMAIL, 'MIME-Version: 1.0',
              'Content-Type: text/plain; charset=utf-8', '', text].join('\r\n');
          }
          const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST', headers: { Authorization: 'Bearer ' + t.data.access_token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw: b64u(Buffer.from(raw)) }),
          });
          if (r.ok) return true;
        }
      }
    } catch (e) { /* fall through to Resend */ }
  }
  if (process.env.RESEND_API_KEY && process.env.RESEND_FROM) {
    const body = { from: process.env.RESEND_FROM, to: [to], subject, text, reply_to: S.OWNER_EMAIL };
    if (attachment) body.attachments = [{ filename: attachment.filename, content: Buffer.from(attachment.content).toString('base64') }];
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return true;
  }
  return false;
}

module.exports = { sendEmail, validEmail };
