// Account types (user / donor / hospital) and multi-user concurrency:  node --test test/roles.test.js
'use strict';
process.env.LIFELINK_NO_ENV = '1'; process.env.LIFELINK_NO_GEOCODE = '1';
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

// --- receiver <-> donor, both connected live; the donor is NOT ID-verified (verified-only is off) ---
async function listen(token, bag, ip) {
  const ac = new AbortController();
  const r = await fetch(base + '/api/live?lat=' + LAT + '&lng=' + LNG, { headers: { Authorization: 'Bearer ' + token, 'X-Forwarded-For': ip }, signal: ac.signal });
  (async () => { const dec = new TextDecoder(); try { for await (const c of r.body) { const t = dec.decode(c); (t.match(/event: (\w+)/g) || []).forEach(m => bag.push(m.slice(7))); } } catch (e) { /* aborted */ } })();
  return ac;
}
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test('verification is needed to request AND to donate; then receiver and donor are notified of every step instantly', async () => {
  const aad = require('../lib/aadhaar'), cfg = store.doc('config', {});
  assert.equal(cfg.verifiedDonorsOnly, true); assert.equal(cfg.verifiedRequestersOnly, true);           // on by default
  const receiver = crowdUser('A+', { donor: false, available: false, presence: null, verify: { status: 'none' } });
  const donor = crowdUser('O+', { verify: { status: 'none' } });
  const body = { patient: 'Live Patient', bg: 'A+', units: 1, urgency: 'critical', hospital: 'Concurrent General', phone: '9811100123' };

  // not verified: cannot request, cannot donate
  const noReq = await call('POST', '/api/requests', body, receiver.token);
  assert.equal(noReq.status, 403); assert.equal(noReq.code, 'verify_required');
  const other = crowdUser('B+', { donor: false, available: false });
  const someReq = await call('POST', '/api/requests', { patient: 'Other', bg: 'O+', units: 1, urgency: 'urgent', hospital: 'Concurrent General', phone: '9811100133' }, other.token);
  assert.equal((await call('POST', '/api/requests/' + someReq.request.id + '/offer', { accepted: true }, donor.token)).code, 'verify_required');

  // both verify with an Aadhaar number (the in-app flow), then everything works
  assert.equal((await call('POST', '/api/verify/aadhaar', { number: aad.withCheck('39876543211') }, receiver.token)).status, 200);
  assert.equal((await call('POST', '/api/verify/aadhaar', { number: aad.withCheck('49876543211') }, donor.token)).status, 200);

  const gotR = [], gotD = [];
  const acR = await listen(receiver.token, gotR, '10.50.0.1'), acD = await listen(donor.token, gotD, '10.50.0.2');
  assert.ok(await until(() => gotR.includes('hello') && gotD.includes('hello')));

  const rq = await call('POST', '/api/requests', body, receiver.token);                      // 1. request -> donor alerted at once
  assert.equal(rq.status, 200); assert.ok(rq.alerted >= 1);
  assert.ok(await until(() => gotD.includes('notice')), 'donor notified of the new request');
  const rid = rq.request.id, mineBefore = gotR.filter(e => e === 'notice').length;

  assert.equal((await call('POST', '/api/requests/' + rid + '/offer', { accepted: true }, donor.token)).status, 200);   // 2. offer -> receiver notified
  assert.ok(await until(() => gotR.filter(e => e === 'notice').length > mineBefore), 'receiver notified of the offer');
  const view1 = await call('GET', '/api/requests/' + rid, null, receiver.token);
  assert.equal(view1.request.responders, 1);
  const resp = view1.request.responses.find(x => x.donorId === donor.id);
  assert.equal(resp.verified, true); assert.equal(resp.phone, undefined);

  const dBefore = gotD.filter(e => e === 'notice').length;                                    // 3. accept -> donor notified, contact unlocked
  assert.equal((await call('PATCH', '/api/requests/' + rid + '/responses/' + resp.id, { state: 'accepted' }, receiver.token)).status, 200);
  assert.ok(await until(() => gotD.filter(e => e === 'notice').length > dBefore), 'donor notified of acceptance');
  assert.ok((await call('GET', '/api/requests/' + rid, null, donor.token)).request.contact);

  const rBefore = gotR.filter(e => e === 'notice').length;                                    // 4. donated -> receiver notified, fulfilled
  assert.equal((await call('POST', '/api/requests/' + rid + '/donated', {}, donor.token)).status, 200);
  assert.ok(await until(() => gotR.filter(e => e === 'notice').length > rBefore), 'receiver notified of the donation');
  const done = await call('GET', '/api/requests/' + rid, null, receiver.token);
  assert.equal(done.request.status, 'fulfilled'); assert.equal(done.request.received, 1);
  assert.ok((await call('GET', '/api/notifications', null, receiver.token)).items.some(n => n.type === 'donation_received'));
  acR.abort(); acD.abort();

  // the admin switches: with both rules off, unverified people may request and donate
  cfg.verifiedRequestersOnly = false; cfg.verifiedDonorsOnly = false;
  const r2 = crowdUser('A+', { donor: false, available: false, presence: null, verify: { status: 'none' } }), d2 = crowdUser('O+', { verify: { status: 'none' } });
  const q2 = await call('POST', '/api/requests', Object.assign({}, body, { patient: 'Second Patient', phone: '9811100124' }), r2.token);
  assert.equal(q2.status, 200);
  assert.equal((await call('POST', '/api/requests/' + q2.request.id + '/offer', { accepted: true }, d2.token)).status, 200);
  cfg.verifiedRequestersOnly = true; cfg.verifiedDonorsOnly = true;
});

