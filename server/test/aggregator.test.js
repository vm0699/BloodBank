// DigiLocker "aggregator" provider path, tested against a fake provider server:  node --test test/aggregator.test.js
'use strict';
process.env.LIFELINK_NO_ENV = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const seen = { init: null, issuedHeaders: null };
const fake = http.createServer((req, res) => {
  const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers['x-api-key'] !== 'test-key') return send(401, { error: 'bad key' });
  if (req.url === '/digilocker/init' && req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { seen.init = JSON.parse(b); send(200, { data: { url: 'https://consent.example.test/consent-form?tx=TX1', transaction_id: 'TX1' } }); });
  } else if (req.url === '/digilocker/issued-files') {
    seen.issuedHeaders = req.headers;
    send(200, { data: { files: [{ name: 'Aadhaar Card', uri: 'in.gov.uidai-ADHAR-111', issuer: 'UIDAI' }, { name: 'Driving License', uri: 'in.gov.transport-DRVLC-222', issuer: 'Transport Department' }, { name: 'Class X Marksheet', uri: 'in.cbse-SSCER-333', issuer: 'CBSE' }] } });
  } else if (req.url === '/digilocker/eaadhaar') send(200, { data: { name: 'Test User', dob: '12-05-1994', gender: 'M', uid: 'XXXXXXXX9908' } });
  else send(404, { error: 'nope' });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelink-agg-'));
let base, server, store;
test.before(async () => {
  await new Promise(r => fake.listen(0, r));
  Object.assign(process.env, { DATA_DIR: dir, DEV_OTP: '1', ADMIN_PASSWORD: 'correct-horse-battery', AGG_API_KEY: 'test-key', AGG_BASE: 'http://localhost:' + fake.address().port });
  ({ server, store } = require('../server'));
  await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port; process.env.PUBLIC_BASE_URL = base;
});
test.after(() => { server.close(); fake.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: b ? JSON.stringify(b) : undefined, redirect: 'manual' }); const j = await r.json().catch(() => ({})); return Object.assign({}, j, { status: r.status }); };

test('provider flow: link created with the user\'s mobile, return handled, documents + profile saved', async () => {
  assert.equal((await call('GET', '/api/health')).digilocker, 'aggregator');
  const o = await call('POST', '/api/auth/otp/request', { phone: '9123456780' });
  const v = await call('POST', '/api/auth/otp/verify', { phone: '9123456780', otp: o.devOtp });
  await call('PUT', '/api/me', { name: 'Test User', bg: 'O+', dob: '1994-05-12', gender: 'M', weight: 70, city: 'Chennai' }, v.token);

  const s = await call('POST', '/api/digilocker/start', { platform: 'android' }, v.token);
  assert.equal(s.status, 200); assert.equal(s.authUrl, 'https://consent.example.test/consent-form?tx=TX1'); assert.equal(s.mock, false);
  assert.equal(seen.init.mobile_number, '9123456780');                          // DigiLocker's sign-in is pre-filled with the LifeLink number
  assert.equal(seen.init.consent, 'Y'); assert.match(seen.init.purpose, /donor/i);
  assert.match(seen.init.redirect_uri, /\/api\/digilocker\/return\/[A-Za-z0-9_-]+$/);

  // the person finishes on DigiLocker; the provider sends them to our return URL
  const back = await fetch(seen.init.redirect_uri + '?status=success', { redirect: 'manual' });
  assert.equal(back.status, 200); assert.match(await back.text(), /savrolifelink:\/\/digilocker\/done\?session=/);
  assert.equal(seen.issuedHeaders['x-transaction-id'], 'TX1');

  const r = await call('GET', '/api/digilocker/result?session=' + s.session, null, v.token);
  assert.equal(r.ok, true); assert.equal(r.me.verified, true); assert.equal(r.me.verify.last4, '9908'); assert.equal(r.me.verify.dob, '1994-05-12'); assert.equal(r.me.verify.mismatch, false);
  assert.deepEqual(r.me.documents.map(d => d.type).sort(), ['aadhaar', 'dl']);   // the marksheet is ignored (data minimisation)
});

test('provider flow: a denied consent leaves the user unverified', async () => {
  const o = await call('POST', '/api/auth/otp/request', { phone: '9123456781' });
  const v = await call('POST', '/api/auth/otp/verify', { phone: '9123456781', otp: o.devOtp });
  await call('PUT', '/api/me', { name: 'Denied User', bg: 'A+', dob: '1990-01-01', gender: 'F', weight: 60, city: 'Chennai' }, v.token);
  const s = await call('POST', '/api/digilocker/start', { platform: 'android' }, v.token);
  await fetch(seen.init.redirect_uri + '?status=denied', { redirect: 'manual' });
  const r = await call('GET', '/api/digilocker/result?session=' + s.session, null, v.token);
  assert.equal(r.ok, false); assert.equal(r.error, 'denied');
  assert.equal((await call('GET', '/api/verify/status', null, v.token)).me.verifyNeed, 'verify');
});
