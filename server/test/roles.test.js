// Account types (user / donor / hospital) and multi-user concurrency:  node --test test/roles.test.js
'use strict';
process.env.LIFELINK_NO_ENV = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelink-roles-'));
Object.assign(process.env, { DATA_DIR: dir, DEV_OTP: '1', ADMIN_EMAIL: 'boss@test.local', ADMIN_PASSWORD: 'correct-horse-battery', TRUST_PROXY: '1' });
delete process.env.MONGO_URI;
const { server, store, core } = require('../server');
const A = require('../lib/auth');
const live = require('../lib/live');

let base, n = 0;
test.before(async () => { await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port; store.doc('config', {}).verifyPolicy = 'any'; });
test.after(() => { live.closeAll(); server.closeAllConnections && server.closeAllConnections(); server.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });

const call = async (m, p, b, tok) => {
  const r = await fetch(base + p, { method: m, headers: Object.assign({ 'Content-Type': 'application/json', 'X-Forwarded-For': '10.1.' + (n >> 8 & 255) + '.' + (n++ & 255) }, tok ? { Authorization: 'Bearer ' + tok } : {}), body: b ? JSON.stringify(b) : undefined });
  const j = await r.json().catch(() => ({})); return Object.assign({}, j, { status: r.status });
};
const LAT = 13.0827, LNG = 80.2707;
let seq = 0;
// Real HTTP sign-up for the flow tests; direct insert (+ real session token) for the crowd tests.
async function signup(phone) {
  const o = await call('POST', '/api/auth/otp/request', { phone });
  return call('POST', '/api/auth/otp/verify', { phone, otp: o.devOtp });
}
function crowdUser(bg, extra) {
  const i = ++seq;
  const u = store.insert('users', Object.assign({ phone: '+9190000' + String(10000 + i), name: 'Crowd ' + i, bg, dob: '1990-01-01', gender: 'M', weight: 70, city: 'Chennai', status: 'active', createdAt: Date.now(), tv: 0, lang: 'en', devices: [],
    role: 'user', donor: true, available: true, presence: { lat: LAT + (i % 7) * 0.001, lng: LNG, seen: Date.now() }, verify: { status: 'verified', method: 'direct' } }, extra));
  return { id: u.id, token: A.sign({ sub: u.id, typ: 'user', tv: 0 }, dir, 3600) };
}
let adminTok;
async function admin() { if (!adminTok) adminTok = (await call('POST', '/api/admin/login', { email: 'boss@test.local', password: 'correct-horse-battery' })).token; return adminTok; }
const hospitalApp = (extra) => Object.assign({ name: 'Sunrise Hospital', type: 'Hospital', regNo: 'TN/BB/2024/118', address: '12 Mount Road, Anna Salai', city: 'Chennai', phone: '9444400001', hours: '24 hours', lat: LAT, lng: LNG }, extra);

test('account type split: a new person is a user; choosing hospital needs an application and admin approval', async () => {
  const v = await signup('9810000001');
  assert.equal(v.user.role, 'user'); assert.equal(v.user.donor, false); assert.equal(v.isNew, true);
  assert.equal((await call('PUT', '/api/me/role', { role: 'wizard' }, v.token)).status, 400);
  assert.equal((await call('GET', '/api/hospital/dashboard', null, v.token)).status, 403);
  const sw = await call('PUT', '/api/me/role', { role: 'hospital' }, v.token); assert.equal(sw.me.role, 'hospital');
  assert.equal(sw.me.complete, false);                                           // application not filled yet
  assert.equal((await call('POST', '/api/hospital/apply', hospitalApp({ regNo: 'x' }), v.token)).status, 400);
  assert.equal((await call('POST', '/api/hospital/apply', hospitalApp({ phone: '123' }), v.token)).status, 400);
  const ap = await call('POST', '/api/hospital/apply', hospitalApp(), v.token);
  assert.equal(ap.status, 200); assert.equal(ap.me.hospital.status, 'pending'); assert.equal(ap.me.complete, true);
  assert.equal((await call('GET', '/api/hospital/dashboard', null, v.token)).status, 403);            // not approved yet
  assert.equal((await call('PATCH', '/api/hospital/stock', { group: 'O+', delta: 1 }, v.token)).status, 403);

  const adm = await admin();
  const list = await call('GET', '/api/admin/hospitals?status=pending', null, adm);
  assert.equal(list.items.length, 1); assert.equal(list.items[0].name, 'Sunrise Hospital');
  assert.equal((await call('POST', '/api/admin/hospitals/' + v.user.id + '/decision', { approve: true }, v.token)).status, 401);   // users cannot approve themselves
  const ok = await call('POST', '/api/admin/hospitals/' + v.user.id + '/decision', { approve: true }, adm);
  assert.equal(ok.hospital.status, 'approved'); assert.ok(ok.hospital.bankId);

  const dash = await call('GET', '/api/hospital/dashboard', null, v.token);
  assert.equal(dash.status, 200); assert.equal(dash.bank.name, 'Sunrise Hospital'); assert.equal(dash.bank.stock['O+'], 0);
  assert.equal((await call('PUT', '/api/me/role', { role: 'user' }, v.token)).status, 409);          // approved accounts are not switched casually
  const me = await call('GET', '/api/sync?lat=13.08&lng=80.27&radius=10', null, v.token);
  assert.equal(me.me.role, 'hospital'); assert.ok(me.banks.some(b => b.name === 'Sunrise Hospital'));   // now on everyone's map
  assert.ok(store.filter('notifications', x => x.userId === v.user.id && /approved/i.test(x.title)).length === 1);
});

