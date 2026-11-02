// enquiry-import.js — scheduled every 5 minutes (see netlify.toml).
// Imports new HubSpot enquiry emails from the Outlook/Microsoft 365 mailbox as pending jobs.
const { runImport } = require('./enquiry-lib');

exports.handler = async () => {
  try {
    const report = await runImport(process.env, { dry: false });
    console.log('enquiry-import:', JSON.stringify(report));
    return { statusCode: 200, body: JSON.stringify({ ok: report.ok, created: (report.created || []).length, error: report.error }) };
  } catch (e) {
    console.error('enquiry-import failed:', e.message);
    return { statusCode: 500, body: e.message };
  }
};
