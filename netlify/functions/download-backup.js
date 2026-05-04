// download-backup.js — Manual backup download trigger
// Called from PanelPro Settings page — admin only
// Returns backup as downloadable JSON file

const SUPABASE_URL = 'https://isxycoxqlummscxmdckj.supabase.co';

async function fetchAll(table, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=created_at.desc`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`
    }
  });
  if (!res.ok) return [];
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!serviceKey) return { statusCode: 500, body: JSON.stringify({ error: 'Missing service key' }) };

  try {
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];

    const [jobs, jobPhotos, jobParts, profiles, timeEntries, holidayRequests] = await Promise.all([
      fetchAll('jobs', serviceKey),
      fetchAll('job_photos', serviceKey),
      fetchAll('job_parts', serviceKey),
      fetchAll('profiles', serviceKey),
      fetchAll('time_entries', serviceKey),
      fetchAll('holiday_requests', serviceKey)
    ]);

    const backup = {
      backup_date: now.toISOString(),
      backup_type: 'manual',
      project: 'PanelPro — Auto Bodyworx',
      counts: {
        jobs: jobs.length,
        job_photos: jobPhotos.length,
        job_parts: jobParts.length,
        profiles: profiles.length,
        time_entries: timeEntries.length,
        holiday_requests: holidayRequests.length
      },
      data: { jobs, job_photos: jobPhotos, job_parts: jobParts, profiles, time_entries: timeEntries, holiday_requests: holidayRequests }
    };

    const backupJson = JSON.stringify(backup, null, 2);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="panelpro-backup-${dateStr}.json"`,
        'Access-Control-Allow-Origin': '*'
      },
      body: backupJson
    };

  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
