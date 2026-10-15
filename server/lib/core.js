'use strict';
// Domain logic shared by the app API and the admin API: config, eligibility, donor matching,
// notifications (English + Tamil), request lifecycle, scheduled jobs.
const { hav, jitter } = require('./geo');
const { showPhone } = require('./auth');
const push = require('./push');
const live = require('./live');

const BGS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const COMPAT = {
  'O-': BGS.slice(), 'O+': ['O+', 'A+', 'B+', 'AB+'], 'A-': ['A-', 'A+', 'AB-', 'AB+'], 'A+': ['A+', 'AB+'],
  'B-': ['B-', 'B+', 'AB-', 'AB+'], 'B+': ['B+', 'AB+'], 'AB-': ['AB-', 'AB+'], 'AB+': ['AB+']
};
const canGive = (donor, recipient) => !!(COMPAT[donor] && COMPAT[donor].includes(recipient));
const COMPONENTS = ['Whole blood', 'Red cells', 'Platelets', 'Plasma'];
const URGENCY = ['critical', 'urgent', 'planned'];
const DAY = 864e5, HOUR = 36e5;

const CONFIG_DEFAULTS = {
  gapMen: 90, gapWomen: 120, minAge: 18, maxAge: 65, minWeight: 45,
  defaultRadiusKm: 10, alertMax: 12, alertRadiusKm: 15, presenceFreshMin: 30,
  requestExpiryHours: 12, requestsPerHour: 5, maintenance: false, announcement: '',
  // Who counts as "verified": 'digilocker' = DigiLocker (or an admin override) with the Aadhaar card shared (always required);
  // verifyRequireLicence also demands a driving licence (default: optional). 'any' = any approved method.
  // verifyAllowSkip: onboarding offers "I only need to request blood" (they still cannot donate until verified).
  verifyPolicy: 'digilocker', verifyRequireLicence: false, verifyAllowSkip: true
};

