'use strict';
// Firebase Cloud Messaging (HTTP v1). Needs a Firebase project's service-account key:
//   FCM_SERVICE_ACCOUNT_FILE=/path/to/service-account.json     (or FCM_SERVICE_ACCOUNT_JSON='{...}')
// Without it, push is skipped silently and the in-app inbox + polling still work.
const crypto = require('crypto');
const fs = require('fs');

let sa = null, tokenCache = null;
function account() {
  if (sa !== null) return sa || null;
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON || (process.env.FCM_SERVICE_ACCOUNT_FILE && fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8'));
    sa = raw ? JSON.parse(raw) : false;
  } catch (e) { console.error('FCM service account unreadable:', e.message); sa = false; }
  return sa || null;
}
const enabled = () => !!account();
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function accessToken() {
  if (tokenCache && tokenCache.exp > Date.now() + 60e3) return tokenCache.token;
  const a = account(), now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = b64u(crypto.createSign('RSA-SHA256').update(head + '.' + body).sign(a.private_key));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + body + '.' + sig }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('fcm oauth failed');
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

// Returns the list of tokens FCM says are dead so the caller can drop them.
async function send(tokens, { title, body, data }) {
  if (!enabled() || !tokens.length) return [];
  const dead = [];
  let at; try { at = await accessToken(); } catch (e) { console.error(e.message); return []; }
  await Promise.all(tokens.map(async t => {
    try {
      const r = await fetch('https://fcm.googleapis.com/v1/projects/' + account().project_id + '/messages:send', {
        method: 'POST', headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { token: t, notification: { title, body }, data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])), android: { priority: 'HIGH', notification: { channel_id: 'lifelink_notices' } } } })
      });
      if (r.status === 404 || r.status === 400) dead.push(t);
    } catch (e) { /* network: try next time */ }
  }));
  return dead;
}
module.exports = { send, enabled };