test('rejected application can be corrected and re-submitted', async () => {
  const v = await signup('9810000002');
  await call('POST', '/api/hospital/apply', hospitalApp({ name: 'Doubtful Clinic', regNo: 'ABC999' }), v.token);
  const adm = await admin();
  const rj = await call('POST', '/api/admin/hospitals/' + v.user.id + '/decision', { approve: false, reason: 'Licence number could not be verified' }, adm);
  assert.equal(rj.hospital.status, 'rejected');
  const me = await call('GET', '/api/sync', null, v.token);
  assert.equal(me.me.hospital.status, 'rejected'); assert.match(me.me.hospital.reason, /Licence/);
  const again = await call('POST', '/api/hospital/apply', hospitalApp({ name: 'Doubtful Clinic', regNo: 'TN/CL/2022/77' }), v.token);
  assert.equal(again.me.hospital.status, 'pending'); assert.equal(again.me.hospital.regNo, 'TN/CL/2022/77');
});

test('user vs donor: only people who become donors are listed, alerted or allowed to offer', async () => {
  const v = await signup('9810000003');
  await call('PUT', '/api/me', { name: 'Seeker Sam', dob: '1992-02-02', gender: 'M', weight: 70, city: 'Chennai' }, v.token);
  store.patch('users', v.user.id, { verify: { status: 'verified', method: 'direct' } });
  assert.equal((await call('POST', '/api/me/donor', { enable: true }, v.token)).status, 400);        // blood group missing
  const pr = await call('PUT', '/api/me/presence', { available: true, lat: LAT, lng: LNG }, v.token);
  assert.equal(pr.listed, false);                                                                       // verified + available but not a donor
  await call('PUT', '/api/me', { bg: 'O+' }, v.token);
  const req = await call('POST', '/api/requests', { patient: 'P One', bg: 'O+', units: 1, urgency: 'urgent', hospital: 'City Hospital', phone: '9810000099', lat: LAT, lng: LNG }, crowdUser('B+').token);
  assert.equal(req.status, 200);
  assert.equal((await call('POST', '/api/requests/' + req.request.id + '/offer', { accepted: true }, v.token)).code, 'donor_required');
  const en = await call('POST', '/api/me/donor', { enable: true }, v.token);
  assert.equal(en.me.donor, true);
  assert.equal((await call('PUT', '/api/me/presence', { available: true, lat: LAT, lng: LNG }, v.token)).listed, true);
  assert.equal((await call('POST', '/api/requests/' + req.request.id + '/offer', { accepted: true }, v.token)).status, 200);
  const off = await call('POST', '/api/me/donor', { enable: false }, v.token);
  assert.equal(off.me.donor, false);
  assert.equal((await call('PUT', '/api/me/presence', { lat: LAT, lng: LNG }, v.token)).listed, false);
});

