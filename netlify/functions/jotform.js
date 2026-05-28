exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const JOTFORM_KEY = process.env.JOTFORM_API_KEY;
  if (!JOTFORM_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'JOTFORM_API_KEY not set in Netlify environment variables' }) };
  }

  const FORM_ID = '261055009001137'; // NMA T-Shirt Order
  const url = `https://api.jotform.com/form/${FORM_ID}/submissions?apiKey=${JOTFORM_KEY}&limit=100&orderby=created_at&direction=DESC`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok || data.responseCode !== 200) {
      return {
        statusCode: res.status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: data.message || 'Jotform API error' })
      };
    }

    // Parse submissions into clean objects
    const orders = (data.content || []).map(sub => {
      const ans = sub.answers || {};
      const get = (...labels) => {
        for (const label of labels) {
          const key = Object.keys(ans).find(k =>
            (ans[k].text || '').toLowerCase().includes(label.toLowerCase())
          );
          if (key) {
            const a = ans[key].answer;
            if (a && typeof a === 'object' && a.first) return `${a.first} ${a.last || ''}`.trim();
            if (a) return String(a).trim();
          }
        }
        return '';
      };

      // Parse products from the cart field
      let products = [];
      const prodKey = Object.keys(ans).find(k => (ans[k].text || '').toLowerCase().includes('product'));
      if (prodKey) {
        try {
          const raw = ans[prodKey].answer;
          const arr = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
          products = arr.filter(p => p.name).map(p => ({
            name: p.name,
            price: parseFloat(p.price) || 0,
            qty: parseInt(p.quantity) || 1,
            options: (p.options || []).map(o => `${o.name}: ${o.value || o.defaultValue || ''}`)
          }));
        } catch(e) { products = []; }
      }

      // Student names — up to 3 students
      const students = [get("student's name"), get("student's name.1"), get("student's name.2")]
        .filter(Boolean).join(', ');

      const total = products.reduce((s, p) => s + p.price * p.qty, 0);

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
        // Payment status from Jotform — check if any product shows PAID
        paid: products.some(p => p.paid) ||
              Object.values(ans).some(a => JSON.stringify(a).includes('"PAID"') || JSON.stringify(a).includes('"status":"PAID"'))
      };
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message })
    };
  }
};
