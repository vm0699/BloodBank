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

const HOSP_TYPES = ['Hospital', 'Blood bank', 'Clinic', 'NGO / Camp organiser'];

module.exports = function register(R, { store, core }) {
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
  R.add('POST', '/api/hospital/apply', { auth: 'user' }, ({ user, body }) => {
    if (user.hospital && user.hospital.status === 'approved') throw new HttpError(409, 'Your hospital is already approved');
    const o = hospitalBody(body, user, false);
    user.role = 'hospital'; user.donor = false; user.available = false;
    user.hospital = Object.assign({ components: ['Whole blood'] }, o, { status: 'pending', appliedAt: Date.now(), reason: '' });
    store.save();
    live.emitAll('gone', { id: user.id });
    return meView(user);
  });

  R.add('PUT', '/api/hospital', { auth: 'user' }, ({ user, body }) => {
    if (user.role !== 'hospital' || !user.hospital) throw bad('No hospital application yet');
    const o = hospitalBody(body, user, true);
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
    return { camp: campView(x), items: (x.regs || []).map(id => store.get('users', id)).filter(Boolean).map(u => ({ id: u.id, name: u.name || '', bg: u.bg || '', phone: A.showPhone(u.phone), verified: core.isVerified(u) })) };
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
};
module.exports.HOSP_TYPES = HOSP_TYPES;
