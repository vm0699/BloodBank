// Setu DigiLocker provider, tested against a fake Setu server:  node --test test/setu.test.js
'use strict';
process.env.LIFELINK_NO_ENV = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const seen = { create: null, headers: null, revoked: 0 };
let n = 0;
const PEOPLE = { REQ1: { name: 'Priya Sharma', dateOfBirth: '03-02-1995', gender: 'F', maskedNumber: 'XXXX XXXX 4321' }, REQ2: { name: 'Anil Kumar', dateOfBirth: '07-07-1991', gender: 'M', maskedNumber: 'XXXX XXXX 8765' } };
const fake = http.createServer((req, res) => {
  const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  seen.headers = req.headers;
  if (req.headers['x-client-id'] !== 'cid' || req.headers['x-client-secret'] !== 'sec' || req.headers['x-product-instance-id'] !== 'pid') return send(401, { error: 'bad credentials' });
  const m = req.url.match(/^\/api\/digilocker\/(REQ\d+)\/(status|aadhaar|revoke)$/);
  if (req.url === '/api/digilocker/' && req.method === 'POST') {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => { seen.create = JSON.parse(b); const id = 'REQ' + (++n); send(200, { data: { id, url: 'https://digilocker.example.test/consent?r=' + id, status: 'unauthenticated', validUpto: '2030-01-01' }, success: true }); });
  } else if (m && m[2] === 'status') send(200, { data: { status: 'authenticated' } });
  else if (m && m[2] === 'aadhaar') send(200, { data: { aadhaar: PEOPLE[m[1]] || { name: 'Other Person', dateOfBirth: '01-01-1990', gender: 'M', maskedNumber: 'XXXX XXXX 1111' }, xml: { url: 'https://files.example.test/a.xml' } }, success: true });
  else if (m && m[2] === 'revoke') { seen.revoked++; send(200, { success: true }); }
  else send(404, { error: 'nope' });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelink-setu-'));
let base, server, store;
test.before(async () => {
  await new Promise(r => fake.listen(0, r));
  Object.assign(process.env, { DATA_DIR: dir, DEV_OTP: '1', ADMIN_PASSWORD: 'correct-horse-battery', SETU_CLIENT_ID: 'cid', SETU_CLIENT_SECRET: 'sec', SETU_PRODUCT_INSTANCE_ID: 'pid', SETU_BASE: 'http://localhost:' + fake.address().port });
  ({ server, store } = require('../server'));
  await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port; process.env.PUBLIC_BASE_URL = base;
});
test.after(() => { server.close(); fake.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: b ? JSON.stringify(b) : undefined, redirect: 'manual' }); const j = await r.json().catch(() => ({})); return Object.assign({}, j, { status: r.status }); };
async function signup(phone, name, dob) {
  const o = await call('POST', '/api/auth/otp/request', { phone });
  const v = await call('POST', '/api/auth/otp/verify', { phone, otp: o.devOtp });
  await call('PUT', '/api/me', { name, bg: 'O+', dob, gender: 'F', weight: 60, city: 'Chennai' }, v.token);
  return v;
}
const finish = async (state, query) => (await fetch(base + '/api/digilocker/return/' + state + '?' + query, { redirect: 'manual' })).text();

test('Setu: Aadhaar + licence consented -> verified, licence recorded, access revoked', async () => {
  assert.equal((await call('GET', '/api/health')).digilocker, 'setu');
  const v = await signup('9345678901', 'Priya Sharma', '1995-02-03');
  const s = await call('POST', '/api/digilocker/start', { platform: 'android' }, v.token);
  assert.equal(s.status, 200); assert.equal(s.authUrl, 'https://digilocker.example.test/consent?r=REQ1');
  assert.match(seen.create.redirectUrl, /\/api\/digilocker\/return\/[A-Za-z0-9_-]+$/);
  assert.match(await finish(seen.create.redirectUrl.split('/').pop(), 'success=true&id=REQ1&scope=ADHAR,DRVLC'), /status=ok/);
  const r = await call('GET', '/api/digilocker/result?session=' + s.session, null, v.token);
  assert.equal(r.ok, true); assert.equal(r.me.verified, true); assert.equal(r.me.hasAadhaar, true); assert.equal(r.me.hasLicence, true);
  assert.equal(r.me.verify.last4, '4321'); assert.equal(r.me.verify.dob, '1995-02-03'); assert.equal(r.me.verify.mismatch, false);
  assert.deepEqual(r.me.documents.map(d => d.type).sort(), ['aadhaar', 'dl']);
  assert.equal(seen.revoked, 1);
});

test('Setu: the driving licence is optional - Aadhaar alone is enough', async () => {
  const v = await signup('9345678902', 'Anil Kumar', '1991-07-07');
  const s = await call('POST', '/api/digilocker/start', { platform: 'android' }, v.token);
  await finish(seen.create.redirectUrl.split('/').pop(), 'success=true&id=REQ2&scope=ADHAR');
  const r = await call('GET', '/api/digilocker/result?session=' + s.session, null, v.token);
  assert.equal(r.ok, true); assert.equal(r.me.verified, true); assert.equal(r.me.hasLicence, false);
});

test('Setu: a licence without Aadhaar is rejected, and a denied consent leaves the user unverified', async () => {
  const v = await signup('9345678903', 'Other Person', '1990-01-01');
  const s = await call('POST', '/api/digilocker/start', { platform: 'android' }, v.token);
  await finish(seen.create.redirectUrl.split('/').pop(), 'success=true&id=REQ3&scope=DRVLC');
  const r = await call('GET', '/api/digilocker/result?session=' + s.session, null, v.token);
  assert.equal(r.ok, false); assert.equal(r.error, 'aadhaar_required');
  const s2 = await call('POST', '/api/digilocker/start', { platform: 'android' }, v.token);
  await finish(seen.create.redirectUrl.split('/').pop(), 'success=false&error=consent_denied');
  assert.equal((await call('GET', '/api/digilocker/result?session=' + s2.session, null, v.token)).error, 'denied');
  assert.equal((await call('GET', '/api/verify/status', null, v.token)).me.verifyNeed, 'verify');
});
