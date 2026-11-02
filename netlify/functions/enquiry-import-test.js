// enquiry-import-test.js — manual DRY RUN. Open in a browser:
//   https://panelprocrm.netlify.app/.netlify/functions/enquiry-import-test?key=YOUR_ENQUIRY_IMPORT_KEY
// Shows what would be imported (fields found, photo download results) but creates nothing.
const { runImport } = require('./enquiry-lib');

exports.handler = async (event) => {
  const key = (event.queryStringParameters || {}).key;
  if (!process.env.ENQUIRY_IMPORT_KEY) {
    return { statusCode: 401, body: 'Not allowed: ENQUIRY_IMPORT_KEY is not set on the server yet. Add it in Netlify (Site settings > Environment variables), then Deploys > Trigger deploy > Deploy site.' };
  }
  if (!key || key.trim() !== process.env.ENQUIRY_IMPORT_KEY.trim()) {
    return { statusCode: 401, body: 'Not allowed: the key in the link does not match ENQUIRY_IMPORT_KEY (check capitals, spaces and the exact spelling).' };
  }
  try {
    const report = await runImport(process.env, { dry: true, since: (event.queryStringParameters || {}).since });
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report, null, 2) };
  } catch (e) {
    return { statusCode: 500, body: 'Error: ' + e.message };
  }
};
