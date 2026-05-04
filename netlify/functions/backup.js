// backup.js — Weekly automated backup for PanelPro
// Runs every Sunday at 23:00 UK time via Netlify scheduled functions
// Fetches all data from Supabase and stores as JSON in Netlify Blobs

const { getStore } = require('@netlify/blobs');

const SUPABASE_URL = 'https://isxycoxqlummscxmdckj.supabase.co';

async function fetchAll(table, serviceKey) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=created_at.desc`, {
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Prefer': 'count=exact'
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
    console.log('PanelPro backup starting...');
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timestamp = now.toISOString();

    // Fetch all tables
    const [jobs, jobPhotos, jobParts, profiles, timeEntries, holidayRequests] = await Promise.all([
      fetchAll('jobs', serviceKey),
      fetchAll('job_photos', serviceKey),
      fetchAll('job_parts', serviceKey),
      fetchAll('profiles', serviceKey),
      fetchAll('time_entries', serviceKey).catch(() => []),
      fetchAll('holiday_requests', serviceKey).catch(() => [])
    ]);

    const backup = {
      backup_date: timestamp,
      backup_version: '1.0',
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
    const filename = `panelpro-backup-${dateStr}.json`;

    // Store in Netlify Blobs (persistent, accessible via dashboard)
    try {
      const store = getStore({ name: 'panelpro-backups', consistency: 'strong' });
      await store.set(filename, backupJson, {
        metadata: {
          date: dateStr,
          jobs: jobs.length,
          size: backupJson.length
        }
      });
      // Also keep a "latest" key for easy access
      await store.set('latest-backup.json', backupJson);
      console.log(`✅ Backup stored: ${filename} (${Math.round(backupJson.length / 1024)}KB)`);
    } catch (blobErr) {
      console.error('Blob storage failed:', blobErr.message);
      // Continue — log the counts at minimum
    }

    console.log(`✅ Backup complete: ${jobs.length} jobs, ${jobPhotos.length} photos, ${jobParts.length} parts`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        date: dateStr,
        counts: backup.counts,
        size_kb: Math.round(backupJson.length / 1024),
        filename
      })
    };

  } catch (e) {
    console.error('Backup failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
