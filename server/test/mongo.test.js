// MongoDB persistence, against LifeLink's own database:  node --test test/mongo.test.js
// Skipped when no MONGO_URI is set in server/.env. Uses a throw-away collection prefix and removes it afterwards.
'use strict';
process.env.LIFELINK_NO_ENV = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

let uri = process.env.MONGO_URI || '';
if (!uri) { try { const m = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').match(/^MONGO_URI=(.+)$/m); if (m) uri = m[1].trim(); } catch (e) { /* no .env */ } }
const skip = uri ? false : 'no MONGO_URI configured';

const prefix = 'test' + Date.now().toString(36) + '_';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelink-mongo-'));
if (uri) Object.assign(process.env, { MONGO_URI: uri, MONGO_COLLECTION_PREFIX: prefix, DATA_DIR: dir, DEV_OTP: '1', ADMIN_PASSWORD: 'correct-horse-battery' });

let server, store, ready, base;
const call = async (m, p, b, tok) => {
  const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json' }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({})); return Object.assign({}, j, { status: r.status });
};

test.before(async () => {
  if (skip) return;
  ({ server, store, ready } = require('../server'));
  await ready;
  await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port;
});
test.after(async () => {
  if (skip) return;
  server.close();
  const cols = await store.db.listCollections({ name: { $regex: '^' + prefix } }, { nameOnly: true }).toArray();
  for (const c of cols) await store.db.collection(c.name).drop().catch(() => {});
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a real user signs up, fills the profile, and the row is in MongoDB', { skip }, async () => {
  const o = await call('POST', '/api/auth/otp/request', { phone: '9876501234' });
  const v = await call('POST', '/api/auth/otp/verify', { phone: '9876501234', otp: o.devOtp });
  assert.equal(v.status, 200); assert.equal(v.isNew, true);
  const p = await call('PUT', '/api/me', { name: 'Mongo Tester', bg: 'B+', dob: '1992-03-04', gender: 'F', weight: 58, city: 'Chennai' }, v.token);
  assert.equal(p.status, 200);
  await store.flush();
  const row = await store.db.collection(prefix + 'users').findOne({ _id: v.user.id });
  assert.ok(row, 'user document exists in MongoDB');
  assert.equal(row.name, 'Mongo Tester'); assert.equal(row.bg, 'B+'); assert.equal(row.id, v.user.id);
  assert.equal(await store.db.collection(prefix + 'admins').countDocuments(), 1);    // first admin was created in MongoDB too
});

test('data survives a restart (a fresh store reads the same users back)', { skip }, async () => {
  await store.flush();
  const { MongoStore } = require('../lib/mongostore');
  const again = await new MongoStore(uri).init();
  const u = again.find('users', x => x.phone && x.phone.endsWith('9876501234'));
  assert.ok(u); assert.equal(u.name, 'Mongo Tester');
  assert.equal(again.list('admins').length, 1);
  await again.client.close();
});

test('changes and deletions are written through', { skip }, async () => {
  const u = store.find('users', x => x.name === 'Mongo Tester');
  u.city = 'Madurai'; store.save();                  // direct mutation + save(), the pattern the routes use
  await store.flush();
  assert.equal((await store.db.collection(prefix + 'users').findOne({ _id: u.id })).city, 'Madurai');
  store.remove('users', u.id); await store.flush();
  assert.equal(await store.db.collection(prefix + 'users').findOne({ _id: u.id }), null);
});

test('singleton documents (settings) persist', { skip }, async () => {
  store.doc('config', {}).gapMen = 95; store.save(); await store.flush();
  const row = await store.db.collection(prefix + '_docs').findOne({ _id: 'config' });
  assert.equal(row.value.gapMen, 95);
});
