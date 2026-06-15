// netlify/functions/absence.js
// Receives Jotform webhook POST for absence notifications,
// writes a pending absence request into the NMA Supabase crm_data row.

const SUPA_URL = 'https://erqblpewozxkpornohvq.supabase.co';
const SUPA_KEY_ENV = 'SUPABASE_SERVICE_KEY'; // set this env var in Netlify dashboard

exports.handler = async (event) => {
  // Allow GET ping for Jotform webhook verification
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, body: 'NMA Absence Webhook OK' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const SUPA_KEY = process.env[SUPA_KEY_ENV];
  if (!SUPA_KEY) {
    console.error('Missing SUPABASE_SERVICE_KEY env var');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server config error' }) };
  }

  try {
    // Jotform sends form data as application/x-www-form-urlencoded
    // Parse the rawRequest field which contains the full submission JSON
    let formData = {};

    const contentType = event.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      formData = JSON.parse(event.body);
    } else {
      // Parse URL-encoded body
      const params = new URLSearchParams(event.body);
      const rawRequest = params.get('rawRequest');
      if (rawRequest) {
        formData = JSON.parse(rawRequest);
      } else {
        // Fall back: parse all params directly
        params.forEach((v, k) => { formData[k] = v; });
      }
    }

    // ── Extract fields from Jotform submission ──
    // Field names match what we set in the Jotform form
    // Jotform sends answers as q{id}_* keys in rawRequest, or named keys
    // We'll support both by looking for our specific field names

    const studentName  = extractField(formData, ['studentName', 'student_name', 'q3_studentName', 'q3_student']);
    const parentName   = extractField(formData, ['parentName', 'parent_name', 'q4_parentName', 'q4_parent']);
    const parentEmail  = extractField(formData, ['parentEmail', 'parent_email', 'q5_parentEmail', 'q5_email']);
    const absenceDates = extractField(formData, ['absenceDates', 'absence_dates', 'q6_absenceDates', 'q6_dates']);
    const reason       = extractField(formData, ['reason', 'q7_reason', 'q7_comments']) || '';

    if (!studentName || !absenceDates) {
      console.warn('Missing required fields. studentName:', studentName, 'absenceDates:', absenceDates);
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields: studentName, absenceDates' }) };
    }

    // Normalize dates — Jotform may send comma-separated or array
    const rawDates = Array.isArray(absenceDates) ? absenceDates : absenceDates.split(',');
    const dates = rawDates
      .map(d => d.trim())
      .filter(Boolean)
      .map(d => normalizeDate(d))
      .filter(Boolean);

    if (!dates.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No valid dates parsed' }) };
    }

    // ── Fetch current DB from Supabase ──
    const fetchRes = await fetch(
      `${SUPA_URL}/rest/v1/crm_data?id=eq.main&select=data`,
      {
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!fetchRes.ok) {
      const err = await fetchRes.text();
      throw new Error(`Supabase fetch failed: ${err}`);
    }

    const rows = await fetchRes.json();
    if (!rows || !rows.length) throw new Error('No crm_data row found');

    const DB = rows[0].data;

    // ── Initialize pendingAbsences if not present ──
    if (!DB.pendingAbsences) DB.pendingAbsences = [];

    // ── Build one pending request per date ──
    const submittedAt = new Date().toISOString();
    const newRequests = dates.map(date => ({
      id: `abs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      studentName: studentName.trim(),
      parentName:  (parentName || '').trim(),
      parentEmail: (parentEmail || '').trim(),
      date,
      reason:      reason.trim(),
      submittedAt,
      status: 'pending'   // 'pending' | 'confirmed' | 'dismissed'
    }));

    DB.pendingAbsences.push(...newRequests);

    // ── Write updated DB back to Supabase ──
    const upsertRes = await fetch(
      `${SUPA_URL}/rest/v1/crm_data?id=eq.main`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ data: DB })
      }
    );

    if (!upsertRes.ok) {
      const err = await upsertRes.text();
      throw new Error(`Supabase write failed: ${err}`);
    }

    console.log(`✅ Absence request saved for ${studentName} on ${dates.join(', ')}`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, student: studentName, dates })
    };

  } catch (e) {
    console.error('Absence webhook error:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};

// ── Helpers ──

function extractField(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') {
      const val = obj[key];
      // Jotform sometimes wraps in {first, last} objects
      if (typeof val === 'object' && (val.first || val.last)) {
        return `${val.first || ''} ${val.last || ''}`.trim();
      }
      return String(val);
    }
  }
  return null;
}

function normalizeDate(raw) {
  // Accept MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD
  if (!raw) return null;
  raw = raw.trim();

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // MM/DD/YYYY or M/D/YYYY
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, m, d, y] = match;
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // Try native parse as last resort (may have timezone issues)
  const parsed = new Date(raw);
  if (!isNaN(parsed)) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}
