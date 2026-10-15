// Development seed: sample blood banks, camps, transplant centres and fake donors around a city, all flagged
// `demo: true` so Admin > Settings > "Delete demo data" removes them in one click before launch.
//   node seed.js                       (Chennai, 30 donors)
//   node seed.js --lat 12.97 --lng 77.59 --users 60 --city Bengaluru
// Fake donors use invalid phone numbers (+91 0...) so they can never reach a real person.
'use strict';
const path = require('path');
const { Store } = require('./lib/store');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? a.concat([[v.slice(2), arr[i + 1]]]) : a), []));
const lat0 = +args.lat || 13.0827, lng0 = +args.lng || 80.2707, city = args.city || 'Chennai', N = +args.users || 30;
const store = new Store(path.join(path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data')), 'lifelink.json'));
const { BGS } = require('./lib/core');

let seed = 7; const R = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pt = rad => { const r = rad * Math.sqrt(R()), t = R() * 6.2832; return [lat0 + r * Math.sin(t) / 111.32, lng0 + r * Math.cos(t) / (111.32 * Math.cos(lat0 * Math.PI / 180))]; };
const W = [['O+', 30], ['B+', 25], ['A+', 20], ['AB+', 7], ['O-', 6], ['B-', 5], ['A-', 5], ['AB-', 2]];
const bg = () => { let x = R() * 100; for (const [g, w] of W) if ((x -= w) < 0) return g; return 'O+'; };
const FIRST = ['Aarav', 'Vihaan', 'Arjun', 'Karthik', 'Rohan', 'Siddharth', 'Manoj', 'Suresh', 'Ramesh', 'Dinesh', 'Priya', 'Ananya', 'Divya', 'Meera', 'Kavya', 'Lakshmi', 'Sneha', 'Pooja', 'Nisha', 'Revathi'];
const LAST = ['Kumar', 'Sharma', 'Raj', 'Menon', 'Pillai', 'Nair', 'Varma', 'Das', 'Gupta', 'Iyer'];
const day = d => { const x = new Date(Date.now() + d * 864e5); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };

if (store.list('banks').some(b => b.demo)) { console.log('Demo data already present. Delete it in Admin > Settings first.'); process.exit(0); }

const banks = [['Lifeline Community Blood Centre', 'Charitable', '24 x 7'], ['Greenfield Voluntary Blood Bank', 'Government', '8:00 AM - 8:00 PM'], ['Riverside Hospital Blood Centre', 'Hospital-based', '24 x 7'],
  ['Sunrise Blood Bank', 'Private', '9:00 AM - 6:00 PM'], ['Metro General Blood Bank', 'Hospital-based', '24 x 7'], ['Hope Charitable Blood Bank', 'Charitable', '9:00 AM - 7:00 PM']];
const bankIds = banks.map(([name, type, hours], i) => {
  const [la, lo] = pt(10), stock = {}; BGS.forEach(g => { stock[g] = Math.floor(R() * 26 * (/-/.test(g) || g === 'AB+' ? .35 : 1)); });
  return store.insert('banks', { name, type, hours, lat: la, lng: lo, city, area: city, phone: '+91 0000' + (10000 + i), stock, components: ['Whole blood', 'Red cells', 'Platelets', 'Plasma'], active: true, demo: true, updatedAt: Date.now() }).id;
});
[['Apex Institute of Transplant Sciences', ['Kidney', 'Liver', 'Heart', 'Lungs']], ['Meridian Multispeciality Hospital', ['Kidney', 'Liver', 'Cornea']], ['City Kidney & Liver Centre', ['Kidney', 'Liver']], ['Lakeview Eye Bank & Cornea Centre', ['Cornea', 'Skin']]]
  .forEach(([name, programs], i) => { const [la, lo] = pt(12); store.insert('centres', { name, programs, lat: la, lng: lo, city, phone: '+91 0000' + (20000 + i), hours: 'OPD 9:00 AM - 5:00 PM', active: true, demo: true }); });
[['Community Blood Donation Camp', 'Neighbourhood Welfare Association', 'Community Hall', 2], ['Corporate Blood Drive', 'Tech Park Employees Forum', 'Tech Park Atrium', 6], ['College Blood Donation Camp', "Students' Union", 'College Auditorium', 11], ['Voluntary Donation Day', 'Service Club', 'Town Square Pavilion', 19]]
  .forEach(([title, org, venue, d], i) => { const [la, lo] = pt(9), b = store.get('banks', bankIds[i]); store.insert('camps', { title, org, venue, date: day(d), time: '9:00 AM - 3:00 PM', lat: la, lng: lo, slots: 60, bankId: b.id, host: b.name, regs: [], status: 'active', demo: true }); });
for (let i = 0; i < N; i++) {
  const [la, lo] = pt(15), g = R() < .5 ? 'M' : 'F';
  store.insert('users', { phone: '+91 0' + String(1000000 + i), name: FIRST[Math.floor(R() * FIRST.length)] + ' ' + LAST[Math.floor(R() * LAST.length)], dob: (1975 + Math.floor(R() * 30)) + '-0' + (1 + Math.floor(R() * 9)) + '-1' + Math.floor(R() * 9),
    gender: g, bg: bg(), weight: 52 + Math.floor(R() * 40), city, last: R() < .5 ? '' : day(-(100 + Math.floor(R() * 300))), available: R() < .85, presence: { lat: la, lng: lo, seen: Date.now() },
    verify: { status: 'verified', method: 'digilocker', at: Date.now(), name: 'Demo', docs: [] }, status: 'active', createdAt: Date.now() - Math.floor(R() * 20) * 864e5, tv: 0, lang: 'en', devices: [], demo: true });
}
store.flush();
console.log('Seeded ' + banks.length + ' banks, 4 centres, 4 camps and ' + N + ' demo donors around ' + city + '.');
