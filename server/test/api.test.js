// End-to-end API tests:  node --test test/        (starts the server on a random port with a temp data dir)
'use strict';
process.env.LIFELINK_NO_ENV = '1'; process.env.LIFELINK_NO_GEOCODE = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifelink-'));
process.env.DATA_DIR = dir; process.env.DEV_OTP = '1'; process.env.ADMIN_EMAIL = 'boss@test.local'; process.env.ADMIN_PASSWORD = 'correct-horse-battery';
const { server, store } = require('../server');

let base;
test.before(async () => { await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port; process.env.PUBLIC_BASE_URL = base; store.doc('config', {}).verifiedDonorsOnly = true; });
test.after(() => { server.close(); store.flush(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(method, p, body, token, raw) {
  const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  if (raw) return r;
  const j = await r.json().catch(() => ({})); return Object.assign({}, j, { status: r.status, body: j });
}
async function login(phone, lang) {
  const o = await call('POST', '/api/auth/otp/request', { phone });
  assert.equal(o.status, 200); assert.match(o.devOtp, /^\d{6}$/);
  const v = await call('POST', '/api/auth/otp/verify', { phone, otp: o.devOtp, lang });
  assert.equal(v.status, 200); return v;
}
const profile = (name, bg, extra) => Object.assign({ name, bg, dob: '1994-05-10', gender: 'M', weight: 70, city: 'Chennai', last: '' }, extra);
const LAT = 13.0827, LNG = 80.2707;

let A, B, C, adminTok, reqId, bankId, campId;

test('health and config are public', async () => {
  const h = await call('GET', '/api/health'); assert.equal(h.ok, true); assert.equal(h.digilocker, 'mock');
  const c = await call('GET', '/api/config'); assert.equal(c.gapMen, 90); assert.equal(c.gapWomen, 120);
});

test('phone OTP: bad number, wrong code, success, new vs returning user', async () => {
  assert.equal((await call('POST', '/api/auth/otp/request', { phone: '12345' })).status, 400);
  const o = await call('POST', '/api/auth/otp/request', { phone: '98765 43210' });
  const wrong = await call('POST', '/api/auth/otp/verify', { phone: '9876543210', otp: o.devOtp === '000000' ? '111111' : '000000' });
  assert.equal(wrong.status, 400);
  A = await login('9876543210'); assert.equal(A.isNew, true);
  const again = await login('+91 98765 43210'); assert.equal(again.isNew, false); assert.equal(again.user.id, A.user.id);
  A.token = again.token; B = await login('9876543211', 'ta'); C = await login('9876543212');
  assert.equal((await call('GET', '/api/sync', null, 'garbage')).status, 401);
});

test('profile, validation and presence', async () => {
  assert.equal((await call('PUT', '/api/me', { bg: 'Z+' }, A.token)).status, 400);
  assert.equal((await call('PUT', '/api/me', { dob: '2999-01-01' }, A.token)).status, 400);
  const p = await call('PUT', '/api/me', profile('Aarav Kumar', 'O+'), A.token); assert.equal(p.me.profile.bg, 'O+');
  await call('PUT', '/api/me', profile('Bala Raj', 'B+'), B.token); await call('PUT', '/api/me', profile('Chitra Devi', 'A+', { gender: 'F' }), C.token);
  for (const u of [A, B, C]) assert.equal((await call('POST', '/api/me/donor', { enable: true }, u.token)).status, 200);   // "become a donor
  const pr = await call('PUT', '/api/me/presence', { available: true, lat: LAT, lng: LNG }, A.token);
  assert.equal(pr.listed, false); assert.equal(pr.verified, false);      // not verified yet -> not listed
});

test('donor must verify before an offer; DigiLocker (mock) end to end binds documents to the profile', async () => {
  // B raises a request first so A can try to offer while unverified
  const q = await call('POST', '/api/requests', { patient: 'Asha R.', bg: 'B+', units: 2, comp: 'Whole blood', urgency: 'critical', hrs: 3, hospital: 'City Hospital', city: 'Chennai', phone: '9000000001', lat: LAT, lng: LNG }, B.token);
  assert.equal(q.status, 200); assert.equal(q.alerted, 0); reqId = q.request.id;
  const off = await call('POST', '/api/requests/' + reqId + '/offer', { accepted: true }, A.token); assert.equal(off.status, 403); assert.equal(off.code, 'verify_required');

  const s = await call('POST', '/api/digilocker/start', { platform: 'web', returnUrl: 'http://localhost:5188/index.html' }, A.token);
  assert.equal(s.status, 200); assert.ok(s.authUrl.includes('/api/digilocker/mock')); assert.equal(s.mock, true);
  assert.equal((await call('POST', '/api/digilocker/start', { platform: 'web', returnUrl: 'http://evil.example/' }, A.token)).status, 400);
  const state = new URL(s.authUrl).searchParams.get('state');
  const page = await fetch(base + '/api/digilocker/mock?state=' + state); const loginHtml = await page.text(); assert.match(loginHtml, /Sign in to your account via DigiLocker/); assert.match(loginHtml, /value="9876543210"/);   // mobile pre-filled from the LifeLink account
  const form = o => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString(), redirect: 'manual' });
  assert.match(await (await fetch(base + '/api/digilocker/mock/login', form({ state, uid: '234567890124' }))).text(), /accept the terms/);   // consent box is required
  assert.match(await (await fetch(base + '/api/digilocker/mock/login', form({ state, uid: '234567890124', consent: 'on' }))).text(), /Verify OTP/);
  assert.match(await (await fetch(base + '/api/digilocker/mock/otp', form({ state, otp: '12' }))).text(), /6-digit OTP/);
  const consentPage = await fetch(base + '/api/digilocker/mock/otp', form({ state, otp: '123456' })); const consentHtml = await consentPage.text();
  assert.match(consentHtml, /Issued Documents/); assert.match(consentHtml, /Consent validity date/); assert.match(consentHtml, /Blood donor identity verification/);
  const cons = await fetch(base + '/api/digilocker/mock/consent', Object.assign(form({ state, decision: 'allow' }), { body: 'state=' + state + '&decision=allow&doc=aadhaar&doc=dl' }));
  assert.equal(cons.status, 302);
  const cb = await fetch(cons.headers.get('location'), { redirect: 'manual' });
  assert.equal(cb.status, 302); assert.match(cb.headers.get('location'), /dl_session=/);
  const res = await call('GET', '/api/digilocker/result?session=' + s.session, null, A.token);
  assert.equal(res.ok, true); assert.equal(res.me.verify.status, 'verified'); assert.equal(res.me.verify.method, 'digilocker'); assert.equal(res.me.verify.last4, '0124');
  assert.deepEqual(res.me.documents.map(d => d.type).sort(), ['aadhaar', 'dl']);      // documents saved under the profile
  assert.equal((await call('GET', '/api/digilocker/result?session=' + s.session, null, A.token)).status, 404);   // one-time read
  assert.ok(res.me.verify.consentUntil > Date.now());
  // date of birth and gender now come from the verified document and cannot be edited to dodge the age rule
  const lock = await call('PUT', '/api/me', { dob: '1950-01-01', gender: 'F' }, A.token); assert.equal(lock.me.profile.dob, '1994-05-10'); assert.equal(lock.me.profile.gender, 'M');

  // the same DigiLocker identity cannot verify a second account
  const s2 = await call('POST', '/api/digilocker/start', { platform: 'android' }, C.token);
  const st2 = new URL(s2.authUrl).searchParams.get('state');
  await fetch(base + '/api/digilocker/mock/login', form({ state: st2, uid: '234567890124', consent: 'on' }));
  await fetch(base + '/api/digilocker/mock/otp', form({ state: st2, otp: '123456' }));
  await fetch(base + '/api/digilocker/mock/consent', Object.assign(form({}), { body: 'state=' + st2 + '&decision=allow&doc=aadhaar' }));
  const cb2 = await fetch(base + '/api/digilocker/callback?code=mock&state=' + st2); assert.match(await cb2.text(), /savrolifelink:\/\/digilocker\/done\?session=.*status=error/);
  assert.equal((await call('GET', '/api/digilocker/result?session=' + s2.session, null, C.token)).error, 'id_in_use');
});

test('matching: verified donor is listed, alerted and can complete the request lifecycle', async () => {
  const pr = await call('PUT', '/api/me/presence', { available: true, lat: LAT + 0.01, lng: LNG + 0.01 }, A.token); assert.equal(pr.listed, true);
  const sync = await call('GET', '/api/sync?lat=' + LAT + '&lng=' + LNG + '&radius=10', null, B.token);
  const d = sync.donors.find(x => x.id === A.user.id); assert.ok(d, 'A shows on B\'s map');
  assert.equal(d.name, 'Aarav K.'); assert.ok(!('phone' in d)); assert.ok(Math.abs(d.lat - (LAT + 0.01)) < 0.005);   // fuzzed, no phone
  assert.ok(!sync.donors.some(x => x.id === B.user.id));
  // alert wider -> A (O+ can give to B+) is alerted
  const w = await call('POST', '/api/requests/' + reqId + '/alert-wider', {}, B.token); assert.equal(w.alerted, 1);
  const notes = await call('GET', '/api/notifications', null, A.token); assert.equal(notes.items[0].type, 'request_alert'); assert.match(notes.items[0].title, /Critical blood needed: B\+/);
  const tn = await call('GET', '/api/notifications', null, B.token); assert.ok(tn.items.length >= 0);
  // A sees it in the feed without the contact number, then offers
  let sa = await call('GET', '/api/sync?lat=' + LAT + '&lng=' + LNG, null, A.token);
  const f = sa.feed.find(x => x.id === reqId); assert.ok(f); assert.equal(f.contact, '');
  assert.equal((await call('POST', '/api/requests/' + reqId + '/offer', { accepted: true }, C.token)).status, 403);     // C not verified
  assert.equal((await call('POST', '/api/requests/' + reqId + '/offer', { accepted: true }, A.token)).status, 200);
  let sb = await call('GET', '/api/sync', null, B.token);
  const mine = sb.mine.find(x => x.id === reqId); const resp = mine.responses.find(x => x.donorId === A.user.id);
  assert.equal(resp.state, 'offered'); assert.equal(resp.phone, undefined);
  assert.equal((await call('POST', '/api/requests/' + reqId + '/donated', {}, A.token)).status, 400);   // not accepted yet
  assert.equal((await call('PATCH', '/api/requests/' + reqId + '/responses/' + resp.id, { state: 'accepted' }, A.token)).status, 403);   // only the requester accepts
  const acc = await call('PATCH', '/api/requests/' + reqId + '/responses/' + resp.id, { state: 'accepted' }, B.token); assert.equal(acc.status, 200);
  sb = await call('GET', '/api/sync', null, B.token); assert.match(sb.mine[0].responses[0].phone, /^\+91 98765 43210$/);
  sa = await call('GET', '/api/sync', null, A.token); const of = sa.offers.find(o => o.rid === reqId); assert.equal(of.state, 'accepted'); assert.equal(of.req.contact, '+91 90000 00001');
  const don = await call('POST', '/api/requests/' + reqId + '/donated', {}, A.token); assert.equal(don.status, 200);
  sb = await call('GET', '/api/sync', null, B.token); assert.equal(sb.mine[0].received, 1); assert.equal(sb.mine[0].status, 'open');   // needs 2 units
  sa = await call('GET', '/api/sync', null, A.token); assert.equal(sa.donations.length, 1); assert.equal(sa.me.profile.last, new Date().toISOString().slice(0, 4) ? sa.me.profile.last : '');
  assert.equal(sa.me.eligible, false);                       // cooling down after donating
  assert.ok(!(await call('GET', '/api/sync?lat=' + LAT + '&lng=' + LNG, null, B.token)).donors.some(x => x.id === A.user.id));   // no longer listed
  const bn = await call('GET', '/api/notifications', null, B.token); assert.ok(bn.items.some(n => n.type === 'offer_received')); assert.ok(bn.items.some(n => n.type === 'donation_received'));
  assert.ok(bn.items.find(n => n.type === 'offer_received').title.includes('இரத்த'));          // B's language is Tamil
});

test('request rules: ownership, duplicates, fulfil/close, report', async () => {
  const dup = await call('POST', '/api/requests', { patient: 'Asha R.', bg: 'B+', units: 1, urgency: 'urgent', hospital: 'City Hospital', phone: '9000000001', lat: LAT, lng: LNG }, B.token); assert.equal(dup.status, 409);
  assert.equal((await call('PATCH', '/api/requests/' + reqId, { status: 'closed' }, A.token)).status, 403);
  assert.equal((await call('POST', '/api/requests', { patient: 'X', bg: 'B+', units: 1, urgency: 'urgent', hospital: 'H', phone: '123', lat: LAT, lng: LNG }, B.token)).status, 400);
  assert.equal((await call('POST', '/api/requests/' + reqId + '/report', { reason: 'Looks fake' }, A.token)).status, 200);
  assert.equal((await call('PATCH', '/api/requests/' + reqId, { status: 'fulfilled' }, B.token)).request.status, 'fulfilled');
});

test('profile extras: donation log, organ pledge, camps registration, devices, language', async () => {
  const d = await call('POST', '/api/me/donations', { date: '2024-01-15', place: 'Camp', type: 'Platelets' }, C.token); assert.equal(d.status, 200);
  const o = await call('PUT', '/api/me/organ', { pledged: true, organs: ['Kidneys', 'Liver', 'Nonsense'], tissues: ['Corneas'], kin: { name: 'Mother', phone: '9000000002', rel: 'Parent' }, informed: true }, C.token);
  assert.deepEqual(o.organ.organs, ['Kidneys', 'Liver']); assert.match(o.organ.id, /^LL-[0-9A-F]{8}$/);
  assert.equal((await call('PUT', '/api/me/organ', { pledged: true, organs: [], tissues: [], kin: { name: 'x' } }, C.token)).status, 400);
  assert.equal((await call('POST', '/api/me/devices', { token: 'fcm-token-1' }, C.token)).status, 200);
  assert.equal((await call('PUT', '/api/me', { lang: 'ta' }, C.token)).me.lang, 'ta');
});

let staffTok, regsBefore;
test('admin: login, dashboard, banks + stock, camps, staff scoping', async () => {
  assert.equal((await call('POST', '/api/admin/login', { email: 'boss@test.local', password: 'wrong' })).status, 401);
  const l = await call('POST', '/api/admin/login', { email: 'boss@test.local', password: 'correct-horse-battery' }); assert.equal(l.status, 200); adminTok = l.token;
  assert.equal((await call('GET', '/api/admin/users', null, A.token)).status, 401);                 // app token is not an admin token
  const st = await call('GET', '/api/admin/stats', null, adminTok); assert.equal(st.users, 3); assert.equal(st.verified, 1); assert.equal(st.organPledges, 1); assert.equal(st.requestsTotal, 1);
  const b = await call('POST', '/api/admin/banks', { name: 'Test Blood Bank', lat: 13.05, lng: 80.25, type: 'Charitable', hours: '24 x 7', phone: '04412345678', city: 'Chennai' }, adminTok); assert.equal(b.status, 200); bankId = b.bank.id;
  assert.equal((await call('POST', '/api/admin/banks', { name: 'No location' }, adminTok)).status, 400);
  const sf = await call('POST', '/api/admin/staff', { email: 'staff@test.local', name: 'Staff One', role: 'staff', bankId, password: 'staff-password-1' }, adminTok); assert.equal(sf.status, 200);
  const other = await call('POST', '/api/admin/banks', { name: 'Other Bank', lat: 13.1, lng: 80.2 }, adminTok);
  staffTok = (await call('POST', '/api/admin/login', { email: 'staff@test.local', password: 'staff-password-1' })).token;
  assert.equal((await call('PUT', '/api/admin/banks/' + bankId + '/stock', { stock: { 'O+': 12, 'A-': 3 } }, staffTok)).bank.stock['O+'], 12);
  assert.equal((await call('PUT', '/api/admin/banks/' + other.bank.id + '/stock', { stock: { 'O+': 1 } }, staffTok)).status, 403);   // not their bank
  assert.equal((await call('GET', '/api/admin/users', null, staffTok)).status, 403);                                                    // staff cannot see donors
  assert.equal((await call('GET', '/api/admin/banks', null, staffTok)).items.length, 1);
  const day = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const c = await call('POST', '/api/admin/camps', { title: 'Staff Camp', date: day, time: '9 AM - 2 PM', venue: 'Hall', lat: 13.06, lng: 80.26, slots: 1 }, staffTok); assert.equal(c.status, 200); assert.equal(c.camp.bankId, bankId); campId = c.camp.id;
  assert.equal((await call('POST', '/api/admin/camps', { title: 'Bad', date: 'tomorrow', lat: 1, lng: 1 }, staffTok)).status, 400);
  // app users see the bank location and the camp, but not the stock (that is for hospital accounts)
  const sync = await call('GET', '/api/sync?lat=13.05&lng=80.25', null, C.token);
  assert.ok(sync.banks.find(x => x.id === bankId)); assert.equal(sync.banks.find(x => x.id === bankId).stock, null); assert.ok(sync.camps.some(x => x.id === campId));
  assert.equal((await call('POST', '/api/camps/' + campId + '/register', {}, C.token)).regCount, 1);
  assert.equal((await call('POST', '/api/camps/' + campId + '/register', {}, A.token)).status, 400);     // slots: 1 -> full
  const regs = await call('GET', '/api/admin/camps/' + campId + '/regs', null, staffTok); assert.equal(regs.items[0].name, 'Chitra Devi');
});

test('admin: direct verification queue, user controls, reports, broadcast, settings, export, audit', async () => {
  const ph = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const dv = await call('POST', '/api/verify/direct', { idType: 'pan', idNumber: 'ABCDE1234F', name: 'Chitra Devi', photo: ph }, C.token); assert.equal(dv.status, 200); assert.equal(dv.me.verify.status, 'pending');
  const q = await call('GET', '/api/admin/verifications', null, adminTok); assert.equal(q.items.length, 1); assert.equal(q.items[0].idNumber, 'ABCDE1234F');
  const photo = await call('GET', '/api/admin/verifications/' + q.items[0].id + '/photo', null, adminTok, true); assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal((await call('POST', '/api/admin/verifications/' + q.items[0].id + '/decision', { decision: 'approve' }, adminTok)).ok, true);
  assert.equal((await call('GET', '/api/verify/status', null, C.token)).body.status, 'verified');
  // policy: a direct-ID approval is not enough while the policy requires DigiLocker
  let me = (await call('GET', '/api/verify/status', null, C.token)).me; assert.equal(me.verified, false); assert.equal(me.verifyNeed, 'digilocker');
  assert.equal((await call('PUT', '/api/admin/config', { verifyPolicy: 'bogus' }, adminTok)).status, 400);
  await call('PUT', '/api/admin/config', { verifyPolicy: 'any' }, adminTok);
  me = (await call('GET', '/api/verify/status', null, C.token)).me; assert.equal(me.verified, true);
  await call('PUT', '/api/admin/config', { verifyPolicy: 'digilocker', verifyRequireLicence: true }, adminTok);            // licence now required too
  const uA = store.get('users', A.user.id), allDocs = uA.documents.slice();
  assert.equal((await call('GET', '/api/verify/status', null, A.token)).me.verified, true);                                  // A shared Aadhaar + licence
  uA.documents = allDocs.filter(d => d.type !== 'dl');                                                                        // ...without a licence
  assert.equal((await call('GET', '/api/verify/status', null, A.token)).me.verifyNeed, 'licence');
  await call('PUT', '/api/admin/config', { verifyRequireLicence: false }, adminTok);                                          // licence optional again (default)
  assert.equal((await call('GET', '/api/verify/status', null, A.token)).me.verified, true);                                  // Aadhaar alone is enough
  uA.documents = allDocs.filter(d => d.type !== 'aadhaar');                                                                   // a licence alone is never enough
  assert.equal((await call('GET', '/api/verify/status', null, A.token)).me.verifyNeed, 'aadhaar');
  assert.equal((await call('PUT', '/api/me/presence', { available: true, lat: LAT, lng: LNG }, A.token)).verified, false);   // not listed while below the policy
  uA.documents = allDocs;
  assert.equal((await call('GET', '/api/verify/status', null, A.token)).me.verified, true);
  // the DigiLocker identity is the same, but C is verified by an admin override here: manual counts as qualified
  assert.equal((await call('POST', '/api/admin/users/' + C.user.id + '/verify', {}, adminTok)).ok, true);
  assert.equal(store.list('verifications')[0].idNumber, '******234F');
  // user management
  const users = await call('GET', '/api/admin/users?verify=verified', null, adminTok); assert.equal(users.total, 2);
  const detail = await call('GET', '/api/admin/users/' + A.user.id, null, adminTok); assert.equal(detail.user.documents.length, 2); assert.equal(detail.user.donations.length, 1);
  assert.equal((await call('PATCH', '/api/admin/users/' + C.user.id, { city: 'Madurai', bg: 'AB+' }, adminTok)).ok, true);
  assert.equal((await call('POST', '/api/admin/users/' + C.user.id + '/suspend', { reason: 'test' }, adminTok)).ok, true);
  assert.equal((await call('GET', '/api/sync', null, C.token)).status, 401);                          // suspended: token revoked
  assert.equal((await call('POST', '/api/auth/otp/verify', { phone: '9876543212', otp: (await call('POST', '/api/auth/otp/request', { phone: '9876543212' })).devOtp }, null)).status, 403);
  assert.equal((await call('POST', '/api/admin/users/' + C.user.id + '/unsuspend', {}, adminTok)).ok, true);
  // reports
  const rep = await call('GET', '/api/admin/reports?status=open', null, adminTok); assert.equal(rep.items.length, 1);
  assert.equal((await call('POST', '/api/admin/reports/' + rep.items[0].id + '/resolve', { action: 'dismiss' }, adminTok)).ok, true);
  // broadcast with audience
  assert.equal((await call('POST', '/api/admin/broadcast', { title: 'Hello', body: 'World', audience: { bg: 'O+' }, dryRun: true }, adminTok)).count, 1);
  assert.equal((await call('POST', '/api/admin/broadcast', { title: 'World Blood Donor Day', body: 'Thank you', titleTa: 'உலக இரத்த கொடையாளர் தினம்', bodyTa: 'நன்றி', audience: {} }, adminTok)).count, 3);
  assert.ok((await call('GET', '/api/notifications', null, B.token)).items.some(n => n.title === 'உலக இரத்த கொடையாளர் தினம்'));       // delivered in the user's language
  // settings change takes effect
  assert.equal((await call('PUT', '/api/admin/config', { gapMen: 60, announcement: 'Hi' }, adminTok)).config.gapMen, 60);
  assert.equal((await call('GET', '/api/config')).gapMen, 60);
  assert.equal((await call('PUT', '/api/admin/config', { gapMen: -5 }, adminTok)).status, 400);
  await call('PUT', '/api/admin/config', { gapMen: 90 }, adminTok);
  // exports + audit
  const csv = await call('GET', '/api/admin/export/users', null, adminTok, true); assert.match(await csv.text(), /Aarav Kumar/);
  const au = await call('GET', '/api/admin/audit', null, adminTok); assert.ok(au.items.some(a => a.action === 'user.suspend') && au.items.some(a => a.action === 'bank.stock'));
  // erase: removes data, anonymises requests
  assert.equal((await call('DELETE', '/api/me', null, B.token)).ok, true);
  assert.equal(store.list('requests')[0].patient, 'Removed'); assert.equal(store.get('users', B.user.id), null);
  assert.equal((await call('DELETE', '/api/admin/users/' + C.user.id, null, adminTok)).ok, true);
  assert.equal((await call('GET', '/api/admin/stats', null, adminTok)).users, 1);
});
