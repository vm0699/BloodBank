// Production hardening: headers, health, legal pages, data export, safety checks:  node --test test/hardening.test.js
'use strict';
process.env.LIFELINK_NO_ENV = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelink-hard-'));
Object.assign(process.env, { DATA_DIR: dir, DEV_OTP: '1', ADMIN_PASSWORD: 'correct-horse-battery', SUPPORT_EMAIL: 'help@savro.test' });
delete process.env.MONGO_URI;
const { server, store } = require('../server');

let base;
test.before(async () => { await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port; });
test.after(() => { server.closeAllConnections && server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('health reports the database', async () => {
  const j = await (await fetch(base + '/api/health')).json();
  assert.equal(j.ok, true); assert.equal(j.db, 'file');
});

test('privacy policy and terms are public, carry the support contact, and are locked down', async () => {
  for (const p of ['/privacy', '/terms']) {
    const r = await fetch(base + p), html = await r.text();
    assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(html, /help@savro\.test/); assert.ok(!html.includes('{{SUPPORT}}'));
    assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  }
  const a = await fetch(base + '/admin');
  assert.match(a.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(a.headers.get('x-content-type-options'), 'nosniff');
});

test('a person can download everything held about them', async () => {
  assert.equal((await fetch(base + '/api/me/export')).status, 401);
  const o = await (await fetch(base + '/api/auth/otp/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9877700001' }) })).json();
  const v = await (await fetch(base + '/api/auth/otp/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '9877700001', otp: o.devOtp }) })).json();
  const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + v.token };
  await fetch(base + '/api/me', { method: 'PUT', headers: h, body: JSON.stringify({ name: 'Export Person', bg: 'B-', dob: '1995-01-01', gender: 'F', area: 'T Nagar', consent: true }) });
  const ex = await (await fetch(base + '/api/me/export', { headers: h })).json();
  assert.equal(ex.profile.name, 'Export Person'); assert.equal(ex.profile.area, 'T Nagar'); assert.ok(ex.consentAt > 0);
  assert.ok(Array.isArray(ex.donations) && Array.isArray(ex.requests) && Array.isArray(ex.notifications));
  const text = JSON.stringify(ex);
  assert.ok(!/pass|secret|token|hash/i.test(text.replace(/notifications/g, '')), 'no credentials in the export');
});

test('production refuses to start with DEV_OTP on', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { NODE_ENV: 'production', DEV_OTP: '1', PORT: '0' }), encoding: 'utf8', timeout: 8000 });
  assert.equal(r.status, 1); assert.match(r.stderr, /DEV_OTP/);
});

test('admin system check reports database, SMS and DigiLocker, and is admin-only', async () => {
  assert.equal((await fetch(base + '/api/admin/diagnostics')).status, 401);
  const lg = await (await fetch(base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@lifelink.local', password: 'correct-horse-battery' }) })).json();
  const r = await (await fetch(base + '/api/admin/diagnostics', { headers: { Authorization: 'Bearer ' + lg.token } })).json();
  assert.equal(r.database, 'file'); assert.equal(r.digilocker.provider, 'mock'); assert.equal(r.sms.provider, 'console'); assert.equal(r.devOtp, true);
  assert.ok(!JSON.stringify(r).includes('correct-horse-battery'));
});
