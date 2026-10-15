// Real-time donor map + richer profile:  node --test test/live.test.js
'use strict';
process.env.LIFELINK_NO_ENV = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelink-live-'));
Object.assign(process.env, { DATA_DIR: dir, DEV_OTP: '1', ADMIN_PASSWORD: 'correct-horse-battery' });
delete process.env.MONGO_URI;
const { server, store } = require('../server');
const live = require('../lib/live');

let base;
test.before(async () => { await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port; store.doc('config', {}).verifyPolicy = 'any'; });
test.after(() => { live.closeAll(); server.closeAllConnections && server.closeAllConnections(); server.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (m, p, b, tok) => {
  const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({})); return Object.assign({}, j, { status: r.status });
};
async function signup(phone, name, bg) {
  const o = await call('POST', '/api/auth/otp/request', { phone });
  const v = await call('POST', '/api/auth/otp/verify', { phone, otp: o.devOtp });
  await call('PUT', '/api/me', { name, bg, dob: '1990-06-01', gender: 'M', weight: 70, city: 'Chennai' }, v.token);
  store.patch('users', v.user.id, { verify: { status: 'verified', method: 'direct' }, donor: true });
  return v;
}
// minimal SSE reader on top of fetch (same approach as the app)
async function openStream(token, events) {
  const ac = new AbortController();
  const r = await fetch(base + '/api/live?lat=13.08&lng=80.27', { headers: { Authorization: 'Bearer ' + token }, signal: ac.signal });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/event-stream/);
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = (block.match(/^event: (.+)$/m) || [])[1], data = (block.match(/^data: (.+)$/m) || [])[1];
          if (ev) events.push({ ev, data: data ? JSON.parse(data) : {} });
        }
      }
    } catch (e) { /* aborted */ }
  })();
  return ac;
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

let A, B;
test('another user sees a donor move the moment they report a position', async () => {
  A = await signup('9811100001', 'Anand Kumar', 'O+'); B = await signup('9811100002', 'Bala Raj', 'A+');
  const got = []; const ac = await openStream(B.token, got);
  assert.ok(await until(() => got.some(e => e.ev === 'hello')));
  await call('PUT', '/api/me/presence', { available: true, lat: 13.0827, lng: 80.2707 }, A.token);
  assert.ok(await until(() => got.some(e => e.ev === 'donor')), 'donor event pushed');
  const d = got.find(e => e.ev === 'donor').data;
  assert.equal(d.id, A.user.id); assert.equal(d.bg, 'O+'); assert.ok(d.seen > 0);
  assert.notEqual(d.lat, 13.0827);                          // jittered, never the exact position
  assert.ok(Math.abs(d.lat - 13.0827) < 0.004);
  assert.equal(d.phone, undefined);
  await call('PUT', '/api/me/presence', { available: false }, A.token);
  assert.ok(await until(() => got.some(e => e.ev === 'gone' && e.data.id === A.user.id)), 'gone event pushed');
  ac.abort();
});

test('a new request near you and a new notification are pushed', async () => {
  const got = []; const ac = await openStream(A.token, got);
  await until(() => got.length);
  await call('PUT', '/api/me/presence', { available: true, lat: 13.0827, lng: 80.2707 }, A.token);
  const r = await call('POST', '/api/requests', { patient: 'Test Patient', bg: 'O+', units: 1, urgency: 'urgent', hospital: 'City Hospital', phone: '9811100002', lat: 13.09, lng: 80.28 }, B.token);
  assert.equal(r.status, 200);
  assert.ok(await until(() => got.some(e => e.ev === 'feed')), 'feed event');
  assert.ok(await until(() => got.some(e => e.ev === 'notice')), 'notice event (A was alerted)');
  ac.abort();
});

test('the stream needs a valid session', async () => {
  const r = await fetch(base + '/api/live'); assert.equal(r.status, 401);
});

test('rich profile fields are validated and stored; a "yes" health answer pauses eligibility', async () => {
  assert.equal((await call('PUT', '/api/me', { pincode: '60001' }, A.token)).status, 400);
  assert.equal((await call('PUT', '/api/me', { height: 20 }, A.token)).status, 400);
  const p = await call('PUT', '/api/me', { area: 'Adyar', pincode: '600020', height: 172, prefs: ['Platelets', 'Nonsense', 'Platelets'], night: true, consent: true }, A.token);
  assert.equal(p.status, 200);
  const pr = p.me.profile;
  assert.equal(pr.area, 'Adyar'); assert.equal(pr.pincode, '600020'); assert.equal(pr.height, 172); assert.deepEqual(pr.prefs, ['Platelets']); assert.equal(pr.night, true);
  assert.ok(pr.consentAt > 0);
  assert.equal(p.me.eligible, true);
  const h = await call('PUT', '/api/me', { health: { fever: true, tattoo: false } }, A.token);
  assert.equal(h.me.profile.health.fever, true); assert.equal(h.me.profile.health.tattoo, false);
  assert.equal(h.me.eligible, false);                                       // self-declared: not eligible until answered "no"
  const ok = await call('PUT', '/api/me', { health: { fever: false } }, A.token);
  assert.equal(ok.me.eligible, true);
});
