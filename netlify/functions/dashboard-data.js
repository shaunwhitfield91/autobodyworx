// dashboard-data.js — Public endpoint for workshop dashboard
// Returns today + tomorrow jobs and time entries — no auth required
// Uses service key server-side so anon allowlist doesn't matter

const SUPABASE_URL = 'https://isxycoxqlummscxmdckj.supabase.co';

exports.handler = async (event) => {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return { statusCode: 500, body: 'Missing config' };

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const tmrw = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
  const rangeStart = new Date(now.getTime() - 7*86400000).toISOString().split('T')[0];

  const headers = {
    'apikey': serviceKey,
    'Authorization': `Bearer ${serviceKey}`
  };

  try {
    const [jobsRes, entriesRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/jobs?select=id,customer_name,vehicle,panels,booking_date,booking_time,duration,duration_days,assigned_tech,job_location,status,cd_required,source&archived=eq.false&status=neq.declined&booking_date=gte.${rangeStart}&booking_date=lte.${tmrw}&order=booking_date.asc,booking_time.asc`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/time_entries?date=eq.${today}&select=tech_name,clock_in,clock_out`, { headers })
    ]);

    const jobs = await jobsRes.json();
    const entries = await entriesRes.json();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      },
      body: JSON.stringify({ jobs, entries, today, tmrw, dayAfter })
    };
  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