let hosp;   // an approved hospital used by the concurrency tests
test('concurrency: many parallel stock changes never lose an update; stale absolute edits are refused', async () => {
  hosp = crowdUser('A+', { donor: false, available: false, presence: null, role: 'hospital',
    hospital: { name: 'Concurrent General', type: 'Hospital', regNo: 'REG-1001', address: '1 Test Road', city: 'Chennai', phone: '+919444400002', lat: LAT, lng: LNG, status: 'approved', components: ['Whole blood'] } });
  const b = store.insert('banks', { name: 'Concurrent General', lat: LAT, lng: LNG, city: 'Chennai', phone: '+919444400002', stock: {}, active: true, rev: 0 });
  store.patch('users', hosp.id, { hospital: Object.assign(store.get('users', hosp.id).hospital, { bankId: b.id }) });
  hosp.bankId = b.id;

  const ops = [];
  for (let i = 0; i < 30; i++) ops.push(call('PATCH', '/api/hospital/stock', { group: 'O-', delta: 2 }, hosp.token));
  for (let i = 0; i < 20; i++) ops.push(call('PATCH', '/api/hospital/stock', { group: 'O-', delta: -1 }, hosp.token));
  const res = await Promise.all(ops);
  assert.ok(res.every(r => r.status === 200));
  const d = await call('GET', '/api/hospital/dashboard', null, hosp.token);
  assert.equal(d.bank.stock['O-'], 40);                                   // 30*2 - 20, nothing lost
  assert.equal(d.bank.rev, 50);

  const rev = d.bank.rev;
  assert.equal((await call('PATCH', '/api/hospital/stock', { group: 'A+', set: 12, rev: rev - 3 }, hosp.token)).status, 409);   // someone changed it since
  const okSet = await call('PATCH', '/api/hospital/stock', { group: 'A+', set: 12, rev }, hosp.token);
  assert.equal(okSet.status, 200); assert.equal(okSet.bank.stock['A+'], 12);
  const floor = await call('PATCH', '/api/hospital/stock', { group: 'A+', delta: -100 }, hosp.token);
  assert.equal(floor.bank.stock['A+'], 0);                                // never negative
  // other hospitals see the same numbers on the map; ordinary users only see the location
  const otherHosp = crowdUser('A+', { donor: false, available: false, presence: null, role: 'hospital', hospital: { name: 'Other Hospital', status: 'approved', bankId: 'x' } });
  const seen = await call('GET', '/api/sync?lat=13.08&lng=80.27&radius=10', null, otherHosp.token);
  assert.equal(seen.banks.find(x => x.id === b.id).stock['O-'], 40);
  const plain = await call('GET', '/api/sync?lat=13.08&lng=80.27&radius=10', null, crowdUser('AB+').token);
  assert.equal(plain.banks.find(x => x.id === b.id).stock, null);
});

test('concurrency: a camp with 5 seats and 25 people registering at once ends with exactly 5', async () => {
  const camp = await call('POST', '/api/hospital/camps', { title: 'Rush Hour Camp', date: core.dayKey(Date.now() + 3 * 86400e3), slots: 5, venue: 'Town hall' }, hosp.token);
  assert.equal(camp.status, 200);
  const crowd = Array.from({ length: 25 }, () => crowdUser('B+'));
  const res = await Promise.all(crowd.map(u => call('POST', '/api/camps/' + camp.camp.id + '/register', {}, u.token)));
  assert.equal(res.filter(r => r.status === 200).length, 5);
  assert.equal(res.filter(r => r.status === 400).length, 20);
  const regs = await call('GET', '/api/hospital/camps/' + camp.camp.id + '/registrations', null, hosp.token);
  assert.equal(regs.items.length, 5);
  assert.equal((await call('GET', '/api/hospital/camps/' + camp.camp.id + '/registrations', null, crowd[0].token)).status, 403);   // only the host
  assert.equal((await call('PATCH', '/api/hospital/camps/' + camp.camp.id, { slots: 2 }, hosp.token)).status, 400);               // cannot shrink below registrations
  await call('PATCH', '/api/hospital/camps/' + camp.camp.id, { status: 'cancelled' }, hosp.token);
  assert.equal(store.filter('notifications', x => x.type === 'camp_cancelled').length, 5);
});

test('concurrency: 12 donors offer, the requester accepts all, all confirm at once - exactly the units needed are counted', async () => {
  const requester = crowdUser('A+', { donor: false, available: false });
  const donors = Array.from({ length: 12 }, () => crowdUser('O+'));
  const rq = await call('POST', '/api/requests', { patient: 'Crowd Patient', bg: 'A+', units: 2, urgency: 'critical', hospital: 'Concurrent General', phone: '9811100077' }, requester.token);
  assert.equal(rq.status, 200); assert.ok(rq.alerted > 0);
  const rid = rq.request.id;

  const offers = await Promise.all(donors.map(d => call('POST', '/api/requests/' + rid + '/offer', { accepted: true }, d.token)));
  assert.ok(offers.every(o => o.status === 200));
  const v = await call('GET', '/api/requests/' + rid, null, requester.token);
  assert.equal(v.request.responders, 12);
  assert.equal(new Set(v.request.responses.map(r => r.donorId)).size, 12);            // no duplicate rows from parallel offers

  const acc = await Promise.all(v.request.responses.map(r => call('PATCH', '/api/requests/' + rid + '/responses/' + r.id, { state: 'accepted' }, requester.token)));
  assert.ok(acc.every(a => a.status === 200));
  const done = await Promise.all(donors.map(d => call('POST', '/api/requests/' + rid + '/donated', {}, d.token)));
  assert.equal(done.filter(x => x.status === 200).length, 2);                          // only two units were needed
  assert.equal(done.filter(x => x.status === 400).length, 10);
  const after = await call('GET', '/api/requests/' + rid, null, requester.token);
  assert.equal(after.request.received, 2); assert.equal(after.request.status, 'fulfilled');
  assert.equal(store.filter('donations', d => d.requestId === rid).length, 2);

  // the hospital sees its patient's request and can close things on its side too
  const dash = await call('GET', '/api/hospital/dashboard', null, hosp.token);
  assert.ok(dash.requests.some(r => r.id === rid && r.status === 'fulfilled'));
});

