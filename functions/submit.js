// Receives the form, then talks to Brevo. The API key never reaches the browser.
const BREVO = 'https://api.brevo.com/v3';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const clean = (s, max = 2000) => String(s ?? '').trim().slice(0, max);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let raw;
  try { raw = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid request' }); }

  // Honeypot: bots fill this hidden field, humans don't
  if (raw.website) return json(200, { ok: true });

  const d = {
    fullName: clean(raw.fullName, 120),
    company: clean(raw.company, 120),
    email: clean(raw.email, 200),
    phone: clean(raw.phone, 40),
    process: clean(raw.process, 2000),
    employees: clean(raw.employees, 20),
    budget: clean(raw.budget, 60),
    consent: raw.consent === true
  };

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email);
  if (!d.fullName || !d.company || !emailOk || !d.phone || !d.process || !d.employees || !d.budget) {
    return json(400, { error: 'Please complete all required fields.' });
  }

  const { BREVO_API_KEY, NOTIFY_EMAIL, SENDER_EMAIL, BREVO_LIST_ID } = process.env;
  if (!BREVO_API_KEY || !NOTIFY_EMAIL || !SENDER_EMAIL) {
    console.error('Missing environment variables');
    return json(500, { error: 'Server not configured.' });
  }

  const headers = { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' };
  const sender = { name: 'TMLE Automations', email: SENDER_EMAIL };
  const firstName = d.fullName.split(' ')[0];

  const post = (path, body) => fetch(BREVO + path, { method: 'POST', headers, body: JSON.stringify(body) });

  // 1) Notification to you (this one must succeed)
  const rows = [
    ['Full Name', d.fullName], ['Company', d.company], ['Email', d.email], ['Phone', d.phone],
    ['Process to automate', d.process], ['Employees', d.employees], ['Monthly budget', d.budget],
    ['Marketing consent', d.consent ? 'Yes' : 'No']
  ].map(([k, v]) => `<tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f8fafc"><b>${k}</b></td><td style="padding:8px 12px;border:1px solid #e5e7eb">${esc(v)}</td></tr>`).join('');

  const notify = await post('/smtp/email', {
    sender,
    to: [{ email: NOTIFY_EMAIL }],
    replyTo: { email: d.email, name: d.fullName },
    subject: `New Automation Blueprint request: ${d.company}`,
    htmlContent: `<h2>New request from the website</h2><table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">${rows}</table>`
  });

  if (!notify.ok) {
    console.error('Brevo notification failed:', notify.status, await notify.text());
    return json(502, { error: 'Could not send your request.' });
  }

  // 2) Best-effort: confirmation email to the client + CRM contact
  const tasks = [
    post('/smtp/email', {
      sender,
      to: [{ email: d.email, name: d.fullName }],
      replyTo: { email: NOTIFY_EMAIL },
      subject: 'We received your request | TMLE Automations',
      htmlContent: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.6">
        <p>Hi ${esc(firstName)},</p>
        <p>Thanks for reaching out! We've received your request for a free Automation Blueprint for <b>${esc(d.company)}</b>.</p>
        <p>We'll review your answers and get back to you within one business day.</p>
        <p>Best regards,<br>TMLE Automations<br>Nanaimo, BC</p></div>`
    })
  ];

  // Only add to your contact list when the client gave consent (CASL)
  if (d.consent) {
    tasks.push(post('/contacts', {
      email: d.email,
      updateEnabled: true,
      attributes: {
        FIRSTNAME: firstName,
        LASTNAME: d.fullName.split(' ').slice(1).join(' '),
        COMPANY: d.company,
        PHONE: d.phone,
        EMPLOYEES: d.employees,
        BUDGET: d.budget,
        PROCESS: d.process.slice(0, 1000)
      },
      ...(BREVO_LIST_ID ? { listIds: [Number(BREVO_LIST_ID)] } : {})
    }));
  }

  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') console.error('Brevo task error:', r.reason);
    else if (!r.value.ok) console.error('Brevo task failed:', r.value.status, await r.value.text());
  }

  return json(200, { ok: true });
};
