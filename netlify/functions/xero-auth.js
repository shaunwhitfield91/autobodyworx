// xero-auth.js — redirects user to Xero login to authorise PanelPro
exports.handler = async (event) => {
  const clientId     = process.env.XERO_CLIENT_ID;
  const redirectUri  = 'https://panelprocrm.netlify.app/xero-callback';
  // New granular scopes required for apps created after 2 March 2026
  const scope        = 'openid profile email accounting.invoices accounting.payments accounting.contacts offline_access';
  const state        = Math.random().toString(36).slice(2);

  const url = new URL('https://login.xero.com/identity/connect/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  redirectUri);
  url.searchParams.set('scope',         scope);
  url.searchParams.set('state',         state);

  return {
    statusCode: 302,
    headers: { Location: url.toString() },
    body: ''
  };
};