test('sample data: Tamil Nadu hospitals, Tamil donor names, camps and requests load once and delete cleanly', async () => {
  const adm = await admin();
  const r = await call('POST', '/api/admin/demo', {}, adm);
  assert.equal(r.status, 200); assert.ok(r.banks >= 10 && r.donors >= 30 && r.camps >= 4 && r.requests >= 4);
  assert.equal((await call('POST', '/api/admin/demo', {}, adm)).status, 409);
  // a Tamil-language viewer sees donors by their Tamil names
  const viewer = crowdUser('B+', { donor: false, available: false, presence: null, lang: 'ta' });
  const sync = await call('GET', '/api/sync?lat=13.0827&lng=80.2707&radius=25', null, viewer.token);
  assert.ok(sync.donors.length > 0);
  assert.ok(sync.donors.some(d => /[஀-௿]/.test(d.name)), 'Tamil script names for a Tamil viewer');
  assert.ok(sync.feed.length > 0 && sync.camps.length > 0);
  const del = await call('DELETE', '/api/admin/demo', null, adm);
  assert.ok(del.banks >= 10 && del.requests >= 4);
  assert.equal(store.filter('banks', b => b.demo).length, 0);
});

test('temporary Aadhaar-number verification: format-checked, last 4 only, one number per account, switchable', async () => {
  const aad = require('../lib/aadhaar');
  const u1 = crowdUser('O+', { verify: { status: 'none' }, available: false }), u2 = crowdUser('B+', { verify: { status: 'none' }, available: false });
  const num = aad.withCheck('29876543210');
  assert.equal((await call('POST', '/api/verify/aadhaar', { number: '1234 5678 9012' }, u1.token)).status, 400);          // starts with 1
  assert.equal((await call('POST', '/api/verify/aadhaar', { number: num.slice(0, 11) + ((+num[11] + 1) % 10) }, u1.token)).status, 400);   // bad check digit
  const ok = await call('POST', '/api/verify/aadhaar', { number: num.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3') }, u1.token);
  assert.equal(ok.status, 200); assert.equal(ok.me.verified, true); assert.equal(ok.me.verify.last4, num.slice(-4));
  const raw = JSON.stringify(store.get('users', u1.id));
  assert.ok(!raw.includes(num), 'the full number is never stored');
  assert.ok(!JSON.stringify(ok).includes(store.get('users', u1.id).aadhaarHash), 'the fingerprint is never sent to the app');
  assert.equal((await call('POST', '/api/verify/aadhaar', { number: num }, u2.token)).status, 409);                       // one number, one account
  store.doc('config', {}).aadhaarEntry = false;
  assert.equal((await call('POST', '/api/verify/aadhaar', { number: aad.withCheck('39876543210') }, u2.token)).status, 403);  // switched off
  store.doc('config', {}).aadhaarEntry = true;
});
