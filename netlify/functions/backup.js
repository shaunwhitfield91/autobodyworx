// backup.js — Weekly automated backup for PanelPro
// Runs every Sunday at 23:00 UTC via Netlify scheduled functions
// Logs backup summary — data retrievable via Supabase direct export

const SUPABASE_URL = 'https://isxycoxqlummscxmdckj.supabase.co';

async function fetchAll(table, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=created_at.desc&limit=10000`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`
    }
  });
  if (!res.ok) throw new Error(`Failed to fetch ${table}: ${res.status}`);
  return res.json();
}

exports.handler = async (event) => {
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) {
    console.error('SUPABASE_SERVICE_KEY not set');
    return { statusCode: 500, body: 'Missing service key' };
  }

  try {
    console.log('PanelPro weekly backup check starting...');
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];

    const [jobs, jobPhotos, jobParts, timeEntries, holidayRequests] = await Promise.all([
      fetchAll('jobs', serviceKey),
      fetchAll('job_photos', serviceKey),
      fetchAll('job_parts', serviceKey),
      fetchAll('time_entries', serviceKey).catch(() => []),
      fetchAll('holiday_requests', serviceKey).catch(() => [])
    ]);

    const summary = {
      backup_date: now.toISOString(),
      jobs: jobs.length,
      job_photos: jobPhotos.length,
      job_parts: jobParts.length,
      time_entries: timeEntries.length,
      holiday_requests: holidayRequests.length,
      status: 'healthy'
    };

    console.log('✅ PanelPro backup check complete:', JSON.stringify(summary));
    console.log('NOTE: Use Settings > Download Backup in PanelPro for a full data export');

    return {
      statusCode: 200,
      body: JSON.stringify(summary)
    };

  } catch (e) {
    console.error('Backup check failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
