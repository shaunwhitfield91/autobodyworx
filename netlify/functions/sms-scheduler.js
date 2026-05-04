// sms-scheduler.js — Runs daily at 08:00 UTC
// Sends appointment reminders 3 days before booking
// Sends review requests 2 days after job completion

const SUPABASE_URL = 'https://isxycoxqlummscxmdckj.supabase.co';
const WORKSHOP_ADDRESS = 'our Workshop, Shefford Woodlands';
const BUSINESS_PHONE = '07548841212';
const REVIEW_LINK = 'http://g.page/r/CScvy0YbLiBtEBE/review';

async function sbFetch(path, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`
    }
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sbPatch(table, data, query, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  return res.json();
}

async function sendSMS(to, body, twilioSid, twilioToken, twilioFrom) {
  // Clean phone number to E.164 format
  let phone = to.replace(/\s/g, '').replace(/^0/, '+44');
  if (!phone.startsWith('+')) phone = '+44' + phone;

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        To: phone,
        From: twilioFrom,
        Body: body
      }).toString()
    }
  );
  const data = await res.json();
  if (data.error_code) throw new Error(`Twilio error ${data.error_code}: ${data.message}`);
  return data.sid;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T12:00:00'); // local noon to avoid timezone issues
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

function buildReminderMessage(job) {
  const date = formatDate(job.booking_date);
  const location = job.job_location === 'mobile'
    ? (job.customer_address || 'your address')
    : WORKSHOP_ADDRESS;
  return `*Appointment Reminder* with Auto Bodyworx on ${date} at ${location}. Please contact ${BUSINESS_PHONE} if you have any issues.`;
}

function buildReviewMessage(job) {
  return `Hi ${(job.customer_name || '').split(' ')[0] || 'there'}, thank you for choosing Auto Bodyworx! We hope you're happy with your repair. We'd really appreciate a quick Google review — it only takes a minute and helps us a lot: ${REVIEW_LINK}`;
}

exports.handler = async (event) => {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_FROM_NUMBER;

  if (!serviceKey || !twilioSid || !twilioToken || !twilioFrom) {
    console.error('Missing env vars — check SUPABASE_SERVICE_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER');
    return { statusCode: 500, body: 'Missing configuration' };
  }

  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // 3 days from now (for reminders)
  const reminderDate = new Date(now);
  reminderDate.setDate(reminderDate.getDate() + 3);
  const reminderDateStr = reminderDate.toISOString().split('T')[0];

  // 2 days ago (for review requests — signed_off_at 2 days ago)
  const reviewDate = new Date(now);
  reviewDate.setDate(reviewDate.getDate() - 2);
  const reviewDateStr = reviewDate.toISOString().split('T')[0];

  let remindersSent = 0, reviewsSent = 0, errors = [];

  // ── APPOINTMENT REMINDERS ─────────────────────────────────────────────────
  // Find booked jobs where booking_date = 3 days from now
  // and sms_reminder_sent is not true, and customer has a phone
  try {
    const reminders = await sbFetch(
      `jobs?status=eq.booked&booking_date=eq.${reminderDateStr}&sms_reminder_sent=is.null&customer_phone=not.is.null&select=*`,
      serviceKey
    );

    console.log(`Reminder candidates: ${reminders.length} jobs on ${reminderDateStr}`);

    for (const job of reminders) {
      if (!job.customer_phone) continue;
      // Skip diary entries (holidays etc)
      if (['Holiday','Appointment','Van day','Diary entry'].includes(job.source)) continue;

      try {
        const msg = buildReminderMessage(job);
        console.log(`Sending reminder to ${job.customer_name} (${job.customer_phone}): ${msg}`);
        const sid = await sendSMS(job.customer_phone, msg, twilioSid, twilioToken, twilioFrom);
        await sbPatch('jobs', { sms_reminder_sent: true, sms_reminder_at: now.toISOString() },
          `id=eq.${job.id}`, serviceKey);
        console.log(`✅ Reminder sent: ${job.customer_name} — SID ${sid}`);
        remindersSent++;
      } catch (e) {
        console.error(`❌ Reminder failed for ${job.customer_name}: ${e.message}`);
        errors.push(`Reminder to ${job.customer_name}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('Failed to fetch reminder jobs:', e.message);
    errors.push('Fetch reminders: ' + e.message);
  }

  // ── REVIEW REQUESTS ───────────────────────────────────────────────────────
  // Find completed jobs where signed_off_at was 2 days ago
  // and sms_review_sent is not true
  try {
    const reviewStart = reviewDateStr + 'T00:00:00';
    const reviewEnd = reviewDateStr + 'T23:59:59';
    const reviews = await sbFetch(
      `jobs?status=eq.completed&signed_off_at=gte.${reviewStart}&signed_off_at=lte.${reviewEnd}&sms_review_sent=is.null&customer_phone=not.is.null&select=*`,
      serviceKey
    );

    console.log(`Review candidates: ${reviews.length} jobs completed on ${reviewDateStr}`);

    for (const job of reviews) {
      if (!job.customer_phone) continue;
      if (['Holiday','Appointment','Van day','Diary entry'].includes(job.source)) continue;

      try {
        const msg = buildReviewMessage(job);
        console.log(`Sending review to ${job.customer_name} (${job.customer_phone})`);
        const sid = await sendSMS(job.customer_phone, msg, twilioSid, twilioToken, twilioFrom);
        await sbPatch('jobs', { sms_review_sent: true, sms_review_at: now.toISOString() },
          `id=eq.${job.id}`, serviceKey);
        console.log(`✅ Review sent: ${job.customer_name} — SID ${sid}`);
        reviewsSent++;
      } catch (e) {
        console.error(`❌ Review failed for ${job.customer_name}: ${e.message}`);
        errors.push(`Review to ${job.customer_name}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('Failed to fetch review jobs:', e.message);
    errors.push('Fetch reviews: ' + e.message);
  }

  const result = {
    date: today,
    reminders_sent: remindersSent,
    reviews_sent: reviewsSent,
    errors: errors.length ? errors : null
  };
  console.log('SMS scheduler complete:', JSON.stringify(result));
  return { statusCode: 200, body: JSON.stringify(result) };
};
