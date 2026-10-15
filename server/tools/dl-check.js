// Checks your DigiLocker provider setup and prints the RAW responses, so field names can be confirmed in minutes.
//
//   node tools/dl-check.js init 9876543210            # creates a consent link, prints the provider's response
//   node tools/dl-check.js result <transaction_id>     # after the person has consented: prints issued documents + profile
//   node tools/dl-check.js setu-init                   # Setu: create a consent request, print the raw response
//   node tools/dl-check.js setu-result <request id>    # Setu: status + Aadhaar JSON after consent
//
// Reads server/.env (AGG_API_KEY, AGG_BASE, AGG_*_PATH ...). Nothing is stored. Use the provider's SANDBOX key first.
'use strict';
const fs = require('fs');
const path = require('path');
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) {}
const env = process.env;
const base = (env.AGG_BASE || 'https://api.gridlines.io').replace(/\/$/, '');
const P = { init: env.AGG_INIT_PATH || '/digilocker/init', issued: env.AGG_ISSUED_PATH || '/digilocker/issued-files', profile: env.AGG_PROFILE_PATH || '/digilocker/eaadhaar' };
const pub = (env.PUBLIC_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
const SETU = { base: (env.SETU_BASE || (env.SETU_ENV === 'production' ? 'https://dg.setu.co' : 'https://dg-sandbox.setu.co')).replace(/\/$/, ''), h: { 'x-client-id': env.SETU_CLIENT_ID || '', 'x-client-secret': env.SETU_CLIENT_SECRET || '', 'x-product-instance-id': env.SETU_PRODUCT_INSTANCE_ID || '', 'Content-Type': 'application/json' } };
if (/^setu/.test(process.argv[2] || '')) {
  if (!env.SETU_CLIENT_ID) { console.error('Set SETU_CLIENT_ID, SETU_CLIENT_SECRET and SETU_PRODUCT_INSTANCE_ID in server/.env first.'); process.exit(1); }
  const get = async (label, path, opt) => { const r = await fetch(SETU.base + path, Object.assign({ headers: SETU.h }, opt)); const t = await r.text(); console.log('\n== ' + label + '  HTTP ' + r.status); try { console.log(JSON.stringify(JSON.parse(t), null, 2)); } catch (e) { console.log(t.slice(0, 2000)); } };
  (async () => {
    const [cmd, arg] = process.argv.slice(2);
    if (cmd === 'setu-init') {
      await get('create request', '/api/digilocker/', { method: 'POST', body: JSON.stringify({ redirectUrl: pub + '/api/digilocker/return/check' }) });
      console.log('\nOpen the url from the response, sign in and consent, then run: node tools/dl-check.js setu-result <id>');
    } else if (cmd === 'setu-result' && arg) {
      await get('status', '/api/digilocker/' + arg + '/status');
      await get('aadhaar', '/api/digilocker/' + arg + '/aadhaar');
    } else console.log('usage: node tools/dl-check.js setu-init | setu-result <id>');
  })().catch(e => { console.error(e.message); process.exit(1); });
} else {
if (!env.AGG_API_KEY) { console.error('Set AGG_API_KEY in server/.env first.'); process.exit(1); }
const headers = tx => Object.assign({ 'X-API-Key': env.AGG_API_KEY, 'X-Auth-Type': 'API-Key', 'X-Reference-ID': 'check-' + Date.now(), 'Content-Type': 'application/json' }, tx ? { 'X-Transaction-ID': tx } : {});
const show = async (label, r) => { const t = await r.text(); console.log('\n== ' + label + '  HTTP ' + r.status); try { console.log(JSON.stringify(JSON.parse(t), null, 2)); } catch (e) { console.log(t.slice(0, 2000)); } console.log('-- response headers:', JSON.stringify(Object.fromEntries([...r.headers].filter(([k]) => /transaction|request|reference/i.test(k))))); };
(async () => {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'init') {
    const body = { redirect_uri: pub + '/api/digilocker/return/check', mobile_number: String(arg || '').replace(/\D/g, '').slice(-10), check_account_linked: true, sign_up_preference: env.AGG_SIGNUP || 'PINLESS', consent: 'Y', purpose: env.DL_PURPOSE || 'Blood donor identity verification' };
    console.log('POST ' + base + P.init, JSON.stringify(body));
    await show('init', await fetch(base + P.init, { method: 'POST', headers: headers(), body: JSON.stringify(body) }));
    console.log('\nOpen the consent URL from the response in a browser, sign in, approve, then run:  node tools/dl-check.js result <transaction id>');
  } else if (cmd === 'result' && arg) {
    await show('issued documents  GET ' + P.issued, await fetch(base + P.issued, { headers: headers(arg) }));
    await show('profile  GET ' + P.profile, await fetch(base + P.profile, { headers: headers(arg) }));
    console.log('\nIf the paths or field names differ, set AGG_ISSUED_PATH / AGG_PROFILE_PATH / AGG_ITEMS_PATH / AGG_URL_PATH / AGG_TX_PATH in .env (see docs/DIGILOCKER.md).');
  } else console.log('usage: node tools/dl-check.js init <mobile>   |   node tools/dl-check.js result <transaction_id>');
})().catch(e => { console.error(e.message); process.exit(1); });
}
