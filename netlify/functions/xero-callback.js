// xero-callback.js — handles OAuth callback, stores tokens in Supabase
const https = require('https');

function httpsRequest(method, url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = data ? (typeof data === 'string' ? data : JSON.stringify(data)) : '';
    const opts = {
      method,
      headers: { ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers }
    };
    const req = https.request(url, opts, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
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

    const tokenRes = await httpsRequest('POST', 'https://identity.xero.com/connect/token', tokenBody, {
      'Authorization': `Basic ${creds}`,
      'Content-Type':  'application/x-www-form-urlencoded'
    });

    if (tokenRes.status !== 200) throw new Error('Token exchange failed: ' + JSON.stringify(tokenRes.body));

    const { access_token, refresh_token, expires_in } = tokenRes.body;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // 2. Get tenant ID
    const tenantsRes = await httpsRequest('GET', 'https://api.xero.com/connections', null, {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type':  'application/json'
    });

    const tenant = (tenantsRes.body || [])[0];
    if (!tenant) throw new Error('No Xero tenants found');

    // 3. Store tokens in Supabase (xero_tokens table).
    // The table has no unique constraint, so upsert/merge-duplicates can't reliably
    // target the existing row — delete any existing rows first, then insert fresh,
    // and check both calls actually succeeded instead of assuming success.
    const delRes = await httpsRequest('DELETE', `${supabaseUrl}/rest/v1/xero_tokens?tenant_id=not.is.null`, null, {
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer':        'return=minimal'
    });
    if (delRes.status >= 300) throw new Error('Failed to clear old Xero token: ' + JSON.stringify(delRes.body));

    const insRes = await httpsRequest('POST', `${supabaseUrl}/rest/v1/xero_tokens`,
      { tenant_id: tenant.tenantId, tenant_name: tenant.tenantName, access_token, refresh_token, expires_at: expiresAt, updated_at: new Date().toISOString() },
      {
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=minimal'
      }
    );
    if (insRes.status >= 300) throw new Error('Failed to save new Xero token: ' + JSON.stringify(insRes.body));

    return { statusCode: 302, headers: { Location: 'https://panelprocrm.netlify.app?xero=connected' }, body: '' };

  } catch (e) {
    console.error('Xero callback error:', e.message);
    return { statusCode: 302, headers: { Location: `https://panelprocrm.netlify.app?xero=error&msg=${encodeURIComponent(e.message)}` }, body: '' };
  }
};
