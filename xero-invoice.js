// xero-invoice.js — creates invoice or receipt in Xero from a completed PanelPro job
const https = require('https');

function httpsReq(method, url, data, headers) {
  return new Promise((resolve, reject) => {
    const body = data ? JSON.stringify(data) : null;
    const opts = {
      method,
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      }
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
    if (body) req.write(body);
    req.end();
  });
}

async function getTokens(supabaseUrl, supabaseKey) {
  const res = await httpsReq('GET', `${supabaseUrl}/rest/v1/xero_tokens?limit=1`, null, {
    'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`
  });
  if (!res.body || !res.body[0]) throw new Error('No Xero tokens found. Please reconnect Xero in Settings.');
  return res.body[0];
}

async function refreshIfNeeded(tokens, supabaseUrl, supabaseKey) {
  const expiresAt = new Date(tokens.expires_at);
  if (expiresAt > new Date(Date.now() + 60000)) return tokens.access_token; // still valid

  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).toString();
  const res  = await httpsReq('POST', 'https://identity.xero.com/connect/token', null, {
    'Authorization': `Basic ${creds}`,
    'Content-Type':  'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body)
  });

  // Need to send the body manually for this one
  const tokenRes = await new Promise((resolve, reject) => {
    const req = https.request('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    }, r => {
      let buf = ''; r.on('data', d => buf += d); r.on('end', () => resolve(JSON.parse(buf)));
    });
    req.on('error', reject);
    req.write(body); req.end();
  });

  const newExpiry = new Date(Date.now() + tokenRes.expires_in * 1000).toISOString();
  await httpsReq('PATCH',
    `${supabaseUrl}/rest/v1/xero_tokens?tenant_id=eq.${tokens.tenant_id}`,
    { access_token: tokenRes.access_token, refresh_token: tokenRes.refresh_token, expires_at: newExpiry, updated_at: new Date().toISOString() },
    { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
  );

  return tokenRes.access_token;
}

function buildDescription(job) {
  // Build "Body repairs - NSF Bumper corner" from panels field
  const panels = (job.panels || '').trim();
  if (!panels) return 'Body repairs - Vehicle bodywork repair';
  return `Body repairs - ${panels}`;
}

function buildLineItems(job) {
  return [{
    Description: buildDescription(job),
    Quantity:    1,
    UnitAmount:  parseFloat((job.quote_price || '0').replace(/[^0-9.]/g, '')) || 0,
    AccountCode: '200',
    TaxType:     'OUTPUT2' // 20% VAT (standard UK)
  }];
}

function buildContact(job) {
  const contact = { Name: job.customer_name || 'Unknown Customer' };
  if (job.customer_phone) contact.Phones = [{ PhoneType: 'MOBILE', PhoneNumber: job.customer_phone }];
  if (job.customer_email) contact.EmailAddress = job.customer_email;
  if (job.customer_address) contact.Addresses = [{ AddressType: 'STREET', AttentionTo: job.customer_name, AddressLine1: job.customer_address }];
  return contact;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const supabaseUrl = 'https://isxycoxqlummscxmdckj.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  let job, payMethod;
  try {
    const parsed = JSON.parse(event.body);
    job       = parsed.job;
    payMethod = parsed.payMethod; // 'card', 'paid' (BACS), 'nopay'
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  // Cash = do nothing
  if (payMethod === 'cash') {
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: 'Cash payment — no invoice created' }) };
  }

  try {
    const tokens      = await getTokens(supabaseUrl, supabaseKey);
    const accessToken = await refreshIfNeeded(tokens, supabaseUrl, supabaseKey);
    const tenantId    = tokens.tenant_id;

    const xeroHeaders = {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId
    };

    // Upsert contact first
    const contactPayload = { Contacts: [buildContact(job)] };
    const contactRes = await httpsReq('POST', 'https://api.xero.com/api.xro/2.0/Contacts', contactPayload, xeroHeaders);
    const contact    = contactRes.body?.Contacts?.[0];

    const vehicleInfo = [job.vehicle, job.colour].filter(Boolean).join(' - ');
    const reference   = `PanelPro #${job.id}${vehicleInfo ? ' — ' + vehicleInfo : ''}`;

    // Build invoice or receipt
    // BACS / Invoice Later = ACCREC (sales invoice, status DRAFT)
    // Card = ACCREC with status AUTHORISED + payment applied = effectively a receipt
    const invoiceType   = 'ACCREC';
    const invoiceStatus = payMethod === 'paid' || payMethod === 'nopay' ? 'DRAFT' : 'AUTHORISED';

    const invoicePayload = {
      Invoices: [{
        Type:        invoiceType,
        Status:      invoiceStatus,
        Contact:     contact ? { ContactID: contact.ContactID } : buildContact(job),
        Reference:   reference,
        LineItems:   buildLineItems(job),
        DueDate:     new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0], // 30 days
        CurrencyCode: 'GBP'
      }]
    };

    const invoiceRes = await httpsReq('POST', 'https://api.xero.com/api.xro/2.0/Invoices', invoicePayload, xeroHeaders);
    const invoice    = invoiceRes.body?.Invoices?.[0];

    if (!invoice) throw new Error('Xero invoice creation failed: ' + JSON.stringify(invoiceRes.body));

    // For card payments, record payment against invoice immediately
    if (payMethod === 'card' && invoice.InvoiceID) {
      const amount = parseFloat((job.quote_price || '0').replace(/[^0-9.]/g, '')) || 0;
      if (amount > 0) {
        await httpsReq('PUT', 'https://api.xero.com/api.xro/2.0/Payments', {
          Payments: [{
            Invoice:   { InvoiceID: invoice.InvoiceID },
            Account:   { Code: '090' }, // Xero default current account — user can update
            Date:      new Date().toISOString().split('T')[0],
            Amount:    amount,
            Reference: `Card payment — ${reference}`
          }]
        }, xeroHeaders);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success:    true,
        invoiceId:  invoice.InvoiceID,
        invoiceNum: invoice.InvoiceNumber,
        type:       payMethod === 'card' ? 'receipt' : 'invoice'
      })
    };

  } catch (e) {
    console.error('Xero invoice error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
