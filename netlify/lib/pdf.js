// Minimal dependency-free PDF writer for signed waiver copies.
// Uses the built-in Helvetica fonts (WinAnsi encoding), so no font files or npm
// packages are needed. Supports headings, wrapped paragraphs, bullets, rules,
// key/value rows and automatic page breaks with a footer on every page.

// Helvetica advance widths (1/1000 em) for ASCII 32..126, from the standard AFM.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,
  667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
  278,278,278,469,556,333,
  556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,
  334,260,334,584];
// Helvetica-Bold advance widths for ASCII 32..126.
const HELVB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,
  722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
  333,278,333,584,556,333,
  556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,
  389,280,389,584];
// Non-ASCII characters we map into WinAnsi (code, regular width, bold width).
const EXTRA = {
  '—': [0x97, 1000, 1000], // em dash
  '–': [0x96, 556, 556],   // en dash
  '‘': [0x91, 222, 278], '’': [0x92, 222, 278],
  '“': [0x93, 333, 500], '”': [0x94, 333, 500],
  '•': [0x95, 350, 350],   // bullet
  '…': [0x85, 1000, 1000], // ellipsis
  ' ': [0x20, 278, 278],
};

function encodeChar(ch) {
  const c = ch.charCodeAt(0);
  if (c >= 32 && c <= 126) return { code: c, w: HELV[c - 32], wb: HELVB[c - 32] };
  if (EXTRA[ch]) return { code: EXTRA[ch][0], w: EXTRA[ch][1], wb: EXTRA[ch][2] };
  if (c >= 0xA1 && c <= 0xFF) return { code: c, w: 556, wb: 611 }; // Latin-1 letters (é, ñ, …)
  return { code: 63, w: 556, wb: 611 }; // '?'
}
function textWidth(str, size, bold) {
  let w = 0;
  for (const ch of String(str)) { const e = encodeChar(ch); w += bold ? e.wb : e.w; }
  return w * size / 1000;
}
// Encodes a string as a PDF literal string in WinAnsi bytes.
function pdfStr(str) {
  let out = '';
  for (const ch of String(str)) {
    const { code } = encodeChar(ch);
    if (code === 0x28 || code === 0x29 || code === 0x5C) out += '\\' + String.fromCharCode(code);
    else if (code < 32 || code > 126) out += '\\' + code.toString(8).padStart(3, '0');
    else out += String.fromCharCode(code);
  }
  return '(' + out + ')';
}
function wrap(str, size, bold, maxW) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for (const word of words) {
    const t = line ? line + ' ' + word : word;
    if (textWidth(t, size, bold) <= maxW || !line) {
      // A single word wider than the line gets hard-broken.
      if (!line && textWidth(word, size, bold) > maxW) {
        let part = '';
        for (const ch of word) {
          if (textWidth(part + ch, size, bold) > maxW) { lines.push(part); part = ch; } else part += ch;
        }
        line = part;
      } else line = t;
    } else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

class Doc {
  constructor(opts) {
    this.W = 612; this.H = 792; this.M = 54; // US Letter, 0.75in margins
    this.footer = (opts && opts.footer) || '';
    this.pages = []; this.newPage();
  }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = this.H - this.M; }
  ensure(h) { if (this.y - h < this.M + 24) this.newPage(); }
  text(x, y, str, size, bold, gray) {
    this.ops.push((gray ? '0.35 g ' : '0 g ') + 'BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' + x.toFixed(2) + ' ' + y.toFixed(2) + ' Td ' + pdfStr(str) + ' Tj ET');
  }
  para(str, o) {
    o = o || {};
    const size = o.size || 10, bold = !!o.bold, indent = o.indent || 0, lead = size * 1.35;
    const x = this.M + indent, maxW = this.W - this.M * 2 - indent;
    const lines = wrap(str, size, bold, maxW - (o.bullet ? 12 : 0));
    lines.forEach((ln, i) => {
      this.ensure(lead);
      if (o.bullet && i === 0) this.text(x, this.y - size, '•', size, false, o.gray);
      this.text(x + (o.bullet ? 12 : 0), this.y - size, ln, size, bold, o.gray);
      this.y -= lead;
    });
    this.y -= o.after != null ? o.after : size * 0.5;
  }
  heading(str, size) { this.ensure((size || 12) * 3); this.y -= 4; this.para(str, { size: size || 12, bold: true, after: 2 }); }
  rule() { this.ensure(12); this.y -= 4; this.ops.push('0.7 G 0.5 w ' + this.M + ' ' + this.y.toFixed(2) + ' m ' + (this.W - this.M) + ' ' + this.y.toFixed(2) + ' l S'); this.y -= 10; }
  kv(label, value) {
    const size = 10, lead = 13.5, lw = 190;
    const lines = wrap(value == null || value === '' ? '—' : String(value), size, false, this.W - this.M * 2 - lw);
    lines.forEach((ln, i) => {
      this.ensure(lead);
      if (i === 0) this.text(this.M, this.y - size, label, size, true);
      this.text(this.M + lw, this.y - size, ln, size, false);
      this.y -= lead;
    });
  }
  space(h) { this.y -= h; }
  // Renders the stored Markdown-ish legal text without altering its words:
  // only formatting markers (#, **, list dashes) are turned into styling.
  markdown(md) {
    for (const raw of String(md).replace(/\r\n/g, '\n').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { this.y -= 3; continue; }
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { this.heading(stripMd(h[2]), h[1].length === 1 ? 14 : h[1].length === 2 ? 12 : 11); continue; }
      if (/^-{3,}$/.test(line)) { this.rule(); continue; }
      const b = /^\s*[-*]\s+(.*)$/.exec(line);
      if (b) { this.para(stripMd(b[1]), { bullet: true, indent: 6, after: 1 }); continue; }
      const allBold = /^\*\*(.*)\*\*$/.test(line.trim()) && line.trim().indexOf('**', 2) === line.trim().length - 2;
      this.para(stripMd(line), { bold: allBold, after: 3 });
    }
  }
  build() {
    const objs = [];
    const add = s => { objs.push(s); return objs.length; };
    const catalog = add(null), pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    const total = this.pages.length;
    this.pages.forEach((ops, i) => {
      const foot = [];
      const ft = (this.footer ? this.footer + '   •   ' : '') + 'Page ' + (i + 1) + ' of ' + total;
      foot.push('0.35 g BT /F1 8 Tf ' + this.M + ' ' + (this.M - 18) + ' Td ' + pdfStr(ft) + ' Tj ET');
      const content = ops.concat(foot).join('\n');
      const bytes = Buffer.from(content, 'latin1');
      const cs = add('<< /Length ' + bytes.length + ' >>\nstream\n' + content + '\nendstream');
      kids.push(add('<< /Type /Page /Parent ' + pagesObj + ' 0 R /MediaBox [0 0 ' + this.W + ' ' + this.H + '] /Resources << /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >> >> /Contents ' + cs + ' 0 R >>'));
    });
    objs[catalog - 1] = '<< /Type /Catalog /Pages ' + pagesObj + ' 0 R >>';
    objs[pagesObj - 1] = '<< /Type /Pages /Kids [' + kids.map(k => k + ' 0 R').join(' ') + '] /Count ' + kids.length + ' >>';
    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root ' + catalog + ' 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    return Buffer.from(out, 'latin1');
  }
}
function stripMd(s) { return String(s).replace(/\*\*/g, '').replace(/\[([^\]]+)\]\((mailto:)?[^)]+\)/g, '$1'); }

module.exports = { Doc, textWidth, wrap };
