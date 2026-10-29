// Signed-in proxy from the CRM to Supabase. The browser sends a recorded
// supabase-js style query chain; this replays it against PostgREST with the
// service key, for an allowlisted set of tables and methods only.
// POST { steps:[{m:'from',a:['crm_data']},{m:'select',a:['data,updated_at']},{m:'eq',a:['id','main']},{m:'single',a:[]}] }
// → { data, error, count, status }
const S = require('../lib/session');

const TABLES = new Set([
  'crm_data', 'workshop_leads', 'nma_sale_items', 'nma_sale_orders',
  'private_lesson_bookings', 'private_lesson_packages', 'private_lesson_clients',
  'private_lesson_participants', 'private_lesson_services', 'private_lesson_availability',
]);
const FILTERS = { eq: 'eq', neq: 'neq', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', like: 'like', ilike: 'ilike', is: 'is', in: 'in' };

function fmtVal(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return String(v);
}
function inList(arr) {
  return '(' + (arr || []).map(v => {
    const s = fmtVal(v);
    return /[,()"\s]/.test(s) ? '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' : s;
  }).join(',') + ')';
}

function build(steps) {
  if (!Array.isArray(steps) || !steps.length || steps[0].m !== 'from') throw new Error('Query must start with from()');
  const table = steps[0].a && steps[0].a[0];
  if (!TABLES.has(table)) throw new Error('Table not allowed: ' + table);
  const q = { table, action: 'select', select: null, values: undefined, upsertOpts: null, filters: [], order: [], limit: null, range: null, single: null, count: null, head: false, returning: false };
  for (const st of steps.slice(1)) {
    const a = st.a || [];
    switch (st.m) {
      case 'select':
        if (q.action === 'select') { q.select = a[0] || '*'; if (a[1] && a[1].count) q.count = a[1].count; if (a[1] && a[1].head) q.head = true; }
        else { q.returning = true; q.select = a[0] || '*'; }
        break;
      case 'insert': q.action = 'insert'; q.values = a[0]; break;
      case 'update': q.action = 'update'; q.values = a[0]; break;
      case 'upsert': q.action = 'upsert'; q.values = a[0]; q.upsertOpts = a[1] || null; break;
      case 'delete': q.action = 'delete'; break;
      case 'order': q.order.push(a[0] + '.' + (a[1] && a[1].ascending === false ? 'desc' : 'asc') + (a[1] && a[1].nullsFirst ? '.nullsfirst' : '')); break;
      case 'limit': q.limit = parseInt(a[0], 10); break;
      case 'range': q.range = [parseInt(a[0], 10), parseInt(a[1], 10)]; break;
      case 'single': q.single = 'single'; break;
      case 'maybeSingle': q.single = 'maybe'; break;
      default:
        if (FILTERS[st.m]) {
          const col = String(a[0]);
          if (!/^[\w.\->]+$/.test(col)) throw new Error('Bad column');
          const val = st.m === 'in' ? inList(a[1]) : fmtVal(a[1]);
          q.filters.push([col, FILTERS[st.m] + '.' + val]);
        } else throw new Error('Method not allowed: ' + st.m);
    }
  }
  if ((q.action === 'update' || q.action === 'delete') && !q.filters.length) throw new Error('Refusing ' + q.action + ' without a filter');
  return q;
}

async function run(q) {
  const params = new URLSearchParams();
  if (q.select && (q.action === 'select' || q.returning)) params.set('select', q.select);
  q.filters.forEach(([c, v]) => params.append(c, v));
  if (q.order.length) params.set('order', q.order.join(','));
  if (q.limit != null && !isNaN(q.limit)) params.set('limit', String(q.limit));
  if (q.upsertOpts && q.upsertOpts.onConflict) params.set('on_conflict', q.upsertOpts.onConflict);
  const path = '/rest/v1/' + q.table + (params.toString() ? '?' + params.toString() : '');

  const prefer = [];
  const extra = {};
  if (q.count) prefer.push('count=' + q.count);
  if (q.action !== 'select') prefer.push(q.returning ? 'return=representation' : 'return=minimal');
  if (q.action === 'upsert') prefer.push('resolution=' + (q.upsertOpts && q.upsertOpts.ignoreDuplicates ? 'ignore' : 'merge') + '-duplicates');
  if (q.range) extra.Range = q.range[0] + '-' + q.range[1];
  if (q.single === 'single') extra.Accept = 'application/vnd.pgrst.object+json';

  const method = { select: q.head ? 'HEAD' : 'GET', insert: 'POST', upsert: 'POST', update: 'PATCH', delete: 'DELETE' }[q.action];
  const res = await S.supa(method, path, q.action === 'select' || q.action === 'delete' ? null : q.values, prefer.join(','), extra);

  let count = null;
  const cr = res.headers.get('content-range');
  if (cr && cr.includes('/')) { const n = cr.split('/')[1]; count = n === '*' ? null : parseInt(n, 10); }
  const text = method === 'HEAD' ? '' : await res.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch (e) { body = text; } }

  if (!res.ok) {
    const err = body && typeof body === 'object' ? body : { message: String(body || res.statusText) };
    return { data: null, error: { message: err.message || 'Database error', code: err.code || String(res.status), details: err.details || null, hint: err.hint || null }, count, status: res.status };
  }
  let data = body;
  if (q.action !== 'select' && !q.returning) data = null;
  if (q.head) data = null;
  if (q.single === 'maybe') {
    const arr = Array.isArray(data) ? data : (data == null ? [] : [data]);
    if (arr.length > 1) return { data: null, error: { message: 'Multiple rows returned', code: 'PGRST116' }, count, status: 406 };
    data = arr[0] || null;
  }
  return { data, error: null, count, status: res.status };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return S.json(405, { error: 'method_not_allowed' });
  const user = await S.requireUser(event);
  if (user.error) return user.error;
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return S.json(400, { error: 'bad_json' }); }
  try {
    const out = await run(build(body.steps));
    return S.json(200, out);
  } catch (e) {
    return S.json(200, { data: null, error: { message: e.message, code: 'proxy' }, count: null, status: 400 });
  }
};

module.exports._build = build;
