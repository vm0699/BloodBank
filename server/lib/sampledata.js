'use strict';
// Tamil Nadu sample data (hospitals with real names and addresses, Tamil donor names, camps, transplant centres, open requests).
// Everything is flagged `demo: true` so Admin > Settings > "Delete demo data" removes it in one click.
// Donor phone numbers are invalid (+91 0...), so they can never reach a real person.
const path = require('path');
const fs = require('fs');

const dayKey = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
const DATA = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'sample_tn.json'), 'utf8'));

function load(store, core) {
  if (store.list('banks').some(b => b.demo)) return { already: true };
  const D = DATA(), BGS = core.BGS, now = Date.now();
  let seed = 11; const R = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const bankByKey = {};
  D.hospitals.forEach((h, i) => {
    const stock = {}; BGS.forEach(g => { stock[g] = Math.floor(R() * 24 * (/-/.test(g) || g === 'AB+' ? .4 : 1)); });
    const b = store.insert('banks', { name: h.name + ' - Blood Bank', type: h.type, hours: h.hours, lat: h.lat, lng: h.lng, city: h.city, area: h.city, address: h.address, phone: '',
      stock, rev: 0, components: ['Whole blood', 'Red cells', 'Platelets', 'Plasma'], active: true, demo: true, updatedAt: now, geo: h.geo });
    bankByKey[h.key] = b;
  });
  D.centres.forEach((c, i) => store.insert('centres', { name: c.name, programs: c.programs, lat: c.lat, lng: c.lng, city: c.city, phone: '', hours: 'OPD 9:00 AM - 5:00 PM', active: true, demo: true }));
  D.camps.forEach(c => {
    const b = bankByKey[c.bank];
    store.insert('camps', { title: c.title, org: c.org, venue: c.venue, date: dayKey(now + c.days * 864e5), time: '9:00 AM - 3:00 PM', lat: c.lat, lng: c.lng, slots: 60, bankId: b ? b.id : '', host: b ? b.name : c.org, regs: [], status: 'active', demo: true });
  });
  const donors = D.donors.map((p, i) => store.insert('users', {
    phone: '+91 0' + String(2000000 + i), name: p.name, nameTa: p.nameTa, dob: p.dobYear + '-0' + (1 + (i % 9)) + '-1' + (i % 9), gender: p.gender, bg: p.bg, weight: p.weight,
    city: p.city, area: p.area, last: p.lastDaysAgo ? dayKey(now - p.lastDaysAgo * 864e5) : '', donatedBefore: p.donatedBefore,
    role: 'user', donor: true, donorSince: now - Math.floor(R() * 200) * 864e5, available: true, prefs: ['Whole blood'], night: R() < .4,
    presence: { lat: p.lat, lng: p.lng, seen: now },
    verify: p.verified ? { status: 'verified', method: 'manual', at: now, name: p.name, docs: [] } : { status: 'none' },
    status: 'active', createdAt: now - Math.floor(R() * 30) * 864e5, tv: 0, lang: 'en', devices: [], demo: true }));
  D.requests.forEach((q, i) => {
    const h = D.hospitals.find(x => x.key === q.hospital), b = bankByKey[q.hospital], by = donors[(i * 7) % donors.length];
    store.insert('requests', { userId: by.id, patient: q.patient, bg: q.bg, units: q.units, comp: 'Whole blood', hospital: b.name, city: h.city, lat: h.lat, lng: h.lng, urgency: q.urgency,
      by: now + 36e5 * (q.urgency === 'critical' ? 6 : 30), created: now - (i + 1) * 17 * 60e3, contact: '+91 0' + String(3000000 + i), contactName: by.name, note: '', status: 'open', received: 0, responses: [], bankId: b.id, demo: true });
  });
  store.save();
  return { banks: D.hospitals.length, centres: D.centres.length, camps: D.camps.length, donors: donors.length, requests: D.requests.length };
}
module.exports = { load };
