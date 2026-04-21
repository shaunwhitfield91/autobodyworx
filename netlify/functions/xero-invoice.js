// xero-invoice.js — creates invoice or receipt in Xero from a completed PanelPro job

async function getTokens(supabaseUrl, supabaseKey) {
  const res = await fetch(`${supabaseUrl}/rest/v1/xero_tokens?limit=1`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
  });
  const data = await res.json();
  if (!data || !data[0]) throw new Error('No Xero tokens found. Please reconnect Xero in Settings.');
  return data[0];
}

async function refreshIfNeeded(tokens, supabaseUrl, supabaseKey) {
  const expiresAt = new Date(tokens.expires_at);
  if (expiresAt > new Date(Date.now() + 60000)) return tokens.access_token;
  const creds = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
  });
  const tokenData = await res.json();
  if (!tokenData.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(tokenData));
  const newExpiry = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
  await fetch(`${supabaseUrl}/rest/v1/xero_tokens?tenant_id=eq.${tokens.tenant_id}`, {
    method: 'PATCH',
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: tokenData.access_token, refresh_token: tokenData.refresh_token, expires_at: newExpiry, updated_at: new Date().toISOString() })
  });
  return tokenData.access_token;
}

function buildDescription(job) {
  const panels = (job.panels || '').trim();
  if (job._is_deposit) return panels ? `Parts deposit - ${panels}` : 'Parts deposit - Vehicle parts';
  if (job._is_balance) return panels ? `Body repairs - ${panels} (balance after deposit)` : 'Body repairs - Vehicle bodywork repair (balance after deposit)';
  return panels ? `Body repairs - ${panels}` : 'Body repairs - Vehicle bodywork repair';
}

function buildLineItems(job) {
  const amount = parseFloat((job.quote_price || job.invoice_amount || '0').toString().replace(/[^0-9.]/g, '')) || 0;
  return [{
    Description: buildDescription(job),
    Quantity: 1,
    UnitAmount: amount,
    AccountCode: '200',
    TaxType: 'OUTPUT2'
  }];
}

function buildContact(job) {
  const c = { Name: job.customer_name || 'Unknown Customer' };
  if (job.customer_email) c.EmailAddress = job.customer_email;
  if (job.customer_phone) c.Phones = [{ PhoneType: 'MOBILE', PhoneNumber: job.customer_phone }];
  if (job.customer_address) c.Addresses = [{ AddressType: 'STREET', AttentionTo: job.customer_name, AddressLine1: job.customer_address }];
  return c;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };

  const supabaseUrl = 'https://isxycoxqlummscxmdckj.supabase.co';
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  let job, payMethod;
  try {
    const p = JSON.parse(event.body);
    // Support both new format { job, payMethod } and legacy { jobId, paymentMethod }
    job = p.job;
    payMethod = p.payMethod || p.paymentMethod;

    // Legacy: if jobId sent instead of full job, fetch it from Supabase
    if (!job && p.jobId) {
      const res = await fetch(`${supabaseUrl}/rest/v1/jobs?id=eq.${p.jobId}&limit=1`, {
        headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` }
      });
      const data = await res.json();
      job = data && data[0];
    }
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid body: ' + e.message }) };
  }

  if (!job) return { statusCode: 400, body: JSON.stringify({ error: 'No job data provided' }) };
  if (!job.customer_name) job.customer_name = 'Unknown Customer';

  if (payMethod === 'cash') return { statusCode: 200, body: JSON.stringify({ skipped: true }) };

  try {
    const tokens = await getTokens(supabaseUrl, supabaseKey);
    const accessToken = await refreshIfNeeded(tokens, supabaseUrl, supabaseKey);
    const tenantId = tokens.tenant_id;
    const xH = {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // Upsert contact
    const cRes = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
      method: 'POST', headers: xH,
      body: JSON.stringify({ Contacts: [buildContact(job)] })
    });
    const cData = await cRes.json();
    const contact = cData?.Contacts?.[0];

    const vehicleInfo = [job.vehicle, job.colour].filter(Boolean).join(' - ');
    const reference = `PanelPro${job.id ? ' #' + job.id : ''}${vehicleInfo ? ' — ' + vehicleInfo : ''}`;

    // DRAFT for bacs/nopay, AUTHORISED for card
    const status = (payMethod === 'card') ? 'AUTHORISED' : 'DRAFT';

    const iRes = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
      method: 'POST', headers: xH,
      body: JSON.stringify({
        Invoices: [{
          Type: 'ACCREC',
          Status: status,
          Contact: contact ? { ContactID: contact.ContactID } : buildContact(job),
          Reference: reference,
          LineAmountTypes: 'INCLUSIVE',
          LineItems: buildLineItems(job),
          DueDate: new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0],
          CurrencyCode: 'GBP'
        }]
      })
    });
    const iData = await iRes.json();
    const invoice = iData?.Invoices?.[0];
    if (!invoice || invoice.HasErrors) throw new Error('Xero invoice error: ' + JSON.stringify(iData?.Invoices?.[0]?.ValidationErrors || iData));

    // Card — record payment against the invoice
    if (payMethod === 'card' && invoice.InvoiceID) {
      const amount = parseFloat((job.quote_price || job.invoice_amount || '0').toString().replace(/[^0-9.]/g, '')) || 0;
      if (amount > 0) {
        await fetch('https://api.xero.com/api.xro/2.0/Payments', {
          method: 'PUT', headers: xH,
          body: JSON.stringify({
            Payments: [{
              Invoice: { InvoiceID: invoice.InvoiceID },
              Account: { Code: '090' },
              Date: new Date().toISOString().split('T')[0],
              Amount: amount,
              Reference: `Card — ${reference}`
            }]
          })
        });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        invoiceId: invoice.InvoiceID,
        invoiceNum: invoice.InvoiceNumber,
        type: payMethod === 'card' ? 'receipt' : 'invoice'
      })
    };
  } catch (e) {
    console.error('Xero error:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
