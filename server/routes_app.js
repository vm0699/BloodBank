'use strict';
// Mobile-app API. Every route is /api/... ; "auth: user" routes need `Authorization: Bearer <jwt>`.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A = require('./lib/auth');
const sms = require('./lib/sms');
const { hav, validLL } = require('./lib/geo');
const { HttpError, bad, str, num, isDay, oneOf } = require('./lib/http');
const dlNameMatches = require('./lib/digilocker').nameMatches;
const live = require('./lib/live');

const ORGANS = ['Heart', 'Lungs', 'Liver', 'Kidneys', 'Pancreas', 'Small intestine'];
const TISSUES = ['Corneas', 'Skin', 'Bone', 'Heart valves', 'Blood vessels'];
const ID_TYPES = ['aadhaar', 'dl', 'voter', 'pan', 'passport'];

module.exports = function register(R, { store, core, dl, env, dataDir, limiter }) {
  const today = () => core.dayKey(Date.now());
  const normBank = b => ({ id: b.id, kind: 'bank', name: b.name, type: b.type || 'Hospital-based', lat: b.lat, lng: b.lng, hours: b.hours || '', phone: b.phone || '', address: b.address || '', city: b.city || '',
    area: b.area || b.city || '', components: b.components && b.components.length ? b.components : ['Whole blood'], stock: Object.assign(Object.fromEntries(core.BGS.map(g => [g, 0])), b.stock || {}), updatedAt: b.updatedAt || 0 });
  const myOffers = u => {
    const out = [];
    store.list('requests').forEach(r => {
      const x = r.responses.find(y => y.donorId === u.id && ['offered', 'accepted', 'declined', 'confirmed', 'withdrawn'].includes(y.state));
      if (x && x.state !== 'withdrawn') out.push({ rid: r.id, req: core.reqView(r, u), state: core.offerState(x.state), at: x.at, due: 0 });
    });
    return out.sort((a, b) => b.at - a.at).slice(0, 50);
  };

  /* ---------- public ---------- */
  R.add('GET', '/api/health', { auth: 'public' }, async () => {
    let db = 'down'; try { db = await store.health(); } catch (e) { /* reported below */ }
    if (db === 'down') throw new HttpError(503, 'Database unavailable');
    return { ok: true, name: 'LifeLink', db, sms: sms.provider(), push: require('./lib/push').enabled(), digilocker: dl.PROVIDER };
  });
  R.add('GET', '/api/config', { auth: 'public' }, () => {
    const c = core.cfg();
    return { gapMen: c.gapMen, gapWomen: c.gapWomen, minAge: c.minAge, maxAge: c.maxAge, minWeight: c.minWeight, defaultRadiusKm: c.defaultRadiusKm, maintenance: !!c.maintenance, announcement: c.announcement || '', digilockerMock: dl.MOCK, verifyPolicy: c.verifyPolicy, verifyRequireLicence: !!c.verifyRequireLicence, verifyAllowSkip: !!c.verifyAllowSkip, verifiedDonorsOnly: !!c.verifiedDonorsOnly };
  });

  /* ---------- auth: phone OTP ---------- */
  R.add('POST', '/api/auth/otp/request', { auth: 'public' }, async ({ body, ip }) => {
    const phone = A.normPhone(body.phone);
    if (!phone) throw bad('Enter a valid 10-digit mobile number');
    if (!limiter.take('otp-ip:' + ip, 15, 3600e3) || !limiter.take('otp-ph:' + phone, 3, 600e3)) throw new HttpError(429, 'Too many codes requested. Try again in a few minutes.');
    const otp = String(crypto.randomInt(100000, 1000000));
    if (sms.verifyMode()) {                                  // Twilio Verify generates and checks the code itself
      try { await sms.startVerify(phone); } catch (e) { console.error('sms failed:', e.message); throw new HttpError(502, 'Could not send the SMS. Please try again.'); }
      return { ok: true };
    }
    store.removeWhere('otps', o => o.phone === phone);
    store.insert('otps', { phone, hash: A.sha(otp + phone + A.secret(dataDir)), exp: Date.now() + 5 * 60e3, attempts: 0 });
    try { await sms.sendOtp(phone, otp); } catch (e) { console.error('sms failed:', e.message); throw new HttpError(502, 'Could not send the SMS. Please try again.'); }
    return env.DEV_OTP === '1' ? { ok: true, devOtp: otp } : { ok: true };
  });
  R.add('POST', '/api/auth/otp/verify', { auth: 'public' }, async ({ body, ip }) => {
    const phone = A.normPhone(body.phone), otp = str(body.otp, 6);
    if (!phone || !/^\d{6}$/.test(otp)) throw bad('Enter the 6-digit code');
    if (!limiter.take('ver-ip:' + ip, 40, 3600e3)) throw new HttpError(429, 'Too many attempts. Try again later.');
    if (sms.verifyMode()) {
      if (!limiter.take('ver-ph:' + phone, 8, 600e3)) throw new HttpError(429, 'Too many attempts. Try again later.');
      let ok = false;
      try { ok = await sms.checkVerify(phone, otp); } catch (e) { console.error('sms verify failed:', e.message); throw new HttpError(502, 'Could not check the code. Please try again.'); }
      if (!ok) throw bad('Incorrect code');
    } else {
      const rec = store.find('otps', o => o.phone === phone);
      if (!rec || rec.exp < Date.now()) throw bad('That code has expired. Request a new one.');
      if (++rec.attempts > 5) { store.removeWhere('otps', o => o.phone === phone); throw bad('Too many wrong attempts. Request a new code.'); }
      store.save();
      if (rec.hash !== A.sha(otp + phone + A.secret(dataDir))) throw bad('Incorrect code');
      store.removeWhere('otps', o => o.phone === phone);
    }
    let u = store.find('users', x => x.phone === phone), isNew = false;
    if (!u) { u = store.insert('users', { phone, status: 'active', createdAt: Date.now(), tv: 0, lang: body.lang === 'ta' ? 'ta' : 'en', devices: [], available: false }); isNew = true; }
    if (u.status === 'suspended') throw new HttpError(403, 'This account is suspended. Contact support.');
    u.lastLogin = Date.now(); store.save();
    return { token: A.sign({ sub: u.id, typ: 'user', tv: u.tv || 0 }, dataDir, 60 * 86400), user: core.userView(u), isNew };
  });

  /* ---------- sync: everything the app screens need in one call ---------- */
  R.add('GET', '/api/sync', { auth: 'user' }, ({ user, query }) => {
    const c = core.cfg();
    let lat = parseFloat(query.lat), lng = parseFloat(query.lng);
    if (!validLL(lat, lng)) { lat = user.presence ? user.presence.lat : 13.0827; lng = user.presence ? user.presence.lng : 80.2707; }
    const radius = Math.min(100, Math.max(1, parseFloat(query.radius) || c.defaultRadiusKm));
    live.setPos(user.id, lat, lng);
    const within = (o, km) => hav(lat, lng, o.lat, o.lng) <= km;
    const fresh = Date.now() - c.presenceFreshMin * 60e3;
    const donors = store.list('users').filter(u => u.id !== user.id && core.donorListed(u, c) && (u.demo || u.presence.seen >= fresh))
      .map(u => core.publicDonor(u, user.lang)).filter(d => within(d, radius * 1.6)).sort((a, b) => hav(lat, lng, a.lat, a.lng) - hav(lat, lng, b.lat, b.lng)).slice(0, 80);
    const feed = store.list('requests').filter(r => r.status === 'open' && r.userId !== user.id && within(r, Math.max(radius * 2, 30)))
      .map(r => core.reqView(r, user)).sort((a, b) => b.created - a.created).slice(0, 60);
    const mine = store.list('requests').filter(r => r.userId === user.id && Date.now() - r.created < 60 * 86400e3).map(r => core.reqView(r, user)).sort((a, b) => b.created - a.created);
    const camps = store.list('camps').filter(x => x.status !== 'cancelled' && x.date >= today() && within(x, 120)).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 30)
      .map(x => ({ id: x.id, kind: 'camp', title: x.title, org: x.org || '', host: x.host || '', date: x.date, time: x.time || '', venue: x.venue || '', lat: x.lat, lng: x.lng, slots: x.slots || 0, regCount: (x.regs || []).length, registered: (x.regs || []).includes(user.id) }));
    return {
      serverTime: Date.now(), me: core.userView(user), donors, feed, mine, offers: myOffers(user), camps,
      // Blood bank locations are public; the units in stock are only for hospital accounts.
      banks: store.list('banks').filter(b => b.active !== false && within(b, 150)).map(normBank).map(b => (user.role === 'hospital' ? b : Object.assign(b, { stock: null }))),
      centres: store.list('centres').filter(x => x.active !== false && within(x, 300)).map(x => ({ id: x.id, kind: 'centre', name: x.name, programs: x.programs || [], lat: x.lat, lng: x.lng, phone: x.phone || '', hours: x.hours || '', coordinator: 'Transplant coordinator' })),
      donations: store.filter('donations', d => d.userId === user.id).sort((a, b) => b.t - a.t).slice(0, 100).map(d => ({ id: d.id, t: d.t, place: d.place, type: d.type, units: d.units, forWho: d.forWho })),
      unread: store.filter('notifications', n => n.userId === user.id && !n.read).length,
      config: { gapMen: c.gapMen, gapWomen: c.gapWomen, minAge: c.minAge, maxAge: c.maxAge, minWeight: c.minWeight, announcement: c.announcement || '', maintenance: !!c.maintenance, verifyPolicy: c.verifyPolicy, verifyRequireLicence: !!c.verifyRequireLicence, verifyAllowSkip: !!c.verifyAllowSkip, verifiedDonorsOnly: !!c.verifiedDonorsOnly }
    };
  });

  /* ---------- profile ---------- */
  R.add('PUT', '/api/me', { auth: 'user' }, ({ user, body }) => {
    const p = {};
    if ('name' in body) { p.name = str(body.name, 80); if (!p.name) throw bad('Enter your name'); }
    if ('email' in body) p.email = str(body.email, 120);
    const locked = core.docLocked(user);   // date of birth + gender come from the verified document and cannot be edited
    if ('dob' in body && !locked) {
      if (body.dob && (!isDay(body.dob) || body.dob > today())) throw bad('Check the date of birth');
      if (body.dob && core.ageOf(body.dob) < 18) throw bad('You must be 18 or older to use LifeLink');
      p.dob = body.dob || '';
    }
    if ('gender' in body && !locked) p.gender = oneOf(body.gender, ['M', 'F', 'O']) || '';
    if ('bg' in body) { p.bg = oneOf(body.bg, core.BGS); if (!p.bg) throw bad('Choose a blood group'); }
    if ('weight' in body) { p.weight = body.weight === '' || body.weight == null ? '' : num(body.weight, 20, 250); if (p.weight === null) throw bad('Check the weight'); }
    if ('city' in body) p.city = str(body.city, 60);
    if ('address' in body) p.address = str(body.address, 160);
    if ('last' in body) { if (body.last && (!isDay(body.last) || body.last > today())) throw bad('Check the last donation date'); p.last = body.last || ''; }
    if ('donatedBefore' in body) p.donatedBefore = Math.round(num(body.donatedBefore, 0, 500) || 0);
    if ('conditions' in body) p.conditions = [].concat(body.conditions || []).slice(0, 12).map(x => str(x, 40));
    if ('emName' in body) p.emName = str(body.emName, 80);
    if ('emPhone' in body) p.emPhone = str(body.emPhone, 20);
    if ('lang' in body) p.lang = body.lang === 'ta' ? 'ta' : 'en';
    if ('area' in body) p.area = str(body.area, 60);
    if ('pincode' in body) { p.pincode = String(body.pincode || '').replace(/\D/g, ''); if (p.pincode && p.pincode.length !== 6) throw bad('Enter a 6-digit pincode'); }
    if ('height' in body) { p.height = body.height === '' || body.height == null ? '' : num(body.height, 100, 230); if (p.height === null) throw bad('Check the height'); }
    if ('prefs' in body) p.prefs = [].concat(body.prefs || []).map(x => oneOf(x, core.COMPONENTS)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
    if ('night' in body) p.night = !!body.night;
    if ('health' in body && body.health && typeof body.health === 'object') {          // self-declared screening answers (yes = temporarily not eligible)
      p.health = Object.fromEntries(Object.keys(core.HEALTH).map(k => [k, body.health[k] === true]));
      p.healthAt = Date.now();
    }
    if (body.consent === true && !user.consentAt) p.consentAt = Date.now();
    Object.assign(user, p);
    if (user.verify && user.verify.status === 'verified' && user.verify.method === 'digilocker' && (p.name || p.dob)) {
      user.verify.mismatch = !dlNameMatches(user.verify.name || '', user.name || '') || (user.verify.dob && user.dob && user.verify.dob !== user.dob);
    }
    store.save();
    return { me: core.userView(user) };
  });
  // Real-time stream (server-sent events). The app opens it with fetch + Authorization header and reads events as they arrive.
  R.add('GET', '/api/live', { auth: 'user' }, ({ req, res, user, query }) => {
    live.add(req, res, user.id, parseFloat(query.lat), parseFloat(query.lng));
    return { __stream: true };
  });
  R.add('PUT', '/api/me/presence', { auth: 'user' }, ({ user, body }) => {
    if ('available' in body) user.available = !!body.available;
    const lat = parseFloat(body.lat), lng = parseFloat(body.lng);
    if (validLL(lat, lng)) { user.presence = { lat, lng, seen: Date.now() }; live.setPos(user.id, lat, lng); }
    store.save();
    const listed = core.donorListed(user, core.cfg());
    if (listed) { const d = core.publicDonor(user); live.emitNear(d.lat, d.lng, 'donor', d, user.id); }
    else live.emitAll('gone', { id: user.id });
    return { listed, eligible: core.eligibility(user).ok, verified: core.isVerified(user) };
  });
  // Right of access (DPDP Act): everything held about the signed-in person, as one JSON document.
  R.add('GET', '/api/me/export', { auth: 'user' }, ({ user }) => {
    const me = core.userView(user), v = user.verify || {};
    return {
      exportedAt: new Date().toISOString(), id: user.id, createdAt: user.createdAt, lastLogin: user.lastLogin || null, consentAt: user.consentAt || null,
      profile: me.profile, location: user.presence || null,
      verification: { status: v.status || 'none', method: v.method || '', name: v.name || '', dob: v.dob || '', gender: v.gender || '', last4: v.last4 || '', at: v.at || null, consentUntil: v.consentUntil || null },
      documents: me.documents, organPledge: user.organ || null,
      donations: store.filter('donations', d => d.userId === user.id).map(d => ({ date: new Date(d.t).toISOString().slice(0, 10), place: d.place, type: d.type, units: d.units })),
      requests: store.filter('requests', r => r.userId === user.id).map(r => ({ id: r.id, patient: r.patient, bg: r.bg, units: r.units, hospital: r.hospital, status: r.status, created: r.created })),
      offers: myOffers(user).map(o => ({ request: o.rid, state: o.state, at: o.at })),
      notifications: store.filter('notifications', n => n.userId === user.id).slice(-200).map(n => ({ at: n.at, title: n.title, body: n.body, read: n.read })),
      campRegistrations: store.filter('camps', c => (c.regs || []).includes(user.id)).map(c => ({ id: c.id, title: c.title, date: c.date }))
    };
  });
  R.add('POST', '/api/me/devices', { auth: 'user' }, ({ user, body }) => {
    const t = str(body.token, 400); if (!t) throw bad('token required');
    user.devices = (user.devices || []).filter(d => d.token !== t).concat({ token: t, platform: str(body.platform, 12, 'android'), at: Date.now() }).slice(-5);
    store.save(); return { ok: true };
  });
  R.add('DELETE', '/api/me', { auth: 'user' }, ({ user }) => { core.eraseUser(user.id); return { ok: true }; });
  R.add('POST', '/api/me/donations', { auth: 'user' }, ({ user, body }) => {
    if (!isDay(body.date) || body.date > today()) throw bad('Check the date');
    const d = store.insert('donations', { userId: user.id, t: new Date(body.date + 'T00:00:00').getTime(), place: str(body.place, 100), type: oneOf(body.type, core.COMPONENTS) || 'Whole blood', units: 1, manual: true });
    if (!user.last || body.date > user.last) user.last = body.date;
    store.save(); return { donation: d, me: core.userView(user) };
  });
  R.add('PUT', '/api/me/organ', { auth: 'user' }, ({ user, body }) => {
    const o = user.organ || {};
    const n = {
      pledged: !!body.pledged, organs: [].concat(body.organs || []).filter(x => ORGANS.includes(x)), tissues: [].concat(body.tissues || []).filter(x => TISSUES.includes(x)),
      kin: { name: str((body.kin || {}).name, 80), phone: str((body.kin || {}).phone, 20), rel: str((body.kin || {}).rel, 30) }, witness: { name: str((body.witness || {}).name, 80), phone: str((body.witness || {}).phone, 20) },
      informed: !!body.informed, notto: !!body.notto, living: body.living && typeof body.living === 'object' ? Object.fromEntries(Object.entries(body.living).slice(0, 10).map(([k, v]) => [str(k, 6), !!v])) : {}
    };
    if (n.pledged) {
      if (!n.organs.length && !n.tissues.length) throw bad('Choose at least one organ or tissue');
      if (!n.kin.name) throw bad('Next of kin is required');
      n.id = o.id || 'LL-' + crypto.randomBytes(4).toString('hex').toUpperCase(); n.at = o.at || Date.now();
    }
    user.organ = n; store.save();
    return { organ: n };
  });

  /* ---------- blood requests ---------- */
  const mustReq = id => { const r = store.get('requests', id); if (!r) throw new HttpError(404, 'Request not found'); return r; };
  R.add('POST', '/api/requests', { auth: 'user' }, ({ user, body }) => {
    if (!limiter.take('req:' + user.id, core.cfg().requestsPerHour, 3600e3)) throw new HttpError(429, 'You have raised several requests recently. Please wait before posting another.');
    const phone = A.normPhone(body.phone), bg = oneOf(body.bg, core.BGS), urgency = oneOf(body.urgency, core.URGENCY), units = Math.round(num(body.units, 1, 10) || 0);
    const patient = str(body.patient, 80), hospital = str(body.hospital, 120);
    if (!patient) throw bad('Enter the patient name'); if (!bg) throw bad('Choose the blood group needed'); if (!hospital) throw bad('Enter the hospital');
    if (!phone) throw bad('Enter a valid 10-digit mobile number'); if (!urgency || !units) throw bad('Check urgency and units');
    const hours = num(body.hrs, 1, 24 * 14) || 24;
    let lat = parseFloat(body.lat), lng = parseFloat(body.lng);
    const bankHost = store.find('banks', b => b.name.toLowerCase() === hospital.toLowerCase());
    const host = bankHost || store.find('centres', b => b.name.toLowerCase() === hospital.toLowerCase());
    if (host) { lat = host.lat; lng = host.lng; } else if (!validLL(lat, lng)) { if (user.presence) { lat = user.presence.lat; lng = user.presence.lng; } else throw bad('Location is required'); }
    if (store.find('requests', r => r.userId === user.id && r.status === 'open' && r.bg === bg && r.hospital.toLowerCase() === hospital.toLowerCase() && r.patient.toLowerCase() === patient.toLowerCase())) throw new HttpError(409, 'You already have an open request for this patient');
    const r = store.insert('requests', { userId: user.id, patient, bg, units, comp: oneOf(body.comp, core.COMPONENTS) || 'Whole blood', hospital, city: str(body.city, 60) || user.city || '', lat, lng, urgency, by: Date.now() + hours * 36e5,
      created: Date.now(), contact: phone, contactName: str(body.cname, 80) || user.name || '', note: str(body.note, 300), status: 'open', received: 0, responses: [], bankId: bankHost ? bankHost.id : '' });
    const alerted = core.alertDonors(r, 0);
    live.emitNear(r.lat, r.lng, 'feed', { id: r.id }, user.id, 40);
    return { request: core.reqView(r, user), alerted };
  });
  R.add('GET', '/api/requests/:id', { auth: 'user' }, ({ user, params }) => ({ request: core.reqView(mustReq(params.id), user) }));
  R.add('PATCH', '/api/requests/:id', { auth: 'user' }, ({ user, params, body }) => {
    const r = mustReq(params.id); if (r.userId !== user.id) throw new HttpError(403, 'Not your request');
    const s = oneOf(body.status, ['fulfilled', 'closed']); if (!s) throw bad('Bad status');
    r.status = s; if (s === 'fulfilled') r.received = r.units; store.save();
    return { request: core.reqView(r, user) };
  });
  R.add('POST', '/api/requests/:id/alert-wider', { auth: 'user' }, ({ user, params }) => {
    const r = mustReq(params.id); if (r.userId !== user.id) throw new HttpError(403, 'Not your request'); if (r.status !== 'open') throw bad('Request is not open');
    return { alerted: core.alertDonors(r, 15), request: core.reqView(r, user) };
  });
  R.add('POST', '/api/requests/:id/offer', { auth: 'user' }, ({ user, params, body }) => {
    const r = mustReq(params.id);
    if (r.status !== 'open') throw bad('This request is no longer open');
    if (r.userId === user.id) throw bad('You cannot offer on your own request');
    if (user.donor !== true || (user.role || 'user') !== 'user') throw new HttpError(403, 'Become a donor to offer your help', { code: 'donor_required' });
    if (!core.donorOk(user)) throw new HttpError(403, 'Verify your ID to donate', { code: 'verify_required', need: core.verifyNeed(user) });
    if (!user.bg || !core.canGive(user.bg, r.bg)) throw bad('Your blood group is not compatible with this request');
    const e = core.eligibility(user); if (!e.ok) throw bad('You are not eligible to donate right now');
    if (!body || body.accepted !== true) throw new HttpError(400, 'Please read and accept the donation instructions first', { code: 'instructions_required' });
    let x = r.responses.find(y => y.donorId === user.id);
    if (!x) { x = { id: crypto.randomBytes(6).toString('hex'), donorId: user.id, state: 'offered', at: Date.now() }; r.responses.push(x); }
    else if (['pinged', 'withdrawn', 'declined'].includes(x.state)) { x.state = 'offered'; x.at = Date.now(); }
    x.instructionsAt = Date.now();                       // when the donor accepted the donation instructions
    store.save();
    const pos = core.donorPos(user) || [r.lat, r.lng];
    core.notify(r.userId, 'offer_received', { name: core.shortName(user.name), bg: user.bg, km: Math.round(hav(r.lat, r.lng, pos[0], pos[1]) * 10) / 10 }, { requestId: r.id });
    return { request: core.reqView(r, user) };
  });
  R.add('DELETE', '/api/requests/:id/offer', { auth: 'user' }, ({ user, params }) => {
    const r = mustReq(params.id), x = r.responses.find(y => y.donorId === user.id);
    if (x && x.state !== 'confirmed') { x.state = 'withdrawn'; store.save(); live.emitUser(r.userId, 'notice', { request: r.id }); }
    return { request: core.reqView(r, user) };
  });
  R.add('POST', '/api/requests/:id/donated', { auth: 'user' }, ({ user, params }) => {
    const r = mustReq(params.id), x = r.responses.find(y => y.donorId === user.id);
    if (!x || x.state !== 'accepted') throw bad('Your offer has not been accepted yet');
    if (!core.confirmDonation(r, x)) throw bad('This request already has all the blood it needs. Thank you for stepping up!');
    return { request: core.reqView(r, user), me: core.userView(user) };
  });
  R.add('PATCH', '/api/requests/:id/responses/:rid', { auth: 'user' }, ({ user, params, body }) => {
    const r = mustReq(params.id); if (r.userId !== user.id) throw new HttpError(403, 'Not your request');
    const x = r.responses.find(y => y.id === params.rid); if (!x) throw new HttpError(404, 'Not found');
    const s = oneOf(body.state, ['accepted', 'declined', 'confirmed']); if (!s) throw bad('Bad state');
    if (s === 'accepted') {
      if (r.status !== 'open') throw bad('Request is not open');
      if (x.state !== 'offered') throw bad('This donor has not offered yet');
      x.state = 'accepted'; x.at = Date.now(); store.save();
      core.notify(x.donorId, 'offer_accepted', { requester: r.contactName || 'The requester' }, { requestId: r.id });
    } else if (s === 'declined') {
      if (!['offered', 'pinged'].includes(x.state)) throw bad('Cannot decline now');
      x.state = 'declined'; x.at = Date.now(); store.save();
      core.notify(x.donorId, 'offer_declined', { hospital: r.hospital }, { requestId: r.id });
    } else {
      if (!['accepted', 'offered'].includes(x.state)) throw bad('Cannot confirm now');
      core.confirmDonation(r, x);
    }
    return { request: core.reqView(r, user) };
  });
  R.add('POST', '/api/requests/:id/report', { auth: 'user' }, ({ user, params, body }) => {
    const r = mustReq(params.id);
    store.insert('reports', { kind: 'request', targetId: r.id, targetUser: r.userId, byUser: user.id, reason: str(body.reason, 300) || 'Suspicious request', at: Date.now(), status: 'open' });
    return { ok: true };
  });
  R.add('POST', '/api/reports', { auth: 'user' }, ({ user, body }) => {
    store.insert('reports', { kind: oneOf(body.kind, ['user', 'request', 'bug']) || 'bug', targetId: str(body.targetId, 40), targetUser: str(body.targetUser, 40), byUser: user.id, reason: str(body.reason, 500), at: Date.now(), status: 'open' });
    return { ok: true };
  });

  /* ---------- camps ---------- */
  R.add('POST', '/api/camps/:id/register', { auth: 'user' }, ({ user, params }) => {
    const c = store.get('camps', params.id); if (!c || c.status === 'cancelled') throw new HttpError(404, 'Camp not found');
    if (c.date < today()) throw bad('This camp has ended');
    c.regs = c.regs || [];
    if (!c.regs.includes(user.id)) { if (c.slots && c.regs.length >= c.slots) throw bad('This camp is full'); c.regs.push(user.id); store.save(); }
    return { ok: true, regCount: c.regs.length };
  });
  R.add('DELETE', '/api/camps/:id/register', { auth: 'user' }, ({ user, params }) => {
    const c = store.get('camps', params.id); if (c) { c.regs = (c.regs || []).filter(x => x !== user.id); store.save(); }
    return { ok: true };
  });

  /* ---------- notifications ---------- */
  R.add('GET', '/api/notifications', { auth: 'user' }, ({ user }) => ({
    items: store.filter('notifications', n => n.userId === user.id).sort((a, b) => b.at - a.at).slice(0, 60).map(n => ({ id: n.id, type: n.type, title: n.title, body: n.body, data: n.data, read: n.read, at: n.at }))
  }));
  R.add('POST', '/api/notifications/read', { auth: 'user' }, ({ user, body }) => {
    store.filter('notifications', n => n.userId === user.id && (body.all || [].concat(body.ids || []).includes(n.id))).forEach(n => { n.read = true; }); store.save();
    return { ok: true };
  });

  /* ---------- DigiLocker ---------- */
  R.add('POST', '/api/digilocker/start', { auth: 'user' }, async ({ user, body }) => {
    let r;
    try { r = await dl.start(user, body || {}); } catch (e) { console.error('digilocker start failed:', e.message); throw new HttpError(502, 'Could not start DigiLocker. Please try again.'); }
    if (r.error) throw bad(r.error); return r;
  });
  R.add('GET', '/api/digilocker/mock', { auth: 'public', raw: true }, ({ query }) => ({ __html: dl.MOCK ? dl.mockLoginPage(query.state || '') : 'Not available', code: dl.MOCK ? 200 : 404 }));
  R.add('POST', '/api/digilocker/mock/login', { auth: 'public', raw: true, form: true }, ({ body }) => { const r = dl.MOCK ? dl.mockLogin(body) : { html: 'Not available', code: 404 }; return { __html: r.html, code: r.code }; });
  R.add('POST', '/api/digilocker/mock/otp', { auth: 'public', raw: true, form: true }, ({ body }) => { const r = dl.MOCK ? dl.mockOtp(body) : { html: 'Not available', code: 404 }; return { __html: r.html, code: r.code }; });
  R.add('POST', '/api/digilocker/mock/consent', { auth: 'public', raw: true, form: true }, ({ body }) => dl.MOCK ? { __redirect: dl.mockConsent(body).redirect } : { __html: 'Not available', code: 404 });
  const dlReturn = async q => { const r = await dl.callback(q); return r.redirect ? { __redirect: r.redirect } : { __html: r.html, code: r.code }; };
  R.add('GET', '/api/digilocker/callback', { auth: 'public', raw: true }, ({ query }) => dlReturn(query));
  // provider flows return here: .../return/<state>?...provider params
  R.add('GET', '/api/digilocker/return/:state', { auth: 'public', raw: true }, ({ query, params }) => dlReturn(Object.assign({}, query, { state: params.state })));
  R.add('GET', '/api/digilocker/result', { auth: 'user' }, ({ user, query }) => {
    const r = dl.result(user, query.session); if (!r) throw new HttpError(404, 'Session not found');
    return Object.assign({}, r, { me: core.userView(user) });
  });

  /* ---------- direct verification ---------- */
  R.add('POST', '/api/verify/direct', { auth: 'user', maxBody: 3 * 1024 * 1024 }, ({ user, body }) => {
    const idType = oneOf(body.idType, ID_TYPES), num_ = str(body.idNumber, 24).replace(/[\s-]/g, '').toUpperCase(), name = str(body.name, 80);
    if (!idType || !num_ || !name || !/^data:image\/jpeg;base64,/.test(body.photo || '')) throw bad('Missing fields');
    if (user.verify && user.verify.status === 'pending') throw bad('You already have a verification under review');
    const ref = 'DV-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const dir = path.join(dataDir, 'verifications'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ref + '.jpg'), Buffer.from(body.photo.split(',')[1], 'base64'));
    store.insert('verifications', { ref, userId: user.id, idType, idNumber: num_, name, status: 'pending', created: Date.now() });
    user.verify = { status: 'pending', method: 'direct', ref, idType, last4: num_.slice(-4), at: Date.now() }; store.save();
    return { ref, status: 'pending', me: core.userView(user) };
  });
  R.add('GET', '/api/verify/status', { auth: 'user' }, ({ user }) => ({ status: (user.verify || {}).status || 'none', reason: (user.verify || {}).reason || '', me: core.userView(user) }));
};
