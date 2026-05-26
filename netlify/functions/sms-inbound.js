// sms-inbound.js — Twilio webhook for inbound SMS replies
// Set this URL in Twilio: https://panelprocrm.netlify.app/.netlify/functions/sms-inbound
// Twilio sends a POST when a customer replies to your SMS

const SUPABASE_URL = 'https://isxycoxqlummscxmdckj.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return { statusCode: 500, body: 'Missing config' };

  // Parse Twilio's form-encoded body
  const params = new URLSearchParams(event.body || '');
  const from = params.get('From') || '';      // Customer's phone e.g. +447700123456
  const body = params.get('Body') || '';      // Message text
  const to   = params.get('To') || '';        // Your Twilio number

  if (!from || !body) {
    return { statusCode: 200, headers: { 'Content-Type': 'text/xml' }, body: '<Response/>' };
  }

  // Normalise phone — strip spaces, convert 07xxx to +447xxx
  const normPhone = (p) => {
    let n = p.replace(/\s/g, '');
    if (n.startsWith('07')) n = '+44' + n.slice(1);
    return n;
  };
  const fromNorm = normPhone(from);

  try {
    // Find the most recent booked or quoted job with this phone number
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/jobs?customer_phone=eq.${encodeURIComponent(fromNorm)}&status=in.(booked,quoted,completed)&order=created_at.desc&limit=1`,
      { headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` } }
    );
    const jobs = await res.json();

    if (jobs && jobs.length) {
      const job = jobs[0];
      // Append inbound message to sms_inbox field
      const now = new Date().toISOString();
      const existing = job.sms_inbox || '';
      const newEntry = `[${now.slice(0,16).replace('T',' ')}] Customer: ${body}`;
      const updated = existing ? existing + '\n' + newEntry : newEntry;

      await fetch(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${job.id}`, {
        method: 'PATCH',
        headers: {
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ sms_inbox: updated, sms_unread: true })
      });

      console.log(`✅ SMS reply from ${fromNorm} appended to job ${job.id} (${job.customer_name})`);
    } else {
      // No matching job — log it anyway
      console.log(`⚠ SMS from unknown number ${fromNorm}: ${body}`);
    }
  } catch(e) {
    console.error('Inbound SMS error:', e.message);
  }

  // Always return empty TwiML response (no auto-reply)
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/xml' },
    body: '<Response/>'
  };
};
