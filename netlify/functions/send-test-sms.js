// send-test-sms.js — Manual test SMS trigger from PanelPro Settings
// Sends a sample reminder and review text to a specified number

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };

  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_FROM_NUMBER;

  if (!twilioSid || !twilioToken || !twilioFrom) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Twilio credentials not configured in Netlify environment variables' }) };
  }

  let to, type;
  try {
    const body = JSON.parse(event.body);
    to = body.to;
    type = body.type || 'reminder';
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!to) return { statusCode: 400, body: JSON.stringify({ error: 'No phone number provided' }) };

  // Clean to E.164
  let phone = to.replace(/\s/g, '').replace(/^0/, '+44');
  if (!phone.startsWith('+')) phone = '+44' + phone;

  const messages = {
    reminder: `*Appointment Reminder* with Auto Bodyworx on Thursday 5 June at our Workshop, Shefford Woodlands. Please contact 07548841212 if you have any issues.`,
    review: `Hi Shaun, thank you for choosing Auto Bodyworx! We hope you're happy with your repair. We'd really appreciate a quick Google review — it only takes a minute and helps us a lot: http://g.page/r/CScvy0YbLiBtEBE/review`
  };

  const body = messages[type] || messages.reminder;

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ To: phone, From: twilioFrom, Body: body }).toString()
      }
    );
    const data = await res.json();
    if (data.error_code) throw new Error(`Twilio error ${data.error_code}: ${data.message}`);
    return { statusCode: 200, body: JSON.stringify({ success: true, sid: data.sid, to: phone, type }) };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
