// enquiry-lib.js — shared code for importing HubSpot enquiry emails into PanelPro.
// Used by enquiry-import.js (runs every 5 minutes) and enquiry-import-test.js (manual dry run).
//
// Flow: read HubSpot "new submission" emails from the Microsoft 365 mailbox -> pull out the labelled
// fields -> download the uploaded photos from HubSpot -> create a PENDING job in PanelPro (price blank).
// Anything missing or failed is flagged on the job (needs_check) so nothing is lost silently.

const SUPABASE_URL = 'https://isxycoxqlummscxmdckj.supabase.co';
const HUBSPOT_SENDER = 'noreply@notifications.hubspot.com';
const MAX_PER_RUN = 3;          // keep each run short; the rest are picked up 5 minutes later
const TIME_BUDGET_MS = 20000;   // stop starting new enquiries after this long

// ── Parsing ────────────────────────────────────────────────────────────────
const LABELS = {
  'first name': 'first', 'last name': 'last', 'email': 'email', 'phone number': 'phone',
  'address': 'address', 'car make, model & year': 'vehicle', 'car make, model and year': 'vehicle',
  'damage description': 'damage', 'image upload': 'images'
};
const STOP_LINES = ['view submission in hubspot'];

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}
function htmlToLines(html) {
  let t = html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|td|th|h[1-6]|li|table|a)>/gi, '\n').replace(/<[^>]+>/g, '');
  return decodeEntities(t).split(/\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function extractLinks(html) {
  const out = [];
  const re = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ href: decodeEntities(m[1]), text: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim() });
  return out;
}
function normalisePhone(p) {
  if (!p) return '';
  p = p.replace(/[\s\-()]/g, '');
  if (p.startsWith('+44')) p = '0' + p.slice(3);
  else if (p.startsWith('0044')) p = '0' + p.slice(4);
  else if (/^44\d{10}$/.test(p)) p = '0' + p.slice(2);
  return p;
}

// Shrink phone photos to the same size PanelPro uses itself (1200px, quality 75) so the job list stays quick.
// If the image library isn't available, the original is stored instead.
let _sharp; let _sharpTried = false;
async function shrink(buf, type) {
  if (!_sharpTried) { _sharpTried = true; try { _sharp = require('sharp'); } catch (e) { _sharp = null; } }
  if (!_sharp) return { buf, type };
  try {
    const out = await _sharp(buf).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    return { buf: out, type: 'image/jpeg' };
  } catch (e) { return { buf, type }; }   // e.g. a format it can't read — keep the original
}

function parseEnquiry(html) {
  const lines = htmlToLines(html);
  const f = {};
  let cur = null;
  for (const line of lines) {
    const low = line.toLowerCase();
    if (STOP_LINES.includes(low)) { cur = null; continue; }
    if (LABELS[low]) { cur = LABELS[low]; if (!(cur in f)) f[cur] = []; continue; }
    if (cur) f[cur].push(line);
  }
  const val = k => (f[k] || []).join(' ').trim();
  // photo links = anchors whose visible text looks like an image filename
  const images = extractLinks(html).filter(l => /\.(jpe?g|png|gif|webp|heic|heif)\b/i.test(l.text));
  const first = val('first'), last = val('last');
  return {
    name: [first, last].filter(Boolean).join(' '),
    first, last,
    email: val('email').toLowerCase(),
    phone: normalisePhone(val('phone')),
    address: val('address'),
    vehicle: val('vehicle'),
    damage: (f.damage || []).join('\n').trim(),
    images
  };
}
function missingFields(e) {
  const m = [];
  if (!e.first) m.push('first name'); if (!e.last) m.push('last name');
  if (!e.email) m.push('email'); if (!e.phone) m.push('mobile number');
  if (!e.address) m.push('address'); if (!e.vehicle) m.push('car make/model');
  if (!e.damage) m.push('damage description');
  if (!e.images.length) m.push('photos');
  return m;
}

// ── HubSpot photo download ─────────────────────────────────────────────────
const HS_HOST = /(^|\.)(hubspot\.com|hubapi\.com|hubspotusercontent\d*-?[a-z0-9]*\.net|hubspotlinks\.com|hs-sites\.com|hsforms\.com|hsforms\.net)$/i;
function isHubspotUrl(u) { try { return HS_HOST.test(new URL(u).hostname); } catch (e) { return false; } }

