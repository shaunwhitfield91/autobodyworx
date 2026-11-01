// send-ready-sms.js — texts the customer that their car is ready for collection.
// Called by PanelPro when QC is passed. The browser sends { jobId } plus the logged-in
// user's token; everything else (phone number, name, vehicle) is read from the database
// here, so the page can't make this text anyone except the customer on that job.

const SUPABASE_URL = 'https://isxycoxqlummscxmdckj.supabase.co';
const BUSINESS_PHONE = '07548841212';

const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_FROM_NUMBER;
  if (!serviceKey || !twilioSid || !twilioToken || !twilioFrom) {
    return json(500, { error: 'Twilio / Supabase credentials are not configured in Netlify' });
  }

  // 1. Only logged-in PanelPro users may trigger a text
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const userToken = auth.replace(/^Bearer\s+/i, '');
  if (!userToken) return json(401, { error: 'Not logged in' });
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${userToken}` }
  });
  if (!who.ok) return json(401, { error: 'Login expired — refresh PanelPro and try again' });

  let jobId;
  try { jobId = parseInt(JSON.parse(event.body || '{}').jobId, 10); } catch (e) { /* handled below */ }
  if (!jobId) return json(400, { error: 'Missing jobId' });

  // 2. Read the job server-side
  const jr = await fetch(
    `${SUPABASE_URL}/rest/v1/jobs?id=eq.${jobId}&select=id,customer_name,customer_phone,vehicle,ready_sms_sent_at`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
  );
  const jobs = await jr.json();
  const job = Array.isArray(jobs) ? jobs[0] : null;
  if (!job) return json(404, { error: 'Job not found' });
  if (job.ready_sms_sent_at) return json(200, { success: true, alreadySent: true });
  if (!job.customer_phone) return json(422, { error: 'This job has no customer phone number' });

  // 3. Build and send
  const first = (job.customer_name || '').split(' ')[0] || 'there';
  const car = job.vehicle ? `your ${job.vehicle}` : 'your vehicle';
  const body = `Hi ${first}, good news - ${car} is finished and ready for collection from Auto Bodyworx. Please call ${BUSINESS_PHONE} to arrange a time to collect. Do not reply to this number - use ${BUSINESS_PHONE}`;

  let phone = job.customer_phone.replace(/\s/g, '').replace(/^0/, '+44');
  if (!phone.startsWith('+')) phone = '+44' + phone;

  const tw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ To: phone, From: twilioFrom, Body: body }).toString()
  });
  const sent = await tw.json();
  if (sent.error_code || !sent.sid) {
    return json(502, { error: `Text failed: ${sent.message || 'Twilio error ' + sent.error_code}` });
  }

  // 4. Record it so it can never go twice
  const pr = await fetch(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${jobId}`, {
    method: 'PATCH',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ ready_sms_sent_at: new Date().toISOString() })
  });
  if (!pr.ok) return json(200, { success: true, sid: sent.sid, recordFailed: true });

  return json(200, { success: true, sid: sent.sid });
};
