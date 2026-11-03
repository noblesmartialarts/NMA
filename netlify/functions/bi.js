// Read-only business intelligence API for a private ChatGPT Custom GPT (or any analysis tool).
//
// Totals only: no names, emails, phones, addresses, notes, payment references or
// per-student rows ever leave this function — just counts, rates and dollar sums.
//
// Auth:    Authorization: Bearer <BI_API_KEY>   (Netlify env var; unset = disabled)
// Methods: GET only. Reads crm_data + workshop_leads with the service key; never writes them.
// Usage:   GET /.netlify/functions/bi?report=overview&from=2026-01&to=2026-11
//          GET /.netlify/functions/bi?openapi=1   → OpenAPI schema for the GPT builder (no data)
const crypto = require('crypto');
const S = require('../lib/session');

const REPORTS = ['overview', 'enrollment', 'attendance', 'testing', 'revenue', 'spend', 'outstanding', 'feedback', 'workshops'];
const BASE_URL = process.env.BI_BASE_URL || 'https://crm.noblesmartialarts.com';

// Intent-letter checklist item → focus theme (mirrors PF_ITEMS in the CRM)
const PF_THEME = { practices_home: 'Practice at home', no_talk_back: 'Interrupting / talking back', shares: 'Sharing & kindness', chores: 'Chores & responsibility', attention_school: 'Focus & attention', listens: 'Listening', bedtime: 'Bedtime & routines', honest: 'Honesty', respectful: 'Respect & manners', academics: 'Schoolwork' };