function create(store, dataDir) {
  const cfg = () => Object.assign({}, CONFIG_DEFAULTS, store.doc('config', {}));
  const users = () => store.list('users');
  const userById = id => store.get('users', id);

  /* ---------- names, phones ---------- */
  const shortName = n => { const w = String(n || 'Donor').trim().split(/\s+/); return w[0] + (w[1] ? ' ' + w[w.length - 1][0].toUpperCase() + '.' : ''); };
  const hasDoc = (u, type) => (u.documents || []).some(d => d.type === type);
  // '' when the person meets the verification policy, otherwise what is missing: 'verify' | 'digilocker' | 'aadhaar' | 'licence'
  function verifyNeed(u) {
    const v = u.verify || {};
    if (v.status !== 'verified') return 'verify';
    const c = cfg();
    if (c.verifyPolicy === 'digilocker') {
      if (v.method === 'direct') return 'digilocker';
      if (v.method === 'digilocker') {
        if (!hasDoc(u, 'aadhaar')) return 'aadhaar';
        if (c.verifyRequireLicence && !hasDoc(u, 'dl')) return 'licence';
      }
    }
    return '';
  }
  const isVerified = u => !verifyNeed(u);
  // Date of birth / gender from the verified document win over what the person typed (they cannot edit them afterwards).
  const docLocked = u => !!(u.verify && u.verify.status === 'verified' && u.verify.method === 'digilocker');
  const effDob = u => (docLocked(u) && u.verify.dob) || u.dob;
  const effGender = u => (docLocked(u) && u.verify.gender) || u.gender;
  const ageOf = dob => {
    if (!dob) return null;
    const b = new Date(dob + 'T00:00:00'), n = new Date();
    let a = n.getFullYear() - b.getFullYear();
    if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
    return a;
  };
  const dayKey = d => { d = new Date(d); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  /* ---------- eligibility (NBTC-style norms, tunable in admin > Settings) ---------- */
  // Health declaration asked of every donor (yes = temporarily not eligible until they answer no again).
  const HEALTH = { fever: 'Fever, cold or infection in the last 2 weeks', medication: 'On antibiotics or other medication', tattoo: 'Tattoo, piercing or acupuncture in the last 6 months',
    surgery: 'Surgery or major dental work in the last 6 months', pregnant: 'Pregnant, breastfeeding or delivered in the last 6 months', travel: 'Malaria area travel in the last 3 months', vaccine: 'Vaccination in the last 4 weeks' };
  function eligibility(u) {
    const c = cfg(), gap = effGender(u) === 'F' ? c.gapWomen : c.gapMen, reasons = [];
    const a = ageOf(effDob(u));
    if (a != null && (a < c.minAge || a > c.maxAge)) reasons.push('age');
    if (u.weight && +u.weight < c.minWeight) reasons.push('weight');
    if (u.health && Object.keys(HEALTH).some(k => u.health[k] === true)) reasons.push('health');   // self-declared: fever, medication, recent tattoo/surgery...
    let next = null;
    if (u.last) { next = new Date(new Date(u.last + 'T00:00:00').getTime() + gap * DAY); if (next.getTime() > Date.now()) reasons.push('gap'); else next = null; }
    return { ok: !reasons.length, reasons, next };
  }

  /* ---------- notifications ---------- */
  const URG_TA = { critical: 'அவசரம்', urgent: 'விரைவு', planned: 'திட்டமிட்டது' };
  const cap = s => String(s).charAt(0).toUpperCase() + String(s).slice(1);
  const T = {
    request_alert: {
      en: p => [cap(p.urgency) + ' blood needed: ' + p.bg, p.units + ' unit' + (p.units > 1 ? 's' : '') + ' at ' + p.hospital + ' · ' + p.km + ' km away'],
      ta: p => [URG_TA[p.urgency] + ' - இரத்தம் தேவை: ' + p.bg, p.hospital + ' · ' + p.units + ' யூனிட் · ' + p.km + ' கி.மீ தொலைவில்']
    },
    offer_received: {
      en: p => [p.name + ' can donate', p.bg + ' · ' + p.km + ' km away. Open your request to accept.'],
      ta: p => [p.name + ' இரத்த தானம் செய்ய முன்வந்துள்ளார்', p.bg + ' · ' + p.km + ' கி.மீ. ஏற்றுக்கொள்ள உங்கள் கோரிக்கையைத் திறக்கவும்.']
    },
    offer_accepted: {
      en: p => ['Your offer was accepted', p.requester + ' accepted. Contact details are now unlocked.'],
      ta: p => ['உங்கள் உதவி ஏற்கப்பட்டது', p.requester + ' ஏற்றுக்கொண்டார். தொடர்பு விவரங்கள் இப்போது கிடைக்கும்.']
    },
    offer_declined: {
      en: p => ['Request update', 'The request at ' + p.hospital + ' no longer needs your help. Thank you for offering.'],
      ta: p => ['கோரிக்கை புதுப்பிப்பு', p.hospital + ' கோரிக்கைக்கு இனி உங்கள் உதவி தேவையில்லை. முன்வந்ததற்கு நன்றி.']
    },
    donation_confirmed: {
      en: p => ['Donation confirmed', 'Thank you! Your donation for ' + p.patient + ' has been recorded.'],
      ta: p => ['தானம் உறுதி செய்யப்பட்டது', 'நன்றி! ' + p.patient + ' அவர்களுக்கான உங்கள் தானம் பதிவு செய்யப்பட்டது.']
    },
    donation_received: {
      en: p => ['Donation received', p.name + ' donated for ' + p.patient + '. (' + p.received + ' of ' + p.units + ')'],
      ta: p => ['தானம் பெறப்பட்டது', p.name + ' தானம் செய்தார் - ' + p.patient + '. (' + p.received + ' / ' + p.units + ')']
    },
    verified: { en: () => ['You are verified', 'Your identity was verified. You can now appear as a donor.'], ta: () => ['சரிபார்க்கப்பட்டது', 'உங்கள் அடையாளம் சரிபார்க்கப்பட்டது. இனி நீங்கள் கொடையாளராக தோன்றலாம்.'] },
    verify_rejected: { en: p => ['Verification failed', p.reason || 'We could not verify your ID. Please try again.'], ta: p => ['சரிபார்ப்பு தோல்வி', p.reason || 'உங்கள் அடையாளத்தை சரிபார்க்க முடியவில்லை. மீண்டும் முயலவும்.'] },
    eligible_again: { en: () => ['You can donate blood again', 'You are eligible from today - someone nearby may need you.'], ta: () => ['மீண்டும் இரத்த தானம் செய்யலாம்', 'இன்று முதல் நீங்கள் தகுதியுடையவர் - அருகில் யாருக்காவது உங்கள் உதவி தேவைப்படலாம்.'] },
    camp_reminder: { en: p => ['Blood camp tomorrow', p.title + ' · ' + p.venue + ', ' + p.time], ta: p => ['நாளை இரத்த தான முகாம்', p.title + ' · ' + p.venue + ', ' + p.time] },
    request_closed: { en: p => ['Request closed', 'Your request for ' + p.bg + ' at ' + p.hospital + ' has expired.'], ta: p => ['கோரிக்கை முடிந்தது', p.hospital + ' - ' + p.bg + ' கோரிக்கை காலாவதியானது.'] },
    account_suspended: { en: () => ['Account suspended', 'Your account was suspended. Contact support for help.'], ta: () => ['கணக்கு இடைநிறுத்தப்பட்டது', 'உங்கள் கணக்கு இடைநிறுத்தப்பட்டது. உதவிக்கு ஆதரவைத் தொடர்பு கொள்ளவும்.'] }
  };

  async function notify(userId, type, params, data, custom) {
    const u = userById(userId); if (!u) return null;
    const lang = u.lang === 'ta' ? 'ta' : 'en';
    let title, body;
    if (custom) { title = (lang === 'ta' && custom.titleTa) || custom.title; body = (lang === 'ta' && custom.bodyTa) || custom.body; }
    else { const t = T[type]; if (!t) return null; [title, body] = t[lang](params || {}); }
    const n = store.insert('notifications', { userId, type, title, body, data: data || {}, read: false, at: Date.now() });
    live.emitUser(userId, 'notice', { id: n.id });
    const tokens = (u.devices || []).map(d => d.token);
    if (tokens.length && push.enabled()) {
      push.send(tokens, { title, body, data: Object.assign({ type, id: n.id }, data || {}) }).then(dead => {
        if (dead && dead.length) { u.devices = u.devices.filter(d => !dead.includes(d.token)); store.save(); }
      }).catch(() => {});
    }
    return n;
  }

  /* ---------- views ---------- */
  const donorPos = u => u.presence ? jitter(u.presence.lat, u.presence.lng, u.id, 300) : null;
  // Only people who chose "become a donor" (and are not a hospital account) ever appear on the map or get alerts.
  const donorListed = (u, c) => !!(u.status !== 'suspended' && u.donor === true && (u.role || 'user') === 'user' && u.available && isVerified(u) && eligibility(u).ok && u.presence && u.bg);
  // Donor registration certificate: stable number derived from the account, issued when the person becomes a donor.
  const certOf = u => {
    if (u.donor !== true) return null;
    const at = u.donorSince || u.createdAt || Date.now();
    const h = require('crypto').createHash('sha1').update(String(u.id)).digest('hex').slice(0, 6).toUpperCase();
    return { no: 'LL-' + new Date(at).getFullYear() + '-' + h, at };
  };
  const hospitalOf = u => u.hospital ? { name: u.hospital.name, type: u.hospital.type, regNo: u.hospital.regNo, address: u.hospital.address, city: u.hospital.city, area: u.hospital.area || '',
    lat: u.hospital.lat, lng: u.hospital.lng, phone: u.hospital.phone, hours: u.hospital.hours || '', components: u.hospital.components || ['Whole blood'],
    status: u.hospital.status, reason: u.hospital.reason || '', bankId: u.hospital.bankId || '' } : null;

  function publicDonor(u) {
    const [lat, lng] = donorPos(u);
    return { id: u.id, name: shortName(u.name), bg: u.bg, lat, lng, verified: true, seen: u.presence ? u.presence.seen : 0, prefs: u.prefs || [], night: !!u.night,
      donated: (u.donatedBefore || 0) + store.filter('donations', d => d.userId === u.id).length };
  }

  function userView(u) {
    const e = eligibility(u);
    return {
      id: u.id,
      profile: {
        name: u.name || '', phone: u.phone, email: u.email || '', dob: effDob(u) || '', gender: effGender(u) || '', bg: u.bg || '', weight: u.weight || '', city: u.city || '',
        address: u.address || '', last: u.last || '', donatedBefore: u.donatedBefore || 0, conditions: u.conditions || [], emName: u.emName || '', emPhone: u.emPhone || '',
        area: u.area || '', pincode: u.pincode || '', height: u.height || '', prefs: u.prefs || [], night: !!u.night, health: u.health || {}, consentAt: u.consentAt || 0,
        available: !!u.available
      },
      role: u.role || 'user', roleSet: u.role !== undefined, donor: u.donor === true, hospital: hospitalOf(u), cert: certOf(u),
      complete: (u.role || 'user') === 'hospital' ? !!(u.hospital && u.hospital.name) : !!(u.name && u.dob),
      verify: u.verify || { status: 'none' },
      verified: isVerified(u), verifyNeed: verifyNeed(u), docLocked: docLocked(u), hasAadhaar: hasDoc(u, 'aadhaar'), hasLicence: hasDoc(u, 'dl'),
      documents: (u.documents || []).map(d => ({ id: d.id, name: d.name, type: d.type, issuer: d.issuer, at: d.at })),
      organ: u.organ || { pledged: false },
      lang: u.lang || 'en', status: u.status || 'active',
      eligible: e.ok, eligibleFrom: e.next ? dayKey(e.next) : null
    };
  }

  function reqView(r, viewer) {
    const mine = r.userId === viewer.id, my = r.responses.find(x => x.donorId === viewer.id && x.state !== 'withdrawn');
    const req = userById(r.userId);
    const o = {
      id: r.id, mine, patient: r.patient, bg: r.bg, units: r.units, comp: r.comp, hospital: r.hospital, city: r.city, lat: r.lat, lng: r.lng,
      urgency: r.urgency, by: r.by, created: r.created, note: r.note || '', status: r.status, received: r.received || 0,
      verified: !!(req && isVerified(req)), hospitalVerified: !!(req && req.role === 'hospital' && req.hospital && req.hospital.status === 'approved'),
      responders: r.responses.filter(x => ['offered', 'accepted', 'confirmed'].includes(x.state)).length
    };
    if (mine) {
      o.contact = r.contact; o.contactName = r.contactName;
      o.responses = r.responses.filter(x => x.state !== 'withdrawn').map(x => {
        const d = userById(x.donorId); if (!d) return null;
        const pos = donorPos(d) || [r.lat, r.lng], shown = x.state === 'accepted' || x.state === 'confirmed';
        return { id: x.id, donorId: x.donorId, name: shortName(d.name), bg: d.bg, km: Math.round(hav(r.lat, r.lng, pos[0], pos[1]) * 10) / 10, verified: isVerified(d), phone: shown ? showPhone(d.phone) : undefined, state: x.state, at: x.at };
      }).filter(Boolean);
    } else if (my && (my.state === 'accepted' || my.state === 'confirmed')) { o.contact = showPhone(r.contact); o.contactName = r.contactName; }
    else if (!mine) o.contact = '';
    if (mine) o.contact = showPhone(r.contact);
    return o;
  }
  const offerState = s => ({ offered: 'offered', accepted: 'accepted', declined: 'declined', confirmed: 'donated', withdrawn: 'cancelled' })[s];

  /* ---------- request lifecycle ---------- */
  function alertDonors(r, extraKm) {
    const c = cfg(), have = new Set(r.responses.map(x => x.donorId));
    const maxKm = c.alertRadiusKm + (extraKm || 0);
    const cand = users().filter(u => u.id !== r.userId && !have.has(u.id) && canGive(u.bg, r.bg) && donorListed(u, c) && hav(r.lat, r.lng, u.presence.lat, u.presence.lng) <= maxKm)
      .map(u => ({ u, km: hav(r.lat, r.lng, u.presence.lat, u.presence.lng) })).sort((a, b) => a.km - b.km).slice(0, c.alertMax);
    cand.forEach(({ u, km }) => {
      r.responses.push({ id: require('crypto').randomBytes(6).toString('hex'), donorId: u.id, state: 'pinged', at: Date.now() });
      notify(u.id, 'request_alert', { urgency: r.urgency, bg: r.bg, units: r.units, hospital: r.hospital, km: Math.round(km * 10) / 10 }, { requestId: r.id });
    });
    store.save();
    return cand.length;
  }

  function confirmDonation(r, resp) {
    if (resp.state === 'confirmed') return false;
    if ((r.received || 0) >= r.units) return false;            // enough units already confirmed: extra donors are thanked, not counted
    resp.state = 'confirmed'; resp.at = Date.now();
    r.received = Math.min(r.units, (r.received || 0) + 1);
    const d = userById(resp.donorId);
    if (d) {
      store.insert('donations', { userId: d.id, t: Date.now(), place: r.hospital, type: r.comp, units: 1, forWho: r.patient, requestId: r.id });
      d.last = dayKey(new Date()); d.notified = Object.assign({}, d.notified, { eligibleOn: null });
      notify(d.id, 'donation_confirmed', { patient: r.patient }, { requestId: r.id });
    }
    notify(r.userId, 'donation_received', { name: d ? shortName(d.name) : 'A donor', patient: r.patient, received: r.received, units: r.units }, { requestId: r.id });
    if (r.received >= r.units) r.status = 'fulfilled';
    store.save();
    return true;
  }

  /* ---------- scheduled jobs ---------- */
  function jobs() {
    const c = cfg(), now = Date.now(), today = dayKey(now);
    // expire stale requests
    store.list('requests').forEach(r => {
      if (r.status === 'open' && now > r.by + c.requestExpiryHours * HOUR) {
        r.status = 'expired'; notify(r.userId, 'request_closed', { bg: r.bg, hospital: r.hospital }, { requestId: r.id });
      }
    });
    // "you can donate again" - once per cooldown
    users().forEach(u => {
      if (u.status === 'suspended' || !u.last) return;
      const gap = u.gender === 'F' ? c.gapWomen : c.gapMen;
      if (dayKey(new Date(u.last + 'T00:00:00').getTime() + gap * DAY) <= today && u.notified?.eligibleOn !== u.last) {
        u.notified = Object.assign({}, u.notified, { eligibleOn: u.last });
        notify(u.id, 'eligible_again', {}, {});
      }
    });
    // camp reminders the day before
    const tomorrow = dayKey(now + DAY);
    store.list('camps').forEach(cp => {
      if (cp.status !== 'cancelled' && cp.date === tomorrow && cp.remindedFor !== tomorrow) {
        cp.remindedFor = tomorrow;
        (cp.regs || []).forEach(uid => notify(uid, 'camp_reminder', { title: cp.title, venue: cp.venue, time: cp.time }, { campId: cp.id }));
      }
    });
    store.save();
  }

  // GDPR/DPDP-style erasure: remove the person, their notifications and files; anonymise what others still see.
  function eraseUser(id) {
    const u = userById(id); if (!u) return false;
    live.emitAll('gone', { id });
    store.list('requests').forEach(r => {
      if (r.userId === id) { if (r.status === 'open') r.status = 'closed'; r.patient = 'Removed'; r.contact = ''; r.contactName = ''; r.note = ''; }
      r.responses.forEach(x => { if (x.donorId === id) x.state = 'withdrawn'; });
    });
    store.list('camps').forEach(c => { c.regs = (c.regs || []).filter(x => x !== id); });
    store.removeWhere('notifications', n => n.userId === id);
    store.removeWhere('donations', d => d.userId === id);
    store.removeWhere('reports', r => r.byUser === id);
    store.remove('users', id);
    try { require('fs').rmSync(require('path').join(dataDir || '.', 'docs', id), { recursive: true, force: true }); } catch (e) {}
    return true;
  }

  // One-time upgrade for accounts created before account types existed: people who were already donors stay donors.
  function migrate() {
    let n = 0;
    users().forEach(u => {
      if (u.role === undefined) { u.role = 'user'; n++; }
      if (u.donor === undefined) { u.donor = !!(u.available || (u.verify && u.verify.status === 'verified' && u.bg)); n++; }
    });
    if (n) store.save();
    return n;
  }

  return { migrate, BGS, COMPAT, canGive, COMPONENTS, URGENCY, cfg, CONFIG_DEFAULTS, shortName, isVerified, verifyNeed, docLocked, hasDoc, ageOf, dayKey, eligibility, notify, donorListed, publicDonor, userView, reqView, offerState,
    alertDonors, confirmDonation, jobs, eraseUser, donorPos, HEALTH };
}
module.exports = { create, BGS, COMPAT, canGive, COMPONENTS, URGENCY, CONFIG_DEFAULTS };