async function fetchBytes(url, headers, redirect) {
  const res = await fetch(url, { headers: headers || {}, redirect: redirect || 'follow' });
  return res;
}
function looksLikeImage(res) { return /^image\//i.test(res.headers.get('content-type') || ''); }

// Tries several ways of getting the real image bytes. Returns { buf, type, how, tried: [...] }
async function downloadHubspotImage(href, token) {
  const tried = [];
  const auth = { Authorization: 'Bearer ' + token };
  const finish = async (res, how) => {
    const ab = await res.arrayBuffer();
    return { buf: Buffer.from(ab), type: (res.headers.get('content-type') || 'image/jpeg').split(';')[0], how, tried };
  };
  // 1) the link itself with our token (only ever sent to HubSpot-owned hosts)
  if (isHubspotUrl(href)) {
    try {
      const r = await fetchBytes(href, auth);
      tried.push('direct:' + r.status + ':' + (r.headers.get('content-type') || '').split(';')[0]);
      if (r.ok && looksLikeImage(r)) return await finish(r, 'direct');
    } catch (e) { tried.push('direct:ERR ' + e.message); }
  }
  // 2) find a file id in the link and ask HubSpot for a signed URL
  const ids = [...new Set((decodeURIComponent(href).match(/\b\d{8,}\b/g) || []))];
  for (const id of ids) {
    try {
      const r = await fetch(`https://api.hubapi.com/form-integrations/v1/uploaded-files/signed-url-redirect/${id}`, { headers: auth, redirect: 'manual' });
      tried.push('signed-url-redirect/' + id + ':' + r.status);
      const loc = r.headers.get('location');
      if (loc) { const img = await fetch(loc); tried.push('  ->' + img.status); if (img.ok && looksLikeImage(img)) return await finish(img, 'form-uploaded-files'); }
      else if (r.ok && looksLikeImage(r)) return await finish(r, 'form-uploaded-files');
    } catch (e) { tried.push('signed-url-redirect:ERR ' + e.message); }
    try {
      const r = await fetch(`https://api.hubapi.com/files/v3/files/${id}/signed-url`, { headers: auth });
      tried.push('files-v3-signed-url/' + id + ':' + r.status);
      if (r.ok) { const j = await r.json(); if (j.url) { const img = await fetch(j.url); tried.push('  ->' + img.status); if (img.ok && looksLikeImage(img)) return await finish(img, 'files-v3'); } }
    } catch (e) { tried.push('files-v3:ERR ' + e.message); }
  }
  return { buf: null, type: null, how: null, tried };
}

// ── Microsoft Graph ────────────────────────────────────────────────────────
async function graphToken(env) {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials'
  });
  const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, { method: 'POST', body });
  const j = await res.json();
  if (!res.ok || !j.access_token) throw new Error('Microsoft sign-in failed: ' + (j.error_description || j.error || res.status));
  return j.access_token;
}
async function listEnquiryEmails(env, token, sinceIso) {
  const filter = `receivedDateTime ge ${sinceIso} and from/emailAddress/address eq '${HUBSPOT_SENDER}'`;
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MS_MAILBOX)}/messages` +
    `?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime asc&$top=25` +
    `&$select=id,internetMessageId,subject,receivedDateTime,body`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Prefer: 'outlook.body-content-type="html"' } });
  const j = await res.json();
  if (!res.ok) throw new Error('Could not read the mailbox: ' + (j.error?.message || res.status));
  // HubSpot words the subject differently for a first-time contact ("new submission") and for someone it already
  // knows ("Contact reconversion by submitting …"), so accept any notification about the Enquiry form.
  // …but only if it's about the Enquiry form (in the subject or the email text), so other HubSpot forms are ignored.
  return (j.value || []).filter(m => /(new submission|reconversion)/i.test(m.subject || '') &&
    (/enquiry form/i.test(m.subject || '') || /enquiry form/i.test((m.body && m.body.content) || '')));
}

// ── Supabase ───────────────────────────────────────────────────────────────
function sbHeaders(key, extra) { return Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, extra || {}); }
async function sb(method, path, key, body, prefer) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers: sbHeaders(key, prefer ? { Prefer: prefer } : {}), body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${txt}`);
  return txt ? JSON.parse(txt) : null;
}
async function uploadPhoto(key, jobId, buf, type) {
  const ext = /png/i.test(type) ? 'png' : /webp/i.test(type) ? 'webp' : 'jpg';
  const path = `job-${jobId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/job-photos/${path}`, {
    method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': type || 'image/jpeg' }, body: buf
  });
  if (!res.ok) throw new Error('Photo upload failed: ' + res.status + ' ' + (await res.text()));
  await sb('POST', 'job_photos', key, { job_id: jobId, storage_path: path, photo_type: 'damage' });
  return path;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function runImport(rawEnv, opts) {
  opts = opts || {};
  // pasted values often carry a stray space or line break — remove them
  const env = {}; Object.keys(rawEnv || {}).forEach(k => { env[k] = typeof rawEnv[k] === 'string' ? rawEnv[k].trim() : rawEnv[k]; });
  const dry = !!opts.dry;
  const need = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_MAILBOX', 'HUBSPOT_TOKEN', 'SUPABASE_SERVICE_KEY', 'ENQUIRY_IMPORT_FROM'];
  const missing = need.filter(k => !env[k]);
  if (missing.length) return { ok: false, error: 'Not set up yet — missing settings: ' + missing.join(', ') };
  // a manual dry run may look further back; a real import never does
  const since = new Date((dry && opts.since) ? opts.since : env.ENQUIRY_IMPORT_FROM);
  if (isNaN(since)) return { ok: false, error: 'ENQUIRY_IMPORT_FROM is not a valid date/time' };

  const started = Date.now();
  const key = env.SUPABASE_SERVICE_KEY;
  const report = { ok: true, dry, checked: 0, created: [], skipped: 0, problems: [] };
  // is the photo-shrinking tool installed? (if false, photos are saved at full size)
  try { require('sharp'); report.imageShrink = true; } catch (e) { report.imageShrink = false; report.imageShrinkError = String(e.message).split('\n')[0].slice(0, 200); }
  const gt = await graphToken(env);
  const mails = await listEnquiryEmails(env, gt, since.toISOString());
  report.checked = mails.length;
  if (!mails.length) return report;

  // which of these have we already imported?
  const refs = mails.map(m => m.internetMessageId || m.id);
  const have = await sb('GET', `jobs?select=enquiry_ref&enquiry_ref=in.(${refs.map(r => '"' + r.replace(/"/g, '') + '"').join(',')})`, key);
  const done = new Set((have || []).map(r => r.enquiry_ref));

  let processed = 0;
  for (const m of mails) {
    const ref = m.internetMessageId || m.id;
    if (done.has(ref)) { report.skipped++; continue; }
    if (processed >= MAX_PER_RUN || Date.now() - started > TIME_BUDGET_MS) break;
    processed++;
    const e = parseEnquiry(m.body?.content || '');
    const problems = missingFields(e);
    const photos = []; const photoLog = [];
    const results = await Promise.all(e.images.map(async (img, i) => {
      try {
        const d = await downloadHubspotImage(img.href, env.HUBSPOT_TOKEN);
        if (d.buf && d.buf.length) { const sm = await shrink(d.buf, d.type); return { i, img, d, ok: true, sm }; }
        return { i, img, d, ok: false };
      } catch (err) { return { i, img, err }; }
    }));
    results.forEach(r => {
      if (r.err) { problems.push(`photo ${r.i + 1} failed: ${r.err.message}`); photoLog.push({ name: r.img.text, error: r.err.message }); return; }
      photoLog.push({ name: r.img.text, href: dry ? r.img.href : undefined, how: r.d.how, tried: r.d.tried, bytes: r.d.buf ? r.d.buf.length : 0, savedBytes: r.ok ? r.sm.buf.length : 0 });
      if (r.ok) photos.push({ name: r.img.text, buf: r.sm.buf, type: r.sm.type });
      else problems.push(`photo ${r.i + 1} (${r.img.text}) could not be downloaded`);
    });
    const item = { subject: m.subject, received: m.receivedDateTime, parsed: { name: e.name, email: e.email, phone: e.phone, address: e.address, vehicle: e.vehicle, damage: e.damage, photoLinks: e.images.length }, photoLog, problems };
    if (dry) { report.created.push(item); continue; }

    try {
      const notesParts = ['Enquiry received by HubSpot form on ' + new Date(m.receivedDateTime).toLocaleString('en-GB', { timeZone: 'Europe/London' }) + '.'];
      if (e.images.length && photos.length < e.images.length) notesParts.push('Photo links (open while logged into HubSpot): ' + e.images.map(i => i.href).join(' | '));
      const body = {
        customer_name: e.name || 'Unknown enquiry', customer_phone: e.phone || null, customer_email: e.email || null,
        customer_address: e.address || null, vehicle: e.vehicle || null, panels: e.damage || null,
        notes: notesParts.join('\n'), job_location: 'mobile', status: 'pending', source: 'hubspot', archived: false,
        enquiry_ref: ref, needs_check: true, check_reason: 'Import still running — if this stays, some photos may be missing'
      };
      const created = await sb('POST', 'jobs', key, body, 'return=representation');
      const jobId = created[0].id;
      const ups = await Promise.all(photos.map(p => uploadPhoto(key, jobId, p.buf, p.type).then(() => null, err => err.message)));
      const failed = ups.filter(Boolean).length;
      const allProblems = problems.slice(); if (failed) allProblems.push(failed + ' photo(s) failed to save');
      await sb('PATCH', `jobs?id=eq.${jobId}`, key, allProblems.length
        ? { needs_check: true, check_reason: 'Missing or failed: ' + allProblems.join('; ') }
        : { needs_check: false, check_reason: null });
      item.jobId = jobId; item.photosSaved = photos.length - failed;
      report.created.push(item);
    } catch (err) {
      report.problems.push({ subject: m.subject, error: err.message });
    }
  }
  return report;
}

module.exports = { runImport, parseEnquiry, missingFields, htmlToLines, normalisePhone, downloadHubspotImage, isHubspotUrl };