function json(code, obj) {
  return { statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }, body: JSON.stringify(obj) };
}
function authorized(event) {
  const want = process.env.BI_API_KEY || '';
  if (want.length < 24) return false; // refuse weak or missing keys
  const h = event.headers || {};
  const got = String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
  const a = crypto.createHash('sha256').update(got).digest(), b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
const r2 = n => Math.round((+n || 0) * 100) / 100;
const pct = (a, b) => (b ? Math.round(a / b * 1000) / 10 : null);
const ym = d => String(d || '').slice(0, 7);
const inRange = (d, from, to) => { const m = ym(d); return m && m >= from && m <= to; };
function bump(obj, key, n) { obj[key] = r2((obj[key] || 0) + (n == null ? 1 : n)); }
function monthsBetween(from, to) { const out = []; let [y, m] = from.split('-').map(Number); const [ty, tm] = to.split('-').map(Number); while (y < ty || (y === ty && m <= tm)) { out.push(y + '-' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } if (out.length > 60) break; } return out; }

async function loadData() {
  const r = await S.supa('GET', '/rest/v1/crm_data?id=eq.main&select=data');
  if (!r.ok) throw new Error('Database error ' + r.status);
  const rows = await r.json();
  return (rows[0] && rows[0].data) || {};
}
async function loadLeads() {
  const r = await S.supa('GET', '/rest/v1/workshop_leads?select=type,status,source,tier,session_date,date_contacted,amount_charged,assistant_pay,testimonial_obtained,created_at');
  return r.ok ? r.json() : [];
}

function build(report, DB, ctx) {
  const { from, to, today } = ctx;
  const students = DB.students || [];
  const active = students.filter(s => s.status === 'Active');
  const groupOf = id => { const s = students.find(x => x.id === id); return s ? s.group : 'Unknown'; };
  const events = (DB.testEvents || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const evById = id => events.find(e => e.id === id);

  const enrollment = () => {
    const byGroup = {}, byBelt = {}, newByMonth = {};
    active.forEach(s => { bump(byGroup, s.group); bump(byBelt, s.group + ' · ' + s.belt); });
    students.forEach(s => { if (s.firstDate && inRange(s.firstDate, from, to)) bump(newByMonth, ym(s.firstDate)); });
    const months = (DB.monthHistory || []).map(m => {
      const st = m.students || [];
      const g = {}; st.forEach(x => { g[x.group] = g[x.group] || { active: 0, registered: 0 }; g[x.group].active++; if (x.registered === 'Yes' || x.omit) g[x.group].registered++; });
      return { month: m.month, snapshotDate: m.date, active: st.length, registered: st.filter(x => x.registered === 'Yes').length, directPay: st.filter(x => x.paidVenmo).length, comp: st.filter(x => x.omit).length, byGroup: g };
    });
    return {
      activeStudents: active.length, inactiveStudents: students.filter(s => s.status !== 'Active').length,
      families: (DB.families || []).filter(f => active.some(s => s.familyId === f.id)).length || null,
      activeByGroup: byGroup, activeByGroupAndBelt: byBelt, newStudentsByMonth: newByMonth,
      currentMonth: { label: (DB.scoreboard || {}).label || null, registered: active.filter(s => s.registered === 'Yes').length, notRegistered: active.filter(s => s.registered !== 'Yes' && !s.omitFromReg).length, comp: active.filter(s => s.omitFromReg).length, rosterImported: DB.rosterImportedFor === (DB.scoreboard || {}).label },
      monthlyHistory: months,
    };
  };

  const attendance = () => {
    const byMonth = {}, byGroupMonth = {};
    Object.entries(DB.attendance || {}).forEach(([date, rec]) => {
      if (!inRange(date, from, to)) return;
      const vals = Object.entries(rec || {}); if (!vals.length) return;
      const m = ym(date); byMonth[m] = byMonth[m] || { classDays: 0, marked: 0, present: 0 };
      byMonth[m].classDays++;
      vals.forEach(([sid, v]) => {
        byMonth[m].marked++; if (v === 'present') byMonth[m].present++;
        const g = groupOf(+sid); const k = g + '|' + m;
        byGroupMonth[k] = byGroupMonth[k] || { group: g, month: m, marked: 0, present: 0 };
        byGroupMonth[k].marked++; if (v === 'present') byGroupMonth[k].present++;
      });
    });
    Object.values(byMonth).forEach(x => { x.attendanceRatePct = pct(x.present, x.marked); x.avgPresentPerClassDay = x.classDays ? r2(x.present / x.classDays) : null; });
    Object.values(byGroupMonth).forEach(x => { x.attendanceRatePct = pct(x.present, x.marked); });
    return { note: 'Groups are students\' current class. Rates = present ÷ marked.', byMonth, byGroupAndMonth: Object.values(byGroupMonth).sort((a, b) => (a.month + a.group).localeCompare(b.month + b.group)) };
  };

  const testing = () => {
    const promos = DB.promotions || [];
    const perEvent = events.filter(e => e.type !== 'Stripe Test' && inRange(e.date, from, to)).map(e => {
      const p = promos.filter(x => x.eventId === e.id);
      const byGroup = {}; p.forEach(x => bump(byGroup, x.fromGroup || 'Unknown'));
      const paid = (DB.testFees || []).filter(f => f.eventId === e.id && f.paid);
      const mk = (DB.makeupTests || []).filter(m => m.eventId === e.id);
      return { event: e.name, date: e.date, type: e.type, fee: +e.fee || 0, promotions: p.length, promotionsByFromGroup: byGroup, feesPaidCount: paid.length, feesCollected: r2(paid.length * (+e.fee || 0)), makeupTests: mk.length, makeupsCompleted: mk.filter(m => m.resolved).length };
    });
    const ready = active.filter(s => (parseInt(s.stripes, 10) || 0) >= 2).length;
    return { perEvent, upcomingTests: events.filter(e => e.date >= today).map(e => ({ event: e.name, date: e.date, type: e.type, fee: +e.fee || 0 })), currentlyAtFullStripes: ready, crossGroupPromotions: promos.filter(p => inRange(p.date, from, to) && p.fromGroup !== p.toGroup).length };
  };

  const revenue = () => {
    const months = monthsBetween(from, to); const t = {};
    months.forEach(m => { t[m] = { tuitionEstimate: 0, directRegistration: 0, testFees: 0, gearOrders: 0, apparel: 0, walkInSales: 0, workshops: 0 }; });
    const add = (d, k, n) => { const m = ym(d); if (t[m]) t[m][k] = r2(t[m][k] + (+n || 0)); };
    (DB.monthHistory || []).forEach(h => { const st = h.students || []; const reg = st.filter(x => x.registered === 'Yes' && !x.paidVenmo && !x.omit).length; add(h.date, 'tuitionEstimate', reg * (+h.fee || 0)); });
    students.forEach(s => { if (s.regPayment && s.regPayment.amount) add(s.regPayment.date, 'directRegistration', s.regPayment.amount); });
    (DB.testFees || []).forEach(f => { if (!f.paid) return; const e = evById(f.eventId); add(f.datePaid || (e && e.date), 'testFees', e ? e.fee : 0); });
    (DB.gearOrders || []).forEach(o => { if (o.paid) add(o.paidDate || o.date, 'gearOrders', o.amount); });
    (DB.apparelOrders || []).forEach(o => { if (o.paid) add(o.paidDate || o.date, 'apparel', o.total); });
    (DB.merchSales || []).forEach(x => add(x.date, 'walkInSales', x.amount));
    (ctx.leads || []).forEach(l => { if (l.amount_charged && l.session_date) add(l.session_date, 'workshops', l.amount_charged); });
    Object.values(t).forEach(x => { x.total = r2(Object.values(x).reduce((a, b) => a + b, 0)); });
    const sales = {}; (DB.merchSales || []).filter(x => inRange(x.date, from, to)).forEach(x => { sales[x.item] = sales[x.item] || { qty: 0, amount: 0 }; sales[x.item].qty += +x.qty || 0; sales[x.item].amount = r2(sales[x.item].amount + (+x.amount || 0)); });
    const gearTypes = {}; (DB.gearOrders || []).filter(o => inRange(o.date, from, to) && (+o.amount || 0) > 0).forEach(o => { const k = o.orderType || 'Other'; gearTypes[k] = gearTypes[k] || { orders: 0, amount: 0, vendorCost: 0 }; gearTypes[k].orders++; gearTypes[k].amount = r2(gearTypes[k].amount + (+o.amount || 0)); gearTypes[k].vendorCost = r2(gearTypes[k].vendorCost + (o.vendorLinks || []).reduce((a, l) => a + (+l.cost || 0), 0)); });
    return { note: 'Cash basis by month paid. tuitionEstimate = Town-registered students × the per-student amount NMA receives (from the monthly snapshot). vendorCost only where an order is linked to a vendor invoice.', byMonth: t, walkInSalesByItem: sales, gearOrdersByType: gearTypes };
  };

  const spend = () => {
    const byMonth = {}, byVendor = {};
    (DB.invoices || []).filter(i => inRange(i.date, from, to)).forEach(i => { bump(byMonth, ym(i.date), +i.total || 0); bump(byVendor, i.vendor || 'Unknown', +i.total || 0); });
    const assist = {}; (ctx.leads || []).forEach(l => { if (l.assistant_pay && inRange(l.session_date, from, to)) bump(assist, ym(l.session_date), l.assistant_pay); });
    return { vendorInvoicesByMonth: byMonth, vendorInvoicesByVendor: byVendor, total: r2(Object.values(byMonth).reduce((a, b) => a + b, 0)), workshopAssistantPayByMonth: assist };
  };

  const outstanding = () => {
    const gear = (DB.gearOrders || []).filter(o => !o.paid && (+o.amount || 0) > 0);
    const apparel = (DB.apparelOrders || []).filter(o => !o.paid && (+o.total || 0) > 0);
    const fees = []; events.filter(e => e.type !== 'Stripe Test' && (+e.fee || 0) > 0 && e.date <= today && e.date >= ctx.ago60).forEach(e => {
      (DB.promotions || []).filter(p => p.eventId === e.id).forEach(p => { if (!(DB.testFees || []).some(f => f.eventId === e.id && f.studentId === p.studentId && f.paid)) fees.push(+e.fee || 0); });
    });
    const age = d => { const days = (Date.parse(today) - Date.parse(d)) / 86400e3; return days <= 30 ? '0-30 days' : days <= 60 ? '31-60 days' : '60+ days'; };
    const aging = {}; gear.forEach(o => bump(aging, age(o.date), +o.amount)); apparel.forEach(o => bump(aging, age(o.date), +o.total));
    return { gearOrders: { count: gear.length, amount: r2(gear.reduce((a, o) => a + (+o.amount || 0), 0)) }, apparel: { count: apparel.length, amount: r2(apparel.reduce((a, o) => a + (+o.total || 0), 0)) }, testFeesForRecentPromotions: { count: fees.length, amount: r2(fees.reduce((a, b) => a + b, 0)) }, gearAndApparelAging: aging };
  };

  const feedback = () => {
    return events.filter(e => inRange(e.date, from, to)).map(e => {
      const list = (DB.parentFeedback || []).filter(f => f.eventId === e.id); if (!list.length) return null;
      const themes = {}, strengths = {}, byGroup = {};
      list.forEach(f => {
        const t = new Set(); Object.entries(f.answers || {}).forEach(([k, v]) => { if (v === 'no' && PF_THEME[k]) t.add(PF_THEME[k]); }); (f.concerns || []).forEach(x => t.add(x));
        t.forEach(x => bump(themes, x)); (f.strengths || []).forEach(x => bump(strengths, x)); bump(byGroup, f.group || 'Unknown');
      });
      return { event: e.name, date: e.date, lettersReturned: list.length, returnedOnline: list.filter(f => f.source === 'portal').length, lettersByGroup: byGroup, focusAreas: themes, strengths };
    }).filter(Boolean);
  };

  const workshops = () => {
    const L = (ctx.leads || []).filter(l => inRange(l.date_contacted || l.session_date || l.created_at, from, to));
    const by = k => { const o = {}; L.forEach(l => bump(o, l[k] || 'Unknown')); return o; };
    const done = L.filter(l => l.amount_charged > 0);
    return { leads: L.length, byStatus: by('status'), byType: by('type'), bySource: by('source'), byTier: by('tier'), paidSessions: done.length, revenue: r2(done.reduce((a, l) => a + (+l.amount_charged || 0), 0)), assistantPay: r2(done.reduce((a, l) => a + (+l.assistant_pay || 0), 0)), testimonials: L.filter(l => l.testimonial_obtained).length };
  };

  if (report === 'overview') {
    const e = enrollment(), a = attendance(), rev = revenue(), o = outstanding();
    const thisM = rev.byMonth[ym(today)] || null;
    const lastAtt = Object.entries(a.byMonth).sort().slice(-3);
    return { activeStudents: e.activeStudents, activeByGroup: e.activeByGroup, currentMonth: e.currentMonth, attendanceLast3Months: Object.fromEntries(lastAtt), revenueThisMonth: thisM, outstanding: o, upcomingTests: testing().upcomingTests.slice(0, 3) };
  }
  return { enrollment, attendance, testing, revenue, spend, outstanding, feedback, workshops }[report]();
}

function openapi() {
  return {
    openapi: '3.1.0',
    info: { title: "Noble's Martial Arts BI (read-only)", version: '1.0.0', description: 'Totals-only business metrics for Noble\'s Martial Arts: enrollment, attendance, belt testing, revenue, spend, outstanding balances, parent-feedback themes and workshop leads. No personal data.' },
    servers: [{ url: BASE_URL }],
    paths: {
      '/.netlify/functions/bi': {
        get: {
          operationId: 'getReport',
          summary: 'Get one business report (totals only)',
          description: 'overview = snapshot; enrollment = active students by class/belt, monthly registration history; attendance = rates by month and class; testing = promotions, fees, make-ups per belt test; revenue = monthly income by source (cash basis); spend = vendor invoices; outstanding = unpaid totals and aging; feedback = Intent-letter focus areas per test; workshops = lead pipeline and revenue.',
          parameters: [
            { name: 'report', in: 'query', required: true, schema: { type: 'string', enum: REPORTS } },
            { name: 'from', in: 'query', required: false, description: 'First month, YYYY-MM (default: 12 months ago)', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
            { name: 'to', in: 'query', required: false, description: 'Last month, YYYY-MM (default: this month)', schema: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } },
          ],
          responses: { '200': { description: 'Report JSON', content: { 'application/json': { schema: { type: 'object' } } } }, '401': { description: 'Missing or wrong API key' } },
        },
      },
    },
    components: { schemas: {}, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
    security: [{ bearerAuth: [] }],
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'read_only' });
  const q = event.queryStringParameters || {};
  if (q.openapi) return json(200, openapi());
  if (!process.env.BI_API_KEY) return json(503, { error: 'disabled', message: 'Set BI_API_KEY in Netlify to turn this on.' });
  if (!authorized(event)) return json(401, { error: 'unauthorized' });
  const report = String(q.report || 'overview');
  if (!REPORTS.includes(report)) return json(400, { error: 'unknown_report', reports: REPORTS });
  const now = new Date();
  const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const def = new Date(now); def.setMonth(def.getMonth() - 11);
  const from = /^\d{4}-\d{2}$/.test(q.from || '') ? q.from : def.toISOString().slice(0, 7);
  const to = /^\d{4}-\d{2}$/.test(q.to || '') ? q.to : today.slice(0, 7);
  const ago60 = new Date(Date.parse(today) - 60 * 86400e3).toISOString().slice(0, 10);
  try {
    const DB = await loadData();
    const leads = ['workshops', 'revenue', 'spend', 'overview'].includes(report) ? await loadLeads() : [];
    const data = build(report, DB, { from, to, today, ago60, leads });
    try { await S.supa('POST', '/rest/v1/portal_log', { event: 'bi_' + report, email: null, family_id: null, ip: 'bi', at: now.toISOString() }, 'return=minimal'); } catch (e) {}
    return json(200, { report, from, to, generated: now.toISOString(), data });
  } catch (e) {
    return json(500, { error: 'server_error', message: e.message });
  }
};
