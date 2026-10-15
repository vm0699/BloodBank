'use strict';
// Admin / blood-bank-staff API (served under /api/admin). Roles:
//   admin : everything (us)
//   staff : only their own blood bank - inventory, camps and camp registrants
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A = require('./lib/auth');
const { HttpError, bad, str, num, isDay, oneOf } = require('./lib/http');
const { validLL } = require('./lib/geo');

module.exports = function register(R, { store, core, dl, env, dataDir, limiter }) {
  const adm = { auth: 'admin' }, only = { auth: 'admin', role: 'admin' };
  const today = () => core.dayKey(Date.now());
  const audit = (a, action, target, meta) => store.insert('audit', { at: Date.now(), by: a.email, role: a.role, action, target: target || '', meta: meta || {} });
  const page = (arr, q) => { const size = Math.min(100, Math.max(1, +q.size || 25)), p = Math.max(1, +q.page || 1); return { items: arr.slice((p - 1) * size, p * size), total: arr.length, page: p, size }; };
  const has = (v, q) => String(v || '').toLowerCase().includes(q);
  const csv = rows => rows.map(r => r.map(v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n');
  const BGS = core.BGS;
  const adminView = a => ({ id: a.id, email: a.email, name: a.name, role: a.role, bankId: a.bankId || '', active: a.active !== false, lastLogin: a.lastLogin || 0 });
  const userRow = u => ({ id: u.id, name: u.name || '', phone: u.phone, bg: u.bg || '', city: u.city || '', gender: u.gender || '', verify: (u.verify || {}).status || 'none', method: (u.verify || {}).method || '', mismatch: !!(u.verify || {}).mismatch,
    available: !!u.available, listed: core.donorListed(u, core.cfg()), status: u.status || 'active', createdAt: u.createdAt || 0, lastLogin: u.lastLogin || 0, demo: !!u.demo,
    donations: (u.donatedBefore || 0) + store.filter('donations', d => d.userId === u.id).length, organ: !!(u.organ && u.organ.pledged), lang: u.lang || 'en' });
  const bankRow = b => Object.assign({}, b, { stock: Object.assign(Object.fromEntries(BGS.map(g => [g, 0])), b.stock || {}) });
  const staffBank = a => { if (a.role === 'staff') { if (!a.bankId) throw new HttpError(403, 'No bank assigned to this account'); return a.bankId; } return null; };
  const needBankAccess = (a, id) => { if (a.role === 'staff' && a.bankId !== id) throw new HttpError(403, 'Not your bank'); };

  /* ---------- login ---------- */
  R.add('POST', '/api/admin/login', { auth: 'public' }, ({ body, ip }) => {
    const email = str(body.email, 120).toLowerCase();
    if (!limiter.take('adm:' + ip + email, 8, 15 * 60e3)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const a = store.find('admins', x => x.email === email);
    if (!a || a.active === false || !A.checkPassword(String(body.password || ''), a.pass)) throw new HttpError(401, 'Wrong email or password');
    a.lastLogin = Date.now(); store.save(); audit(a, 'login');
    return { token: A.sign({ sub: a.id, typ: 'admin', tv: a.tv || 0 }, dataDir, 12 * 3600), admin: adminView(a) };
  });
  R.add('GET', '/api/admin/me', adm, ({ admin }) => ({ admin: adminView(admin) }));
  R.add('POST', '/api/admin/password', adm, ({ admin, body }) => {
    if (!A.checkPassword(String(body.current || ''), admin.pass)) throw new HttpError(401, 'Current password is wrong');
    if (String(body.next || '').length < 10) throw bad('Use at least 10 characters');
    admin.pass = A.hashPassword(body.next); admin.tv = (admin.tv || 0) + 1; store.save(); audit(admin, 'password.change');
    return { ok: true, token: A.sign({ sub: admin.id, typ: 'admin', tv: admin.tv }, dataDir, 12 * 3600) };
  });

  /* ---------- dashboard ---------- */
  R.add('GET', '/api/admin/stats', adm, ({ admin }) => {
    const c = core.cfg(), users = store.list('users'), reqs = store.list('requests');
    if (admin.role === 'staff') {
      const b = store.get('banks', admin.bankId), camps = store.filter('camps', x => x.bankId === admin.bankId && x.date >= today() && x.status !== 'cancelled');
      return { role: 'staff', bank: b ? bankRow(b) : null, upcomingCamps: camps.length, registrations: camps.reduce((n, x) => n + (x.regs || []).length, 0), lowGroups: b ? BGS.filter(g => ((b.stock || {})[g] || 0) < 5) : [] };
    }
    const byDay = [];
    for (let i = 13; i >= 0; i--) { const k = core.dayKey(Date.now() - i * 864e5); byDay.push({ date: k, requests: reqs.filter(r => core.dayKey(r.created) === k).length, signups: users.filter(u => core.dayKey(u.createdAt || 0) === k).length }); }
    const live = users.filter(u => !u.demo);
    return {
      role: 'admin', users: users.length, realUsers: live.length, verified: users.filter(core.isVerified).length, listed: users.filter(u => core.donorListed(u, c)).length, newWeek: users.filter(u => Date.now() - (u.createdAt || 0) < 7 * 864e5).length,
      requestsOpen: reqs.filter(r => r.status === 'open').length, requestsFulfilled: reqs.filter(r => r.status === 'fulfilled').length, requestsTotal: reqs.length,
      donations: store.list('donations').length, organPledges: users.filter(u => u.organ && u.organ.pledged).length,
      pendingVerifications: store.filter('verifications', v => v.status === 'pending').length, pendingHospitals: users.filter(u => u.hospital && u.hospital.status === 'pending').length, mismatches: users.filter(u => u.verify && u.verify.mismatch).length, openReports: store.filter('reports', r => r.status === 'open').length,
      banks: store.list('banks').length, campsUpcoming: store.filter('camps', x => x.date >= today() && x.status !== 'cancelled').length, centres: store.list('centres').length,
      byBg: Object.fromEntries(BGS.map(g => [g, users.filter(u => u.bg === g).length])), listedByBg: Object.fromEntries(BGS.map(g => [g, users.filter(u => u.bg === g && core.donorListed(u, c)).length])),
      lowStock: store.list('banks').map(b => ({ id: b.id, name: b.name, low: BGS.filter(g => ((b.stock || {})[g] || 0) < 5) })).filter(x => x.low.length > 3).slice(0, 8), byDay
    };
  });

  /* ---------- users / donors ---------- */
  R.add('GET', '/api/admin/users', only, ({ query }) => {
    const q = str(query.q, 60).toLowerCase();
    let a = store.list('users').filter(u => (!q || has(u.name, q) || has(u.phone, q) || has(u.city, q) || has(u.id, q))
      && (!query.bg || u.bg === query.bg) && (!query.verify || ((u.verify || {}).status || 'none') === query.verify) && (!query.status || (u.status || 'active') === query.status)
      && (!query.mismatch || (u.verify || {}).mismatch) && (!query.listed || core.donorListed(u, core.cfg())) && (!query.organ || (u.organ && u.organ.pledged)));
    a = a.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    const r = page(a, query); r.items = r.items.map(userRow); return r;
  });
  R.add('GET', '/api/admin/users/:id', only, ({ params }) => {
    const u = store.get('users', params.id); if (!u) throw new HttpError(404, 'Not found');
    const view = core.userView(u);
    return { user: Object.assign(userRow(u), { profile: view.profile, verify: u.verify || { status: 'none' }, organ: u.organ || {}, documents: (u.documents || []).map(d => ({ id: d.id, name: d.name, type: d.type, issuer: d.issuer, at: d.at, file: !!d.file })),
      donations: store.filter('donations', d => d.userId === u.id).sort((a, b) => b.t - a.t), requests: store.filter('requests', r => r.userId === u.id).map(r => ({ id: r.id, bg: r.bg, units: r.units, status: r.status, hospital: r.hospital, created: r.created })),
      eligible: view.eligible, eligibleFrom: view.eligibleFrom, qualifies: view.verified, verifyNeed: view.verifyNeed, devices: (u.devices || []).length, presence: u.presence || null, suspendReason: u.suspendReason || '' }) };
  });
  R.add('PATCH', '/api/admin/users/:id', only, ({ admin, params, body }) => {
    const u = store.get('users', params.id); if (!u) throw new HttpError(404, 'Not found');
    const p = {};
    if ('name' in body) p.name = str(body.name, 80); if ('city' in body) p.city = str(body.city, 60);
    if ('bg' in body) { p.bg = oneOf(body.bg, BGS); if (!p.bg) throw bad('Bad blood group'); }
    if ('gender' in body) p.gender = oneOf(body.gender, ['M', 'F', 'O']) || '';
    if ('dob' in body) { if (body.dob && !isDay(body.dob)) throw bad('Bad date of birth'); p.dob = body.dob || ''; }
    if ('last' in body) { if (body.last && !isDay(body.last)) throw bad('Bad last donation date'); p.last = body.last || ''; }
    if ('weight' in body) p.weight = body.weight === '' ? '' : num(body.weight, 20, 250) || '';
    if ('available' in body) p.available = !!body.available;
    if ('email' in body) p.email = str(body.email, 120);
    Object.assign(u, p); store.save(); audit(admin, 'user.edit', u.id, p);
    return { ok: true };
  });
  R.add('POST', '/api/admin/users/:id/verify', only, ({ admin, params, body }) => {
    const u = store.get('users', params.id); if (!u) throw new HttpError(404, 'Not found');
    u.verify = Object.assign({}, u.verify || {}, { status: 'verified', method: (u.verify || {}).method || 'manual', at: Date.now(), by: admin.email, mismatch: false, note: str(body.note, 200) }); store.save();
    core.notify(u.id, 'verified', {}, {}); audit(admin, 'user.verify', u.id); return { ok: true };
  });
  R.add('POST', '/api/admin/users/:id/unverify', only, ({ admin, params, body }) => {
    const u = store.get('users', params.id); if (!u) throw new HttpError(404, 'Not found');
    u.verify = { status: 'rejected', reason: str(body.reason, 200) || 'Verification removed by an administrator' }; u.available = false; store.save();
    core.notify(u.id, 'verify_rejected', { reason: u.verify.reason }, {}); audit(admin, 'user.unverify', u.id, { reason: u.verify.reason }); return { ok: true };
  });
  R.add('POST', '/api/admin/users/:id/suspend', only, ({ admin, params, body }) => {
    const u = store.get('users', params.id); if (!u) throw new HttpError(404, 'Not found');
    u.status = 'suspended'; u.suspendReason = str(body.reason, 200); u.available = false; u.tv = (u.tv || 0) + 1; store.save();
    core.notify(u.id, 'account_suspended', {}, {}); audit(admin, 'user.suspend', u.id, { reason: u.suspendReason }); return { ok: true };
  });
  R.add('POST', '/api/admin/users/:id/unsuspend', only, ({ admin, params }) => {
    const u = store.get('users', params.id); if (!u) throw new HttpError(404, 'Not found');
    u.status = 'active'; u.suspendReason = ''; store.save(); audit(admin, 'user.unsuspend', u.id); return { ok: true };
  });
  R.add('POST', '/api/admin/users/:id/notify', only, async ({ admin, params, body }) => {
    const u = store.get('users', params.id); if (!u) throw new HttpError(404, 'Not found');
    const title = str(body.title, 80), text = str(body.body, 300); if (!title || !text) throw bad('Title and message are required');
    await core.notify(u.id, 'broadcast', {}, {}, { title, body: text, titleTa: str(body.titleTa, 80), bodyTa: str(body.bodyTa, 300) }); audit(admin, 'user.notify', u.id); return { ok: true };
  });
  R.add('DELETE', '/api/admin/users/:id', only, ({ admin, params }) => {
    if (!store.get('users', params.id)) throw new HttpError(404, 'Not found');
    core.eraseUser(params.id); audit(admin, 'user.erase', params.id); return { ok: true };
  });
  R.add('GET', '/api/admin/users/:id/doc/:docId', only, ({ admin, params }) => {
    const u = store.get('users', params.id), d = u && (u.documents || []).find(x => x.id === params.docId);
    if (!d || !d.file) throw new HttpError(404, 'No stored file for this document');
    audit(admin, 'user.doc.view', u.id, { doc: d.type });
    return { __raw: fs.readFileSync(path.join(dataDir, 'docs', u.id, d.id + '.bin')), type: d.mime || 'application/pdf' };
  });

  /* ---------- direct verifications ---------- */
  /* ---------- system check: what is this server actually configured with, and does it work? ---------- */
  R.add('GET', '/api/admin/diagnostics', only, async () => {
    const sms = require('./lib/sms');
    let db = 'down'; try { db = await store.health(); } catch (e) { db = 'down: ' + String(e.message).slice(0, 120); }
    return {
      time: new Date().toISOString(), nodeEnv: env.NODE_ENV || '', publicBaseUrl: env.PUBLIC_BASE_URL || '', database: db, devOtp: env.DEV_OTP === '1',
      sms: { provider: sms.provider(), missing: sms.missing() || '' }, digilocker: await dl.diagnose(),
      users: store.list('users').length, hospitalsPending: store.list('users').filter(u => u.hospital && u.hospital.status === 'pending').length
    };
  });

  /* ---------- hospital applications (account type "hospital") ---------- */
  const hospRow = u => ({ userId: u.id, phone: u.phone, contactName: u.name || '', status: u.hospital.status, reason: u.hospital.reason || '', appliedAt: u.hospital.appliedAt || 0, decidedAt: u.hospital.decidedAt || 0,
    name: u.hospital.name, type: u.hospital.type, regNo: u.hospital.regNo, address: u.hospital.address, city: u.hospital.city, hospPhone: u.hospital.phone, lat: u.hospital.lat, lng: u.hospital.lng, bankId: u.hospital.bankId || '' });
  R.add('GET', '/api/admin/hospitals', only, ({ query }) => {
    const st = query.status || 'pending';
    return { items: store.filter('users', u => u.hospital && u.hospital.status === st).sort((a, b) => (a.hospital.appliedAt || 0) - (b.hospital.appliedAt || 0)).map(hospRow) };
  });
  R.add('POST', '/api/admin/hospitals/:userId/decision', only, ({ admin, params, body }) => {
    const u = store.get('users', params.userId); if (!u || !u.hospital) throw new HttpError(404, 'Application not found');
    const h = u.hospital;
    if (body.approve) {
      if (h.status !== 'approved') {
        let b = h.bankId && store.get('banks', h.bankId);
        if (!b) b = store.insert('banks', { name: h.name, type: h.type === 'Blood bank' ? 'Blood bank' : 'Hospital-based', lat: h.lat, lng: h.lng, city: h.city, area: h.area || h.city, address: h.address, phone: h.phone,
          hours: h.hours || '', components: h.components && h.components.length ? h.components : ['Whole blood'], stock: {}, active: true, ownerUserId: u.id, regNo: h.regNo, rev: 0, updatedAt: Date.now() });
        h.bankId = b.id; h.status = 'approved'; h.reason = ''; h.decidedAt = Date.now();
        core.notify(u.id, 'hospital_approved', {}, { bankId: b.id }, { title: 'Your hospital is approved', body: h.name + ' is live on LifeLink. You can now manage blood stock, camps and requests.',
          titleTa: 'உங்கள் மருத்துவமனை அங்கீகரிக்கப்பட்டது', bodyTa: h.name + ' இப்போது LifeLink இல் உள்ளது. இரத்த இருப்பு, முகாம்கள், கோரிக்கைகளை நிர்வகிக்கலாம்.' });
      }
    } else {
      if (h.status === 'approved') throw new HttpError(409, 'Already approved. Deactivate its blood bank in Blood banks instead.');
      h.status = 'rejected'; h.reason = str(body.reason, 200) || 'Details could not be verified'; h.decidedAt = Date.now();
      core.notify(u.id, 'hospital_rejected', {}, {}, { title: 'Hospital application not approved', body: h.reason + '. Update your details and apply again.', titleTa: 'மருத்துவமனை விண்ணப்பம் ஏற்கப்படவில்லை', bodyTa: h.reason + '. விவரங்களைப் புதுப்பித்து மீண்டும் விண்ணப்பிக்கவும்.' });
    }
    store.save(); audit(admin, body.approve ? 'hospital.approve' : 'hospital.reject', u.id, { name: h.name });
    return { hospital: hospRow(u) };
  });

  R.add('GET', '/api/admin/verifications', only, ({ query }) => {
    const st = query.status || 'pending';
    return { items: store.filter('verifications', v => v.status === st).sort((a, b) => a.created - b.created).map(v => { const u = store.get('users', v.userId) || {}; return { id: v.id, ref: v.ref, idType: v.idType, idNumber: v.idNumber, name: v.name, status: v.status, created: v.created, user: { id: u.id, name: u.name, phone: u.phone, dob: u.dob, bg: u.bg } }; }) };
  });
  R.add('GET', '/api/admin/verifications/:id/photo', only, ({ admin, params }) => {
    const v = store.get('verifications', params.id); if (!v) throw new HttpError(404, 'Not found');
    try { audit(admin, 'verification.photo.view', v.ref); return { __raw: fs.readFileSync(path.join(dataDir, 'verifications', v.ref + '.jpg')), type: 'image/jpeg' }; } catch (e) { throw new HttpError(404, 'Photo removed'); }
  });
  R.add('POST', '/api/admin/verifications/:id/decision', only, ({ admin, params, body }) => {
    const v = store.get('verifications', params.id); if (!v || v.status !== 'pending') throw new HttpError(404, 'Not pending');
    const ok = body.decision === 'approve', u = store.get('users', v.userId);
    v.status = ok ? 'verified' : 'rejected'; v.reason = str(body.reason, 200); v.decidedBy = admin.email; v.decidedAt = Date.now();
    if (ok) { v.idNumber = '*'.repeat(Math.max(0, v.idNumber.length - 4)) + v.idNumber.slice(-4); try { fs.unlinkSync(path.join(dataDir, 'verifications', v.ref + '.jpg')); } catch (e) {} }
    if (u) {
      const same = require('./lib/digilocker').nameMatches(v.name, u.name || '');
      u.verify = ok ? { status: 'verified', method: 'direct', at: Date.now(), idType: v.idType, last4: v.idNumber.slice(-4), name: v.name, ref: v.ref, mismatch: !same, by: admin.email } : { status: 'rejected', method: 'direct', reason: v.reason || 'We could not verify your ID. Please try again.', ref: v.ref };
      core.notify(u.id, ok ? 'verified' : 'verify_rejected', { reason: v.reason }, {});
    }
    store.save(); audit(admin, 'verification.' + v.status, v.ref, { reason: v.reason });
    return { ok: true };
  });

  /* ---------- requests & reports ---------- */
  R.add('GET', '/api/admin/requests', only, ({ query }) => {
    const q = str(query.q, 60).toLowerCase();
    const a = store.list('requests').filter(r => (!query.status || r.status === query.status) && (!query.bg || r.bg === query.bg) && (!q || has(r.patient, q) || has(r.hospital, q) || has(r.city, q))).sort((x, y) => y.created - x.created);
    const r = page(a, query); r.items = r.items.map(x => { const u = store.get('users', x.userId) || {}; return { id: x.id, patient: x.patient, bg: x.bg, units: x.units, comp: x.comp, urgency: x.urgency, hospital: x.hospital, city: x.city, status: x.status, received: x.received, created: x.created, by: x.by,
      contact: x.contact, requester: { id: u.id, name: u.name, phone: u.phone }, alerted: x.responses.length, offers: x.responses.filter(y => ['offered', 'accepted', 'confirmed'].includes(y.state)).length }; }); return r;
  });
  R.add('PATCH', '/api/admin/requests/:id', only, ({ admin, params, body }) => {
    const r = store.get('requests', params.id); if (!r) throw new HttpError(404, 'Not found');
    const s = oneOf(body.status, ['open', 'fulfilled', 'closed', 'expired']); if (!s) throw bad('Bad status');
    r.status = s; store.save(); audit(admin, 'request.' + s, r.id); return { ok: true };
  });
  R.add('POST', '/api/admin/requests/:id/alert', only, ({ admin, params }) => {
    const r = store.get('requests', params.id); if (!r || r.status !== 'open') throw bad('Request is not open');
    const n = core.alertDonors(r, 20); audit(admin, 'request.alert', r.id, { n }); return { alerted: n };
  });
  R.add('DELETE', '/api/admin/requests/:id', only, ({ admin, params }) => { store.remove('requests', params.id); audit(admin, 'request.delete', params.id); return { ok: true }; });
  R.add('GET', '/api/admin/reports', only, ({ query }) => ({
    items: store.filter('reports', r => !query.status || r.status === query.status).sort((a, b) => b.at - a.at).slice(0, 200).map(r => {
      const by = store.get('users', r.byUser) || {}, tu = store.get('users', r.targetUser) || {}, rq = r.kind === 'request' ? store.get('requests', r.targetId) : null;
      return { id: r.id, kind: r.kind, reason: r.reason, at: r.at, status: r.status, resolution: r.resolution || '', by: { id: by.id, name: by.name, phone: by.phone }, target: rq ? { requestId: rq.id, summary: rq.bg + ' · ' + rq.hospital + ' · ' + rq.patient, status: rq.status } : null, targetUser: tu.id ? { id: tu.id, name: tu.name, phone: tu.phone, status: tu.status } : null };
    })
  }));
  R.add('POST', '/api/admin/reports/:id/resolve', only, ({ admin, params, body }) => {
    const r = store.get('reports', params.id); if (!r) throw new HttpError(404, 'Not found');
    const act = oneOf(body.action, ['dismiss', 'close_request', 'suspend_user']) || 'dismiss';
    if (act === 'close_request' && r.targetId) { const q = store.get('requests', r.targetId); if (q) q.status = 'closed'; }
    if (act === 'suspend_user' && r.targetUser) { const u = store.get('users', r.targetUser); if (u) { u.status = 'suspended'; u.suspendReason = 'Report: ' + r.reason.slice(0, 80); u.available = false; u.tv = (u.tv || 0) + 1; } }
    r.status = 'resolved'; r.resolution = act + (body.note ? ': ' + str(body.note, 200) : ''); store.save(); audit(admin, 'report.' + act, r.id); return { ok: true };
  });

  /* ---------- blood banks & stock (staff: own bank only) ---------- */
  const bankBody = (b, partial) => {
    const o = {};
    if (!partial || 'name' in b) { o.name = str(b.name, 120); if (!o.name) throw bad('Name is required'); }
    if (!partial || 'lat' in b || 'lng' in b) { const la = parseFloat(b.lat), lo = parseFloat(b.lng); if (!validLL(la, lo)) throw bad('Pick the location on the map'); o.lat = la; o.lng = lo; }
    ['type', 'hours', 'phone', 'address', 'city', 'area'].forEach(k => { if (k in b) o[k] = str(b[k], 160); });
    if ('components' in b) o.components = [].concat(b.components || []).filter(x => core.COMPONENTS.includes(x));
    if ('active' in b) o.active = !!b.active;
    return o;
  };
  R.add('GET', '/api/admin/banks', adm, ({ admin, query }) => {
    const q = str(query.q, 60).toLowerCase(), only_ = admin.role === 'staff' ? admin.bankId : null;
    return { items: store.list('banks').filter(b => (!only_ || b.id === only_) && (!q || has(b.name, q) || has(b.city, q))).map(bankRow) };
  });
  R.add('POST', '/api/admin/banks', only, ({ admin, body }) => { const b = store.insert('banks', Object.assign({ stock: {}, active: true, components: ['Whole blood'], updatedAt: Date.now() }, bankBody(body))); audit(admin, 'bank.create', b.id); return { bank: bankRow(b) }; });
  R.add('PUT', '/api/admin/banks/:id', adm, ({ admin, params, body }) => {
    needBankAccess(admin, params.id); const b = store.get('banks', params.id); if (!b) throw new HttpError(404, 'Not found');
    const p = bankBody(body, true); if (admin.role === 'staff') delete p.active;
    Object.assign(b, p, { updatedAt: Date.now() }); store.save(); audit(admin, 'bank.edit', b.id); return { bank: bankRow(b) };
  });
  R.add('PUT', '/api/admin/banks/:id/stock', adm, ({ admin, params, body }) => {
    needBankAccess(admin, params.id); const b = store.get('banks', params.id); if (!b) throw new HttpError(404, 'Not found');
    const s = {}; BGS.forEach(g => { const n = num((body.stock || {})[g], 0, 9999); s[g] = n == null ? ((b.stock || {})[g] || 0) : Math.round(n); });
    b.stock = s; b.updatedAt = Date.now(); store.save(); audit(admin, 'bank.stock', b.id, s); return { bank: bankRow(b) };
  });
  R.add('DELETE', '/api/admin/banks/:id', only, ({ admin, params }) => { store.remove('banks', params.id); audit(admin, 'bank.delete', params.id); return { ok: true }; });

  /* ---------- camps ---------- */
  const campBody = (b, admin, partial) => {
    const o = {};
    if (!partial || 'title' in b) { o.title = str(b.title, 120); if (!o.title) throw bad('Title is required'); }
    if (!partial || 'date' in b) { if (!isDay(b.date)) throw bad('Choose a valid date'); o.date = b.date; }
    if (!partial || 'lat' in b || 'lng' in b) { const la = parseFloat(b.lat), lo = parseFloat(b.lng); if (!validLL(la, lo)) throw bad('Pick the location on the map'); o.lat = la; o.lng = lo; }
    ['org', 'time', 'venue'].forEach(k => { if (k in b) o[k] = str(b[k], 120); });
    if ('slots' in b) o.slots = Math.round(num(b.slots, 0, 5000) || 0);
    if ('status' in b) o.status = oneOf(b.status, ['active', 'cancelled']) || 'active';
    const bankId = admin.role === 'staff' ? admin.bankId : str(b.bankId, 40);
    if (bankId || !partial) { o.bankId = bankId; const bk = store.get('banks', bankId); o.host = bk ? bk.name : str(b.host, 120); }
    return o;
  };
  R.add('GET', '/api/admin/camps', adm, ({ admin, query }) => {
    const only_ = staffBank(admin);
    const a = store.list('camps').filter(c => (!only_ || c.bankId === only_) && (!query.upcoming || c.date >= today())).sort((x, y) => y.date.localeCompare(x.date));
    return { items: a.map(c => Object.assign({}, c, { regs: undefined, regCount: (c.regs || []).length })) };
  });
  R.add('POST', '/api/admin/camps', adm, ({ admin, body }) => {
    staffBank(admin); const c = store.insert('camps', Object.assign({ regs: [], status: 'active' }, campBody(body, admin))); audit(admin, 'camp.create', c.id); return { camp: c };
  });
  R.add('PUT', '/api/admin/camps/:id', adm, ({ admin, params, body }) => {
    const c = store.get('camps', params.id); if (!c) throw new HttpError(404, 'Not found'); if (admin.role === 'staff') needBankAccess(admin, c.bankId);
    Object.assign(c, campBody(body, admin, true)); store.save(); audit(admin, 'camp.edit', c.id); return { camp: c };
  });
  R.add('DELETE', '/api/admin/camps/:id', adm, ({ admin, params }) => {
    const c = store.get('camps', params.id); if (!c) throw new HttpError(404, 'Not found'); if (admin.role === 'staff') needBankAccess(admin, c.bankId);
    store.remove('camps', c.id); audit(admin, 'camp.delete', c.id); return { ok: true };
  });
  R.add('GET', '/api/admin/camps/:id/regs', adm, ({ admin, params }) => {
    const c = store.get('camps', params.id); if (!c) throw new HttpError(404, 'Not found'); if (admin.role === 'staff') needBankAccess(admin, c.bankId);
    return { items: (c.regs || []).map(id => store.get('users', id)).filter(Boolean).map(u => ({ id: u.id, name: u.name, bg: u.bg, phone: u.phone, verified: core.isVerified(u) })) };
  });

  /* ---------- transplant centres ---------- */
  R.add('GET', '/api/admin/centres', only, () => ({ items: store.list('centres') }));
  const centreBody = (b, partial) => {
    const o = {};
    if (!partial || 'name' in b) { o.name = str(b.name, 120); if (!o.name) throw bad('Name is required'); }
    if (!partial || 'lat' in b) { const la = parseFloat(b.lat), lo = parseFloat(b.lng); if (!validLL(la, lo)) throw bad('Pick the location on the map'); o.lat = la; o.lng = lo; }
    ['phone', 'hours', 'address', 'city'].forEach(k => { if (k in b) o[k] = str(b[k], 160); });
    if ('programs' in b) o.programs = [].concat(b.programs || []).map(x => str(x, 30)).filter(Boolean).slice(0, 10);
    if ('active' in b) o.active = !!b.active;
    return o;
  };
  R.add('POST', '/api/admin/centres', only, ({ admin, body }) => { const c = store.insert('centres', Object.assign({ active: true, programs: [] }, centreBody(body))); audit(admin, 'centre.create', c.id); return { centre: c }; });
  R.add('PUT', '/api/admin/centres/:id', only, ({ admin, params, body }) => { const c = store.get('centres', params.id); if (!c) throw new HttpError(404, 'Not found'); Object.assign(c, centreBody(body, true)); store.save(); audit(admin, 'centre.edit', c.id); return { centre: c }; });
  R.add('DELETE', '/api/admin/centres/:id', only, ({ admin, params }) => { store.remove('centres', params.id); audit(admin, 'centre.delete', params.id); return { ok: true }; });

  /* ---------- organ pledges ---------- */
  R.add('GET', '/api/admin/organ', only, ({ query }) => {
    const q = str(query.q, 60).toLowerCase();
    const a = store.list('users').filter(u => u.organ && u.organ.pledged && (!q || has(u.name, q) || has(u.phone, q) || has(u.organ.id, q))).sort((x, y) => (y.organ.at || 0) - (x.organ.at || 0));
    const r = page(a, query); r.items = r.items.map(u => ({ id: u.id, name: u.name, phone: u.phone, bg: u.bg, city: u.city, pledgeId: u.organ.id, at: u.organ.at, organs: u.organ.organs, tissues: u.organ.tissues, kin: u.organ.kin, informed: u.organ.informed, notto: u.organ.notto, verified: core.isVerified(u) })); return r;
  });

  /* ---------- broadcast ---------- */
  R.add('POST', '/api/admin/broadcast', only, async ({ admin, body }) => {
    const title = str(body.title, 80), text = str(body.body, 300); if (!title || !text) throw bad('Title and message are required');
    const au = body.audience || {};
    const list = store.list('users').filter(u => u.status !== 'suspended' && !u.demo && (!au.city || String(u.city || '').toLowerCase() === String(au.city).toLowerCase()) && (!au.bg || u.bg === au.bg) && (!au.verified || core.isVerified(u)) && (!au.listed || core.donorListed(u, core.cfg())));
    if (body.dryRun) return { count: list.length };
    for (const u of list) await core.notify(u.id, 'broadcast', {}, {}, { title, body: text, titleTa: str(body.titleTa, 80), bodyTa: str(body.bodyTa, 300) });
    store.insert('broadcasts', { at: Date.now(), by: admin.email, title, body: text, audience: au, count: list.length }); audit(admin, 'broadcast', '', { title, count: list.length });
    return { count: list.length };
  });
  R.add('GET', '/api/admin/broadcasts', only, () => ({ items: store.list('broadcasts').slice(-50).reverse() }));

  /* ---------- staff accounts ---------- */
  R.add('GET', '/api/admin/staff', only, () => ({ items: store.list('admins').map(adminView) }));
  R.add('POST', '/api/admin/staff', only, ({ admin, body }) => {
    const email = str(body.email, 120).toLowerCase(), role = oneOf(body.role, ['admin', 'staff']) || 'staff';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Enter a valid email');
    if (String(body.password || '').length < 10) throw bad('Use at least 10 characters for the password');
    if (store.find('admins', a => a.email === email)) throw new HttpError(409, 'That email already has an account');
    if (role === 'staff' && !store.get('banks', body.bankId)) throw bad('Choose the blood bank this staff member manages');
    const a = store.insert('admins', { email, name: str(body.name, 80), role, bankId: role === 'staff' ? body.bankId : '', pass: A.hashPassword(body.password), active: true, created: Date.now(), tv: 0 });
    audit(admin, 'staff.create', a.id, { email, role }); return { staff: adminView(a) };
  });
  R.add('PUT', '/api/admin/staff/:id', only, ({ admin, params, body }) => {
    const a = store.get('admins', params.id); if (!a) throw new HttpError(404, 'Not found');
    if ('name' in body) a.name = str(body.name, 80);
    if ('active' in body) { if (a.id === admin.id && !body.active) throw bad('You cannot deactivate yourself'); a.active = !!body.active; }
    if ('bankId' in body && a.role === 'staff') { if (!store.get('banks', body.bankId)) throw bad('Unknown bank'); a.bankId = body.bankId; }
    if (body.password) { if (String(body.password).length < 10) throw bad('Use at least 10 characters'); a.pass = A.hashPassword(body.password); a.tv = (a.tv || 0) + 1; }
    store.save(); audit(admin, 'staff.edit', a.id); return { staff: adminView(a) };
  });
  R.add('DELETE', '/api/admin/staff/:id', only, ({ admin, params }) => {
    if (params.id === admin.id) throw bad('You cannot delete yourself');
    const a = store.get('admins', params.id); if (!a) throw new HttpError(404, 'Not found');
    if (a.role === 'admin' && store.filter('admins', x => x.role === 'admin' && x.active !== false).length <= 1) throw bad('Keep at least one active admin');
    store.remove('admins', a.id); audit(admin, 'staff.delete', a.id); return { ok: true };
  });

  /* ---------- settings, audit, export, demo data ---------- */
  R.add('GET', '/api/admin/config', only, () => ({ config: core.cfg(), defaults: core.CONFIG_DEFAULTS }));
  R.add('PUT', '/api/admin/config', only, ({ admin, body }) => {
    const d = core.CONFIG_DEFAULTS, doc = store.doc('config', {}), out = {};
    Object.keys(d).forEach(k => {
      if (!(k in body)) return;
      if (typeof d[k] === 'number') { const n = num(body[k], 0, 100000); if (n == null) throw bad('Check ' + k); out[k] = n; }
      else if (typeof d[k] === 'boolean') out[k] = !!body[k]; else out[k] = str(body[k], 300);
    });
    if ('verifyPolicy' in out && !['digilocker', 'any'].includes(out.verifyPolicy)) throw bad('Bad verification policy');
    Object.assign(doc, out); store.save(); audit(admin, 'config.update', '', out); return { config: core.cfg() };
  });
  R.add('GET', '/api/admin/audit', only, ({ query }) => { const a = store.list('audit').slice().reverse(); return page(a, query); });
  R.add('GET', '/api/admin/export/users', only, ({ admin }) => {
    audit(admin, 'export.users');
    const rows = [['id', 'name', 'phone', 'blood_group', 'gender', 'dob', 'city', 'verified', 'method', 'available', 'last_donation', 'donations', 'organ_pledge', 'joined']].concat(store.list('users').map(u => [u.id, u.name, u.phone, u.bg, u.gender, u.dob, u.city, (u.verify || {}).status || 'none', (u.verify || {}).method || '', u.available ? 'yes' : 'no', u.last, (u.donatedBefore || 0) + store.filter('donations', d => d.userId === u.id).length, u.organ && u.organ.pledged ? 'yes' : 'no', new Date(u.createdAt || 0).toISOString()]));
    return { __raw: csv(rows), type: 'text/csv', filename: 'lifelink-users.csv' };
  });
  R.add('GET', '/api/admin/export/donations', only, ({ admin }) => {
    audit(admin, 'export.donations');
    const rows = [['id', 'donor', 'phone', 'date', 'type', 'units', 'place', 'for']].concat(store.list('donations').map(d => { const u = store.get('users', d.userId) || {}; return [d.id, u.name, u.phone, new Date(d.t).toISOString().slice(0, 10), d.type, d.units, d.place, d.forWho]; }));
    return { __raw: csv(rows), type: 'text/csv', filename: 'lifelink-donations.csv' };
  });
  R.add('DELETE', '/api/admin/demo', only, ({ admin }) => {
    const ids = store.list('users').filter(u => u.demo).map(u => u.id);
    ids.forEach(id => core.eraseUser(id));
    const n = [store.removeWhere('banks', b => b.demo), store.removeWhere('camps', c => c.demo), store.removeWhere('centres', c => c.demo)];
    audit(admin, 'demo.purge'); return { users: ids.length, banks: n[0], camps: n[1], centres: n[2] };
  });
};
