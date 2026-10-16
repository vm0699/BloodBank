'use strict';
// Account types and the hospital side of the app.
//   role "user"      looks for blood; can become a donor (donor flag) and then appears on the map / receives alerts
//   role "hospital"  hospital / blood bank / camp organiser: applies, is approved by a LifeLink admin, then manages
//                    its blood stock, camps and the requests raised at its hospital - all from the app.
// Every handler is synchronous between its checks and its writes, so concurrent users cannot interleave inside one
// operation (stock changes are deltas, camp seats and unit counts are checked and written in the same step).
const A = require('./lib/auth');
const live = require('./lib/live');
const { hav, validLL } = require('./lib/geo');
const { HttpError, bad, str, num, isDay, oneOf } = require('./lib/http');
const { geocode } = require('./lib/geocode');

const HOSP_TYPES = ['Hospital', 'Blood bank', 'Clinic', 'NGO / Camp organiser'];

module.exports = function register(R, { store, core, limiter }) {
  const today = () => core.dayKey(Date.now());
  const BGS = core.BGS;

  const hospView = u => {
    const h = u.hospital; if (!h) return null;
    return { name: h.name, type: h.type, regNo: h.regNo, address: h.address, city: h.city, area: h.area || '', lat: h.lat, lng: h.lng, phone: h.phone, hours: h.hours || '',
      components: h.components || ['Whole blood'], status: h.status, reason: h.reason || '', bankId: h.bankId || '', appliedAt: h.appliedAt || 0, decidedAt: h.decidedAt || 0 };
  };
  const bankView = b => ({ id: b.id, name: b.name, type: b.type || 'Hospital-based', lat: b.lat, lng: b.lng, city: b.city || '', phone: b.phone || '', hours: b.hours || '', address: b.address || '',
    components: b.components || ['Whole blood'], stock: Object.assign(Object.fromEntries(BGS.map(g => [g, 0])), b.stock || {}), rev: b.rev || 0, updatedAt: b.updatedAt || 0 });
  const approvedBank = user => {
    const h = user.hospital;
    if (user.role !== 'hospital' || !h) throw new HttpError(403, 'This needs a hospital account');
    if (h.status !== 'approved') throw new HttpError(403, h.status === 'rejected' ? 'Your hospital application was not approved' : 'Your hospital is waiting for approval');
    const b = store.get('banks', h.bankId); if (!b) throw new HttpError(404, 'Your blood bank record is missing. Contact support.');
    return b;
  };
  const hospitalBody = (body, user, partial) => {
    const o = {};
    const need = (k, label, min) => { const v = str(body[k], 160); if (v.length < (min || 2)) throw bad('Enter ' + label); return v; };
    if (!partial || 'name' in body) o.name = need('name', 'the hospital or blood bank name', 3);
    if (!partial || 'type' in body) { o.type = oneOf(body.type, HOSP_TYPES); if (!o.type) throw bad('Choose the organisation type'); }
    if (!partial || 'regNo' in body) o.regNo = need('regNo', 'the registration / licence number', 4);
    if (!partial || 'address' in body) o.address = need('address', 'the address', 5);
    if (!partial || 'city' in body) o.city = need('city', 'the city', 2);
    if (!partial || 'phone' in body) { const p = A.normPhone(body.phone); if (!p) throw bad('Enter a valid 10-digit phone number'); o.phone = p; }
    if ('area' in body) o.area = str(body.area, 60);
    if ('hours' in body) o.hours = str(body.hours, 80);
    if ('components' in body) o.components = [].concat(body.components || []).filter(x => core.COMPONENTS.includes(x));
    if (!partial || 'lat' in body || 'lng' in body) {
      let la = parseFloat(body.lat), lo = parseFloat(body.lng);
      if (!validLL(la, lo) && user.presence) { la = user.presence.lat; lo = user.presence.lng; }
      if (!validLL(la, lo)) throw bad('Set the location of the hospital');
      o.lat = la; o.lng = lo;
    }
    return o;
  };
  const meView = u => ({ me: core.userView(u) });
  // If the hospital did not pin itself with the phone's GPS, find the real building from name + address.
  async function pin(o, body) {
    if (body.geo === 'gps' || !(o.address || o.name)) return;
    const g = await geocode([o.name, o.address, o.city, 'Tamil Nadu, India'].filter(Boolean).join(', '), o.lat, o.lng, 40)
      || await geocode([o.address, o.city, 'India'].filter(Boolean).join(', '), o.lat, o.lng, 40);
    if (g) { o.lat = g.lat; o.lng = g.lng; o.geo = 'address'; }
  }

  /* ---------- account type ---------- */
  R.add('PUT', '/api/me/role', { auth: 'user' }, ({ user, body }) => {
    const role = oneOf(body.role, ['user', 'hospital']); if (!role) throw bad('Choose an account type');
    if ((user.role || 'user') === 'hospital' && user.hospital && user.hospital.status === 'approved' && role !== 'hospital') throw new HttpError(409, 'An approved hospital account cannot be switched. Contact support.');
    user.role = role;
    if (role === 'hospital') {                                     // a hospital account is not a donor
      user.donor = false; user.available = false;
      live.emitAll('gone', { id: user.id });
    } else if (user.hospital && user.hospital.status !== 'approved') user.hospital = null;
    store.save();
    return meView(user);
  });

  R.add('POST', '/api/me/donor', { auth: 'user' }, ({ user, body }) => {
    if ((user.role || 'user') !== 'user') throw bad('Hospital accounts cannot be donors');
    if (body.enable === false) {
      user.donor = false; user.available = false; store.save();
      live.emitAll('gone', { id: user.id });
      return meView(user);
    }
    if (!user.bg) throw bad('Add your blood group first');
    if (!(user.verify && user.verify.dob) && !user.dob) throw bad('Add your date of birth first');
    user.donor = true; user.donorSince = user.donorSince || Date.now();
    store.save();
    return meView(user);
  });

  /* ---------- hospital application ---------- */
  R.add('POST', '/api/hospital/apply', { auth: 'user' }, async ({ user, body }) => {
    if (user.hospital && user.hospital.status === 'approved') throw new HttpError(409, 'Your hospital is already approved');
    const o = hospitalBody(body, user, false);
    await pin(o, body);
    user.role = 'hospital'; user.donor = false; user.available = false;
    user.hospital = Object.assign({ components: ['Whole blood'] }, o, { status: 'pending', appliedAt: Date.now(), reason: '' });
    store.save();
    live.emitAll('gone', { id: user.id });
    return meView(user);
  });

  R.add('PUT', '/api/hospital', { auth: 'user' }, async ({ user, body }) => {
    if (user.role !== 'hospital' || !user.hospital) throw bad('No hospital application yet');
    const o = hospitalBody(body, user, true);
    if ('address' in o || 'name' in o || 'city' in o) { o.address = o.address || user.hospital.address; o.name = o.name || user.hospital.name; o.city = o.city || user.hospital.city;
      o.lat = o.lat != null ? o.lat : user.hospital.lat; o.lng = o.lng != null ? o.lng : user.hospital.lng; await pin(o, body); }
    Object.assign(user.hospital, o);
    if (user.hospital.status === 'approved') {                   // keep the public blood-bank record in step
      const b = store.get('banks', user.hospital.bankId);
      if (b) {
        ['name', 'type', 'address', 'city', 'area', 'phone', 'hours', 'components', 'lat', 'lng'].forEach(k => { if (k in o) b[k] = o[k]; });
        if ('type' in o) b.type = o.type === 'Blood bank' ? 'Blood bank' : 'Hospital-based';
        b.updatedAt = Date.now();
      }
    }
    store.save();
    return meView(user);
  });

  /* ---------- hospital dashboard ---------- */
  R.add('GET', '/api/hospital/dashboard', { auth: 'user' }, ({ user }) => {
    const b = approvedBank(user), c = core.cfg(), fresh = Date.now() - c.presenceFreshMin * 60e3;
    const name = String(b.name || '').toLowerCase();
    const atHospital = r => r.bankId === b.id || String(r.hospital || '').toLowerCase() === name;
    const reqRow = r => {
      const v = core.reqView(r, user);
      return { id: r.id, patient: r.patient, bg: r.bg, units: r.units, comp: r.comp, urgency: r.urgency, status: r.status, received: r.received || 0, created: r.created, by: r.by,
        responders: v.responders, note: r.note || '', contact: A.showPhone(r.contact), contactName: r.contactName || '', hospital: r.hospital, mine: r.userId === user.id, km: Math.round(hav(b.lat, b.lng, r.lat, r.lng) * 10) / 10 };
    };
    const reqs = store.list('requests').filter(r => atHospital(r) && (r.status === 'open' || Date.now() - r.created < 7 * 86400e3)).sort((a, z) => z.created - a.created).slice(0, 60).map(reqRow);
    const nearby = store.list('requests').filter(r => r.status === 'open' && !atHospital(r) && hav(b.lat, b.lng, r.lat, r.lng) <= 25).sort((a, z) => z.created - a.created).slice(0, 20).map(reqRow);
    const donorCounts = Object.fromEntries(BGS.map(g => [g, 0]));
    store.list('users').forEach(u => { if (core.donorListed(u, c) && (u.demo || u.presence.seen >= fresh) && hav(b.lat, b.lng, u.presence.lat, u.presence.lng) <= 15) donorCounts[u.bg]++; });
    const since = core.dayKey(Date.now() - 30 * 86400e3);
    const camps = store.list('camps').filter(x => x.bankId === b.id && x.date >= since).sort((a, z) => z.date.localeCompare(a.date)).slice(0, 40)
      .map(x => ({ id: x.id, title: x.title, date: x.date, time: x.time || '', venue: x.venue || '', slots: x.slots || 0, regCount: (x.regs || []).length, status: x.status || 'active' }));
    return { hospital: hospView(user), bank: bankView(b), requests: reqs, nearby, donorCounts, camps, serverTime: Date.now() };
  });

  /* ---------- stock: deltas are atomic; an absolute "set" must carry the revision it was based on ---------- */
  R.add('PATCH', '/api/hospital/stock', { auth: 'user' }, ({ user, body }) => {
    const b = approvedBank(user), g = oneOf(body.group, BGS); if (!g) throw bad('Choose a blood group');
    b.stock = b.stock || {};
    const cur = b.stock[g] || 0;
    if ('delta' in body) {
      const d = Math.round(num(body.delta, -500, 500)); if (d == null || Number.isNaN(d)) throw bad('Check the amount');
      b.stock[g] = Math.max(0, cur + d);
    } else if ('set' in body) {
      const n = Math.round(num(body.set, 0, 9999)); if (n == null || Number.isNaN(n)) throw bad('Check the amount');
      if (body.rev != null && +body.rev !== (b.rev || 0)) throw new HttpError(409, 'Stock was changed by someone else. Please review the new numbers.', { bank: bankView(b) });
      b.stock[g] = n;
    } else throw bad('Send a delta or a set value');
    b.rev = (b.rev || 0) + 1; b.updatedAt = Date.now(); b.updatedBy = user.id;
    store.save();
    return { bank: bankView(b) };
  });

  /* ---------- camps ---------- */
  const campView = x => ({ id: x.id, title: x.title, date: x.date, time: x.time || '', venue: x.venue || '', slots: x.slots || 0, regCount: (x.regs || []).length, status: x.status || 'active', lat: x.lat, lng: x.lng });
  const ownCamp = (user, id) => { const b = approvedBank(user), x = store.get('camps', id); if (!x || x.bankId !== b.id) throw new HttpError(404, 'Camp not found'); return x; };
  R.add('POST', '/api/hospital/camps', { auth: 'user' }, ({ user, body }) => {
    const b = approvedBank(user);
    const title = str(body.title, 120); if (title.length < 3) throw bad('Enter the camp title');
    if (!isDay(body.date) || body.date < today()) throw bad('Choose a date from today onwards');
    let la = parseFloat(body.lat), lo = parseFloat(body.lng); if (!validLL(la, lo)) { la = b.lat; lo = b.lng; }
    const slots = Math.round(num(body.slots, 1, 5000) || 50);
    const x = store.insert('camps', { title, org: b.name, host: b.name, bankId: b.id, date: body.date, time: str(body.time, 60) || '9:00 AM - 3:00 PM', venue: str(body.venue, 120) || b.address || b.name,
      lat: la, lng: lo, slots, regs: [], status: 'active', createdBy: user.id });
    live.emitNear(la, lo, 'feed', { camp: x.id }, user.id, 40);
    return { camp: campView(x) };
  });
  R.add('PATCH', '/api/hospital/camps/:id', { auth: 'user' }, ({ user, params, body }) => {
    const x = ownCamp(user, params.id);
    if ('title' in body) { const t = str(body.title, 120); if (t.length < 3) throw bad('Enter the camp title'); x.title = t; }
    if ('date' in body) { if (!isDay(body.date)) throw bad('Choose a valid date'); x.date = body.date; }
    ['time', 'venue'].forEach(k => { if (k in body) x[k] = str(body[k], 120); });
    if ('slots' in body) { const n = Math.round(num(body.slots, 1, 5000)); if (!n || n < (x.regs || []).length) throw bad('Seats cannot be fewer than people already registered'); x.slots = n; }
    if ('status' in body) {
      const s = oneOf(body.status, ['active', 'cancelled']); if (!s) throw bad('Bad status');
      if (s === 'cancelled' && x.status !== 'cancelled') (x.regs || []).forEach(id => core.notify(id, 'camp_cancelled', {}, { campId: x.id }, { title: 'Camp cancelled', body: x.title + ' on ' + x.date + ' was cancelled by the organiser.', titleTa: 'முகாம் ரத்து', bodyTa: x.title + ' (' + x.date + ') ஏற்பாட்டாளரால் ரத்து செய்யப்பட்டது.' }));
      x.status = s;
    }
    store.save();
    return { camp: campView(x) };
  });
  R.add('GET', '/api/hospital/camps/:id/registrations', { auth: 'user' }, ({ user, params }) => {
    const x = ownCamp(user, params.id);
    return { camp: campView(x), items: (x.regs || []).map(id => store.get('users', id)).filter(Boolean).map(u => ({ id: u.id, name: u.name || '', bg: u.bg || '', phone: A.showPhone(u.phone), verified: core.isVerified(u), attended: (x.attended || []).includes(u.id), last: u.last || '' })) };
  });

  /* ---------- requests raised at this hospital ---------- */
  R.add('PATCH', '/api/hospital/requests/:id', { auth: 'user' }, ({ user, params, body }) => {
    const b = approvedBank(user), r = store.get('requests', params.id); if (!r) throw new HttpError(404, 'Request not found');
    if (!(r.bankId === b.id || String(r.hospital || '').toLowerCase() === String(b.name || '').toLowerCase())) throw new HttpError(403, 'This request is not at your hospital');
    const s = oneOf(body.status, ['fulfilled', 'closed']); if (!s) throw bad('Bad status');
    if (r.status === 'open') {
      r.status = s; if (s === 'fulfilled') r.received = r.units;
      core.notify(r.userId, 'request_closed', { bg: r.bg, hospital: r.hospital }, { requestId: r.id });
      store.save();
    }
    return { ok: true, status: r.status };
  });

  /* ============ web dashboard extras: who am I, donor list, invitations, camp check-in, bank map, donation log ============ */
  const audit = (user, b, action, meta) => store.insert('audit', { at: Date.now(), by: 'hospital:' + b.name, role: 'hospital', action, target: user.id, meta: meta || {} });
  const dayStamp = () => core.dayKey(Date.now());

  R.add('GET', '/api/hospital/me', { auth: 'user' }, ({ user }) => ({ me: core.userView(user) }));

  // Registered donors around the hospital. Names, groups and areas only: phone numbers stay private (contact them with an invitation).
  R.add('GET', '/api/hospital/donors', { auth: 'user' }, ({ user, query }) => {
    const b = approvedBank(user), c = core.cfg(), fresh = Date.now() - c.presenceFreshMin * 60e3;
    const radius = Math.min(500, Math.max(1, +query.radius || 25)), bg = oneOf(query.bg, BGS) || '', q = str(query.q, 40).toLowerCase();
    const city = String(b.city || '').toLowerCase();
    let rows = store.list('users').filter(u => u.donor === true && (u.role || 'user') === 'user' && u.status !== 'suspended' && u.bg && (!bg || u.bg === bg)).map(u => {
      const km = u.presence ? hav(b.lat, b.lng, u.presence.lat, u.presence.lng) : null;
      return { u, km };
    }).filter(({ u, km }) => km != null ? km <= radius : String(u.city || '').toLowerCase() === city)
      .filter(({ u }) => (query.verified !== '1' || core.isVerified(u)) && (query.available !== '1' || core.donorListed(u, c)) && (!q || String(u.name || '').toLowerCase().includes(q) || String(u.city || '').toLowerCase().includes(q) || String(u.area || '').toLowerCase().includes(q)));
    rows = rows.map(({ u, km }) => {
      const e = core.eligibility(u);
      return { id: u.id, name: u.name || '', bg: u.bg, city: u.city || '', area: u.area || '', km: km == null ? null : Math.round(km * 10) / 10, verified: core.isVerified(u), listed: core.donorListed(u, c),
        online: !!(u.presence && (u.demo || u.presence.seen >= fresh)), eligible: e.ok, nextEligible: e.next ? core.dayKey(e.next) : '', last: u.last || '', prefs: u.prefs || [], night: !!u.night,
        donations: (u.donatedBefore || 0) + store.filter('donations', d => d.userId === u.id).length };
    }).sort((x, y) => (y.listed - x.listed) || ((x.km == null ? 1e9 : x.km) - (y.km == null ? 1e9 : y.km))).slice(0, 400);
    audit(user, b, 'hospital.donors.view', { count: rows.length, radius, bg });
    const counts = Object.fromEntries(BGS.map(g => [g, 0])); rows.forEach(r => { if (r.listed) counts[r.bg]++; });
    return { items: rows, total: rows.length, availableByGroup: counts, radius };
  });

  // Invite chosen donors to donate (an in-app notification in their language). Each donor can be invited by a hospital once every 6 hours.
  const sendInvites = (b, ids, title, body, titleTa, bodyTa, data) => {
    let sent = 0, skipped = 0;
    ids.forEach(id => {
      const u = store.get('users', id);
      if (!u || u.donor !== true || u.status === 'suspended' || !limiter.take('invite:' + b.id + ':' + id, 1, 6 * 3600e3)) { skipped++; return; }
      core.notify(id, 'hospital_invite', {}, Object.assign({ bankId: b.id }, data || {}), { title, body, titleTa, bodyTa }); sent++;
    });
    return { sent, skipped };
  };
  R.add('POST', '/api/hospital/invite', { auth: 'user' }, ({ user, body }) => {
    const b = approvedBank(user);
    if (!limiter.take('invite-batch:' + user.id, 30, 3600e3)) throw new HttpError(429, 'Too many invitations just now. Please wait a little.');
    const ids = [].concat(body.userIds || []).map(x => str(x, 40)).filter(Boolean).slice(0, 100); if (!ids.length) throw bad('Choose at least one donor');
    const msg = str(body.message, 200);
    const r = sendInvites(b, ids, b.name + ' needs blood donors', msg || 'Please consider donating blood at ' + b.name + ', ' + (b.city || '') + '. Every unit helps.',
      b.name + ' இரத்த கொடையாளர்களை அழைக்கிறது', msg || b.name + ' (' + (b.city || '') + ') இல் இரத்த தானம் செய்ய முடியுமா? ஒவ்வொரு யூனிட்டும் உதவும்.');
    audit(user, b, 'hospital.invite', r);
    return r;
  });
  R.add('POST', '/api/hospital/camps/:id/invite', { auth: 'user' }, ({ user, params, body }) => {
    const x = ownCamp(user, params.id), b = approvedBank(user), c = core.cfg();
    if (x.status === 'cancelled') throw bad('This camp is cancelled');
    if (!limiter.take('camp-invite:' + x.id, 6, 24 * 3600e3)) throw new HttpError(429, 'You already invited donors to this camp several times today.');
    const radius = Math.min(100, Math.max(1, +body.radiusKm || 25));
    const ids = store.list('users').filter(u => core.donorListed(u, c) && !(x.regs || []).includes(u.id) && hav(x.lat, x.lng, u.presence.lat, u.presence.lng) <= radius).slice(0, 300).map(u => u.id);
    const r = sendInvites(b, ids, 'Blood camp near you: ' + x.title, x.date + ' - ' + (x.venue || b.name) + '. Open Blood drives in LifeLink to register.',
      'அருகில் இரத்த தான முகாம்: ' + x.title, x.date + ' - ' + (x.venue || b.name) + '. பதிவு செய்ய LifeLink இல் "இரத்த தான முகாம்கள்" திறக்கவும்.', { campId: x.id });
    audit(user, b, 'hospital.camp.invite', Object.assign({ camp: x.id }, r));
    return Object.assign({ candidates: ids.length }, r);
  });

  // Camp day: mark a registered donor as having donated -> donation recorded, the donor's cooldown starts, the bank's stock goes up by one
  R.add('POST', '/api/hospital/camps/:id/checkin', { auth: 'user' }, ({ user, params, body }) => {
    const x = ownCamp(user, params.id), b = approvedBank(user), u = store.get('users', str(body.userId, 40));
    if (!u || !(x.regs || []).includes(u.id)) throw bad('This person is not registered for the camp');
    if (x.status === 'cancelled') throw bad('This camp is cancelled');
    x.attended = x.attended || [];
    if (x.attended.includes(u.id)) throw new HttpError(409, 'Already recorded for this camp');
    x.attended.push(u.id);
    store.insert('donations', { userId: u.id, t: Date.now(), place: b.name, type: 'Whole blood', units: 1, forWho: 'Camp: ' + x.title, campId: x.id, bankId: b.id });
    u.last = dayStamp(); u.notified = Object.assign({}, u.notified, { eligibleOn: null });
    if (u.bg) { b.stock = b.stock || {}; b.stock[u.bg] = (b.stock[u.bg] || 0) + 1; b.rev = (b.rev || 0) + 1; b.updatedAt = Date.now(); }
    core.notify(u.id, 'donation_confirmed', {}, { campId: x.id }, { title: 'Donation recorded', body: 'Thank you for donating at ' + x.title + '. You can donate again in 3 months.', titleTa: 'தானம் பதிவு செய்யப்பட்டது', bodyTa: x.title + ' இல் தானம் செய்ததற்கு நன்றி. 3 மாதங்களுக்குப் பிறகு மீண்டும் தானம் செய்யலாம்.' });
    audit(user, b, 'hospital.camp.checkin', { camp: x.id });
    store.save();
    return { ok: true, attended: x.attended.length, bank: bankView(b) };
  });

  // Every blood bank with its stock (hospital accounts only) - for the bank map
  R.add('GET', '/api/hospital/banks', { auth: 'user' }, ({ user }) => {
    const mine = approvedBank(user);
    return { items: store.list('banks').filter(b => b.active !== false).map(b => Object.assign(bankView(b), { mine: b.id === mine.id, km: Math.round(hav(mine.lat, mine.lng, b.lat, b.lng) * 10) / 10 })).sort((a, z) => a.km - z.km) };
  });

  // Donations recorded at this hospital (camp check-ins and requests raised here)
  R.add('GET', '/api/hospital/donations', { auth: 'user' }, ({ user }) => {
    const b = approvedBank(user), name = String(b.name || '').toLowerCase();
    const reqHere = new Set(store.filter('requests', r => r.bankId === b.id || String(r.hospital || '').toLowerCase() === name).map(r => r.id));
    const items = store.filter('donations', d => d.bankId === b.id || (d.requestId && reqHere.has(d.requestId)) || String(d.place || '').toLowerCase() === name)
      .sort((a, z) => z.t - a.t).slice(0, 200).map(d => { const u = store.get('users', d.userId) || {}; return { id: d.id, t: d.t, donor: u.name || 'Donor', bg: u.bg || '', units: d.units || 1, type: d.type || 'Whole blood', source: d.forWho || '' }; });
    return { items };
  });
};
module.exports.HOSP_TYPES = HOSP_TYPES;
