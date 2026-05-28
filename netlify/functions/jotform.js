exports.handler = async (event) => {
  // CORS headers for all responses
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const JOTFORM_KEY = process.env.JOTFORM_API_KEY;
  if (!JOTFORM_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'JOTFORM_API_KEY not set in Netlify environment variables' }) };
  }

  const FORM_ID = '261055009001137';

  try {
    const url = 'https://api.jotform.com/form/' + FORM_ID + '/submissions?apiKey=' + JOTFORM_KEY + '&limit=100&orderby=created_at&direction=DESC';
    
    const res = await fetch(url);
    const text = await res.text(); // Read as text first to avoid JSON parse crash
    
    let data;
    try {
      data = JSON.parse(text);
    } catch(parseErr) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Jotform returned non-JSON: ' + text.slice(0, 200) }) };
    }

    if (!res.ok || data.responseCode !== 200) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: data.message || ('Jotform error code: ' + data.responseCode) }) };
    }

    // Parse submissions into clean objects
    const orders = (data.content || []).map(sub => {
      const ans = sub.answers || {};
      
      // Helper: find answer by label keyword
      const get = (...keywords) => {
        for (const kw of keywords) {
          const key = Object.keys(ans).find(k => (ans[k].text || '').toLowerCase().includes(kw.toLowerCase()));
          if (key) {
            const a = ans[key].answer;
            if (!a) continue;
            if (typeof a === 'object' && (a.first || a.last)) return ((a.first || '') + ' ' + (a.last || '')).trim();
            return String(a).trim();
          }
        }
        return '';
      };

      // Parse products
      let products = [];
      const prodKey = Object.keys(ans).find(k => (ans[k].text || '').toLowerCase().includes('product'));
      if (prodKey && ans[prodKey].answer) {
        try {
          const raw = ans[prodKey].answer;
          const arr = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
          products = arr.filter(p => p && p.name).map(p => ({
            name: p.name || '',
            price: parseFloat(p.price) || 0,
            qty: parseInt(p.quantity) || 1,
            options: (p.options || []).map(o => (o.name || '') + ': ' + (o.value || o.defaultValue || '')).filter(Boolean)
          }));
        } catch(e) { products = []; }
      }

      // Up to 3 student names
      const students = [get("student's name"), get("student's name.1"), get("student's name.2")]
        .filter(Boolean).join(', ');

      const total = products.reduce((s, p) => s + (p.price * p.qty), 0);
      
      // Check payment status from raw answers
      const rawJSON = JSON.stringify(sub);
      const paid = rawJSON.includes('"PAID"') || rawJSON.includes('"status":"PAID"');

      return {
        id: sub.id,
        date: (sub.created_at || '').slice(0, 10),
        parentName: get('full name'),
        email: get('e-mail', 'email'),
        phone: get('contact number', 'phone'),
        students,
        products,
        total,
        invoiceId: get('invoice'),
        notes: get('special instruction', 'note', 'comment'),
        paid
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ orders }) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Function error: ' + e.message + ' | stack: ' + (e.stack || '').slice(0, 300) }) };
  }
};
