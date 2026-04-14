// xero-callback.js — handles OAuth callback, stores tokens in Supabase

exports.handler = async (event) => {
  const { code, error } = event.queryStringParameters || {};

  if (error) return { statusCode: 302, headers: { Location: 'https://panelprocrm.netlify.app?xero=error' }, body: '' };

  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const redirectUri  = 'https://panelprocrm.netlify.app/xero-callback';
  const supabaseUrl  = 'https://isxycoxqlummscxmdckj.supabase.co';
  const supabaseKey  = process.env.SUPABASE_SERVICE_KEY;

  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    // Exchange code for tokens
    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('Token exchange failed: ' + JSON.stringify(tokenData));

    const { access_token, refresh_token, expires_in } = tokenData;
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // Get tenant
    const tenantsRes  = await fetch('https://api.xero.com/connections', { headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' } });
    const tenantsData = await tenantsRes.json();
    const tenant      = tenantsData[0];
    if (!tenant) throw new Error('No Xero tenants found');

    // Store in Supabase
    await fetch(`${supabaseUrl}/rest/v1/xero_tokens`, {
      method: 'POST',
      headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ tenant_id: tenant.tenantId, tenant_name: tenant.tenantName, access_token, refresh_token, expires_at: expiresAt, updated_at: new Date().toISOString() })
    });

    return { statusCode: 302, headers: { Location: 'https://panelprocrm.netlify.app?xero=connected' }, body: '' };

  } catch (e) {
    console.error('Xero callback error:', e.message);
    return { statusCode: 302, headers: { Location: `https://panelprocrm.netlify.app?xero=error&msg=${encodeURIComponent(e.message)}` }, body: '' };
  }
};
