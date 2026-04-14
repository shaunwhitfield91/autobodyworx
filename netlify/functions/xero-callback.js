// xero-callback.js — handles OAuth callback, stores tokens in Supabase
const https = require('https');

function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const opts = {
      method: 'POST',
      headers: { 'Content-Length': Buffer.byteLength(body), ...headers }
    };
    const req = https.request(url, opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const { code, error } = event.queryStringParameters || {};

  if (error) {
    return { statusCode: 302, headers: { Location: 'https://panelprocrm.netlify.app?xero=error' }, body: '' };
  }

  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri  = 'https://panelprocrm.netlify.app/xero-callback';
  const supabaseUrl  = 'https://isxycoxqlummscxmdckj.supabase.co';
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY;

  try {
    // 1. Exchange code for tokens
    const creds   = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenBody = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri
    }).toString();

    const tokenRes = await httpsPost('https://identity.xero.com/connect/token', tokenBody, {
      'Authorization': `Basic ${creds}`,
      'Content-Type':  'application/x-www-form-urlencoded'
    });

    if (tokenRes.status !== 200) throw new Error('Token exchange failed: ' + JSON.stringify(tokenRes.body));

    const { access_token, refresh_token, expires_in } = tokenRes.body;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // 2. Get tenant ID
    const tenantsRes = await httpsGet('https://api.xero.com/connections', {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type':  'application/json'
    });

    const tenant = tenantsRes.body[0];
    if (!tenant) throw new Error('No Xero tenants found');

    // 3. Store tokens in Supabase (xero_tokens table)
    await httpsPost(
      `${supabaseUrl}/rest/v1/xero_tokens`,
      { tenant_id: tenant.tenantId, tenant_name: tenant.tenantName, access_token, refresh_token, expires_at: expiresAt, updated_at: new Date().toISOString() },
      {
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates'
      }
    );

    return { statusCode: 302, headers: { Location: 'https://panelprocrm.netlify.app?xero=connected' }, body: '' };

  } catch (e) {
    console.error('Xero callback error:', e.message);
    return { statusCode: 302, headers: { Location: `https://panelprocrm.netlify.app?xero=error&msg=${encodeURIComponent(e.message)}` }, body: '' };
  }
};
