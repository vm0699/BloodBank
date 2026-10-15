// Twilio Verify + Twilio SMS OTP login, tested against a fake Twilio:  node --test test/twilio.test.js
'use strict';
process.env.LIFELINK_NO_ENV = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const log = { verifications: [], checks: [] };
const fake = http.createServer((req, res) => {
  const send = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  let b = ''; req.on('data', c => { b += c; });
  req.on('end', () => {
    const auth = Buffer.from(String(req.headers.authorization || '').replace('Basic ', ''), 'base64').toString();
    if (auth !== 'ACtest:token123') return send(401, { code: 20003, message: 'Authenticate' });
    const f = Object.fromEntries(new URLSearchParams(b));
    if (req.url === '/v2/Services/VAtest/Verifications') { log.verifications.push(f); return send(201, { sid: 'VE1', status: 'pending' }); }
    if (req.url === '/v2/Services/VAtest/VerificationCheck') {
      log.checks.push(f);
      if (f.To === '+919000000099') return send(404, { code: 20404, message: 'not found' });
      return send(200, { sid: 'VE1', status: f.Code === '654321' ? 'approved' : 'pending' });
    }
    send(404, { message: 'nope' });
  });
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelink-tw-'));
let base, server, store;
test.before(async () => {
  await new Promise(r => fake.listen(0, r));
  const t = 'http://localhost:' + fake.address().port;
  Object.assign(process.env, { DATA_DIR: dir, ADMIN_PASSWORD: 'correct-horse-battery', SMS_PROVIDER: 'twilio_verify', TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'token123', TWILIO_VERIFY_SID: 'VAtest', TWILIO_VERIFY_BASE: t, TWILIO_API_BASE: t });
  delete process.env.DEV_OTP;
  ({ server, store } = require('../server'));
  await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port;
});
test.after(() => { server.close(); fake.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
const call = async (m, p, b) => { const r = await fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return Object.assign({}, await r.json().catch(() => ({})), { status: r.status }); };

test('Twilio Verify: code is requested from Twilio and checked by Twilio (we never see or store it)', async () => {
  const q = await call('POST', '/api/auth/otp/request', { phone: '98765 43210' });
  assert.equal(q.status, 200); assert.equal(q.devOtp, undefined);
  assert.deepEqual(log.verifications[0], { To: '+919876543210', Channel: 'sms' });
  assert.equal(store.list('otps').length, 0);
  assert.equal((await call('POST', '/api/auth/otp/verify', { phone: '9876543210', otp: '111111' })).status, 400);       // wrong code
  const ok = await call('POST', '/api/auth/otp/verify', { phone: '9876543210', otp: '654321' });
  assert.equal(ok.status, 200); assert.ok(ok.token); assert.equal(ok.isNew, true);
  assert.deepEqual(log.checks[1], { To: '+919876543210', Code: '654321' });
});

test('Twilio Verify: expired / unknown verification is just "incorrect", and bad numbers never reach Twilio', async () => {
  assert.equal((await call('POST', '/api/auth/otp/verify', { phone: '9000000099', otp: '654321' })).status, 400);
  const before = log.verifications.length;
  assert.equal((await call('POST', '/api/auth/otp/request', { phone: '123' })).status, 400);
  assert.equal(log.verifications.length, before);
});