test('concurrency: a person double-tapping "send request" creates one request', async () => {
  const u = crowdUser('B-', { donor: false, available: false });
  const body = { patient: 'Double Tap', bg: 'B-', units: 1, urgency: 'urgent', hospital: 'City Hospital', phone: '9811100088', lat: LAT, lng: LNG };
  const res = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/api/requests', body, u.token)));
  assert.equal(res.filter(r => r.status === 200).length, 1);
  assert.equal(res.filter(r => r.status === 409).length, 3);
});

test('real time: every connected user receives a donor move (30 open streams)', async () => {
  const donor = crowdUser('O-');
  const viewers = Array.from({ length: 30 }, () => crowdUser('AB+', { donor: false, available: false }));
  const got = viewers.map(() => []), acs = [];
  await Promise.all(viewers.map(async (vw, i) => {
    const ac = new AbortController(); acs.push(ac);
    const r = await fetch(base + '/api/live?lat=' + LAT + '&lng=' + LNG, { headers: { Authorization: 'Bearer ' + vw.token, 'X-Forwarded-For': '10.9.0.' + i }, signal: ac.signal });
    (async () => { const dec = new TextDecoder(); try { for await (const c of r.body) { const t = dec.decode(c); if (/event: donor/.test(t)) got[i].push(t); } } catch (e) { /* aborted */ } })();
  }));
  await call('PUT', '/api/me/presence', { available: true, lat: LAT, lng: LNG }, donor.token);
  const t0 = Date.now(); while (Date.now() - t0 < 3000 && got.some(g => !g.length)) await new Promise(r => setTimeout(r, 25));
  acs.forEach(a => a.abort());
  assert.equal(got.filter(g => g.length).length, 30);
});

test('product rules: 18+ only, donation instructions must be accepted, bank stock is hospital-only, donors get a certificate number', async () => {
  const v = await signup('9810000050');
  // age: under 18 is refused and nothing is saved
  const kid = await call('PUT', '/api/me', { name: 'Young Person', dob: core.dayKey(Date.now() - 16 * 365 * 86400e3), gender: 'M' }, v.token);
  assert.equal(kid.status, 400); assert.match(kid.error, /18/);
  assert.equal((await call('PUT', '/api/me', { name: 'Adult Person', dob: '1995-05-05', gender: 'M', bg: 'O+', weight: 70 }, v.token)).status, 200);
  store.patch('users', v.user.id, { verify: { status: 'verified', method: 'direct' } });

  // donor certificate
  const en = await call('POST', '/api/me/donor', { enable: true }, v.token);
  assert.match(en.me.cert.no, /^LL-\d{4}-[0-9A-F]{6}$/);
  assert.equal((await call('GET', '/api/sync', null, v.token)).me.cert.no, en.me.cert.no);       // stable

  // donation instructions
  await call('PUT', '/api/me/presence', { available: true, lat: LAT, lng: LNG }, v.token);
  const rq = await call('POST', '/api/requests', { patient: 'Rules Patient', bg: 'O+', units: 1, urgency: 'urgent', hospital: 'City Hospital', phone: '9810000098', lat: LAT, lng: LNG }, crowdUser('B+').token);
  const noAccept = await call('POST', '/api/requests/' + rq.request.id + '/offer', {}, v.token);
  assert.equal(noAccept.status, 400); assert.equal(noAccept.code, 'instructions_required');
  assert.equal((await call('POST', '/api/requests/' + rq.request.id + '/offer', { accepted: true }, v.token)).status, 200);
  const resp = store.get('requests', rq.request.id).responses.find(x => x.donorId === v.user.id);
  assert.ok(resp.instructionsAt > 0);                                                                // acceptance is recorded

  // stock visibility: hospital accounts see units, everyone else sees locations only
  const asUser = await call('GET', '/api/sync?lat=13.08&lng=80.27&radius=10', null, v.token);
  const bank = asUser.banks.find(b => b.id === hosp.bankId);
  assert.ok(bank); assert.equal(bank.stock, null); assert.equal(bank.name, 'Concurrent General');
  const asHosp = await call('GET', '/api/sync?lat=13.08&lng=80.27&radius=10', null, hosp.token);
  assert.equal(typeof asHosp.banks.find(b => b.id === hosp.bankId).stock['O-'], 'number');
});
