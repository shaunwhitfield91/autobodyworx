// xero-invoice.js — Creates invoices, receipts, and quotes in Xero
// Now supports quoteLines for line-by-line breakdowns

const SUPABASE_URL = 'https://isxycoxqlummscxmdckj.supabase.co';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };

  const { job, payMethod, quoteLines } = JSON.parse(event.body || '{}');
  if (!job) return { statusCode: 400, body: 'Missing job' };

  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  // Get Xero tokens from Supabase
  const tokRes = await fetch(`${SUPABASE_URL}/rest/v1/xero_tokens?order=updated_at.desc&limit=1`, {
    headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}` }
  });
  const tokens = await tokRes.json();
  if (!tokens || !tokens[0]) return { statusCode: 401, body: JSON.stringify({ error: 'Not connected to Xero — go to Settings and connect.' }) };

  let { access_token, refresh_token, tenant_id } = tokens[0];

  // Refresh the access token (Xero access tokens last 30 mins, so always refresh)
  const refreshRes = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: process.env.XERO_CLIENT_ID,
      client_secret: process.env.XERO_CLIENT_SECRET
    })
  });
  const refreshData = await refreshRes.json();
  if (!refreshRes.ok || !refreshData.access_token) {
    // Refresh genuinely failed — do NOT silently fall back to the old (expired) token.
    const reason = refreshData.error_description || refreshData.error || 'Unknown error refreshing Xero token';
    const needsReconnect = refreshData.error === 'invalid_grant';
    return {
      statusCode: 401,
      body: JSON.stringify({
        error: needsReconnect
          ? `Xero connection has expired and needs reconnecting — go to Settings, Disconnect, then Connect to Xero again. (${reason})`
          : `Failed to refresh Xero token: ${reason}`
      })
    };
  }
  access_token = refreshData.access_token;
  // Save new tokens
  await fetch(`${SUPABASE_URL}/rest/v1/xero_tokens?order=updated_at.desc&limit=1`, {
    method: 'PATCH',
    headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ access_token, refresh_token: refreshData.refresh_token || refresh_token, updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + (refreshData.expires_in||1800)*1000).toISOString() })
  });

  // Build line items from quoteLines if available, else fall back to single line
  let lineItems;
  if (quoteLines && quoteLines.length > 0) {
    // Use actual quote lines (included ones only for invoice)
    const lines = payMethod === 'quote'
      ? quoteLines  // quotes show all lines
      : quoteLines.filter(l => l.included !== false); // invoices only include checked lines

    lineItems = lines.map(l => ({
      Description: l.description || l.desc,
      Quantity: 1,
      UnitAmount: parseFloat(l.amount),
      AccountCode: '200',
      TaxType: 'OUTPUT2'
    }));

    // Add discount as negative line if present
    const total = lines.reduce((s,l) => s + parseFloat(l.amount), 0);
    const jobTotal = parseFloat((job.quote_price || job.invoice_amount || '0').toString().replace(/[^0-9.]/g,''));
    const discount = Math.max(0, total - jobTotal);
    if (discount > 0.01) {
      lineItems.push({
        Description: 'Multi-panel discount',
        Quantity: 1,
        UnitAmount: -discount,
        AccountCode: '200',
        TaxType: 'OUTPUT2'
      });
    }
  } else {
    // Fallback: single line with job description
    const amount = parseFloat((job.quote_price || job.invoice_amount || '0').toString().replace(/[^0-9.]/g,''));
    const desc = [job.vehicle, job.panels, job.notes].filter(Boolean).join(' — ') || 'Vehicle body repair';
    lineItems = [{ Description: desc, Quantity: 1, UnitAmount: amount, AccountCode: '200', TaxType: 'OUTPUT2' }];
  }

  const contactName = job.customer_name || 'Customer';
  const contactObj = { Name: contactName };
  if (job.customer_email) contactObj.EmailAddress = job.customer_email;
  const ref = `ABW-${String(job.id).padStart(4,'0')}`;

  // Determine if this is a Quote or Invoice
  const isQuote = payMethod === 'quote';

  let xeroPayload, endpoint;

  const today = new Date().toISOString().split('T')[0];

  if (isQuote) {
    // Create a QUOTE in Xero
    endpoint = 'https://api.xero.com/api.xro/2.0/Quotes';
    const expiry = new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0];
    xeroPayload = {
      Quotes: [{
        Contact: contactObj,
        LineItems: lineItems,
        QuoteNumber: ref,
        Title: `Vehicle repair — ${job.vehicle || ''}`,
        Status: 'DRAFT',
        LineAmountTypes: 'Inclusive',
        Date: today,
        ExpiryDate: expiry
      }]
    };
  } else {
    // Create an INVOICE in Xero
    endpoint = 'https://api.xero.com/api.xro/2.0/Invoices';
    const status = payMethod === 'nopay' ? 'DRAFT' : 'AUTHORISED';
    xeroPayload = {
      Invoices: [{
        Type: 'ACCREC',
        Contact: contactObj,
        LineItems: lineItems,
        InvoiceNumber: ref,
        Reference: `${job.vehicle || ''} — ${job.colour || ''}`.replace(/^ — | — $/g,''),
        Status: status,
        LineAmountTypes: 'Inclusive',
        Date: today,
        DueDate: today
      }]
    };
  }

  const xeroRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Xero-tenant-id': tenant_id,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(xeroPayload)
  });

  const xeroData = await xeroRes.json();

  if (!xeroRes.ok || xeroData.ErrorNumber) {
    // Surface Xero's actual field-level validation messages when present
    const elementErrors = (xeroData.Elements || [])
      .flatMap(el => (el.ValidationErrors || []).map(v => v.Message))
      .filter(Boolean);
    const detail = elementErrors.length ? elementErrors.join('; ') : (xeroData.Message || xeroData.Detail || 'Xero error');
    return { statusCode: 400, body: JSON.stringify({ error: detail }) };
  }

  const created = isQuote ? xeroData.Quotes?.[0] : xeroData.Invoices?.[0];
  const num = created?.QuoteNumber || created?.InvoiceNumber || ref;
  const xeroId = created?.QuoteID || created?.InvoiceID;

  // Save Xero ID back to job
  if (serviceKey && xeroId) {
    await fetch(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${job.id}`, {
      method: 'PATCH',
      headers: { 'apikey': serviceKey, 'Authorization': `Bearer ${serviceKey}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ xero_invoice_id: xeroId, xero_invoice_number: num })
    });
  }

  // Build direct deep-link URL to the invoice/quote in Xero
  const xeroUrl = isQuote
    ? `https://go.xero.com/Quotes/View/${xeroId}`
    : `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${xeroId}`;

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, invoiceNum: num, xeroId, xeroUrl, type: isQuote ? 'quote' : 'invoice' })
  };
};
