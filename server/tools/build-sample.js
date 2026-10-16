// Builds server/lib/sample_tn.json: Tamil Nadu sample hospitals, camps, transplant centres, donors (Tamil names) and open requests.
//   node tools/build-sample.js
// Coordinates come from OpenStreetMap (Nominatim) by name + address, so map pins and "Directions" land on the real buildings.
// A result is only accepted when it is within 6 km of the hand-entered fallback point; otherwise the fallback is kept and reported.
'use strict';
const fs = require('fs');
const path = require('path');

const UA = 'LifeLink-sample-data/1.0 (blood donation app; contact: writetovignesh.m@gmail.com)';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hav = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)); };
async function geocode(q) {
  const u = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=' + encodeURIComponent(q);
  try { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } }); const j = await r.json(); return j[0] ? { lat: +j[0].lat, lng: +j[0].lon, label: j[0].display_name } : null; } catch (e) { return null; }
}

// key, name, type, address, city, geocode query, fallback [lat, lng]
const HOSP = [
  ['rggh', 'Rajiv Gandhi Government General Hospital', 'Government', 'Park Town, Poonamallee High Road', 'Chennai', 'Rajiv Gandhi Government General Hospital, Park Town, Chennai', [13.0816, 80.2758]],
  ['apollo', 'Apollo Hospitals, Greams Road', 'Hospital-based', 'Greams Lane, Off Greams Road, Thousand Lights', 'Chennai', 'Apollo Hospitals, Greams Road, Chennai', [13.0627, 80.2518]],
  ['miot', 'MIOT International', 'Hospital-based', '4/112, Mount Poonamallee Road, Manapakkam', 'Chennai', 'MIOT International Hospital, Manapakkam, Chennai', [13.0217, 80.1855]],
  ['srmc', 'Sri Ramachandra Medical Centre', 'Hospital-based', 'No. 1, Ramachandra Nagar, Porur', 'Chennai', 'Sri Ramachandra Medical Centre, Porur, Chennai', [13.0357, 80.1462]],
  ['stanley', 'Stanley Medical College Hospital', 'Government', 'Old Jail Road, Royapuram', 'Chennai', 'Stanley Medical College Hospital, Royapuram, Chennai', [13.1066, 80.2870]],
  ['kauvery', 'Kauvery Hospital, Alwarpet', 'Hospital-based', '81, TTK Road, Alwarpet', 'Chennai', 'Kauvery Hospital, TTK Road, Alwarpet, Chennai', [13.0343, 80.2539]],
  ['royapettah', 'Government Royapettah Hospital', 'Government', 'Royapettah High Road, Royapettah', 'Chennai', 'Government Royapettah Hospital, Chennai', [13.0548, 80.2633]],
  ['rela', 'Rela Hospital, Chromepet', 'Hospital-based', 'No. 7, CLC Works Road, Chromepet', 'Chennai', 'Rela Institute and Medical Centre, Chromepet, Chennai', [12.9496, 80.1403]],
  ['srm', 'SRM Medical College Hospital', 'Hospital-based', 'SRM Nagar, Potheri, Kattankulathur', 'Kattankulathur', 'SRM Medical College Hospital and Research Centre, Kattankulathur', [12.8225, 80.0455]],
  ['cgmch', 'Chengalpattu Government Medical College Hospital', 'Government', 'GST Road, Chengalpattu', 'Chengalpattu', 'Chengalpattu Government Medical College Hospital, Chengalpattu', [12.6872, 79.9786]],
  ['grh', 'Government Rajaji Hospital', 'Government', 'Panagal Road, Madurai', 'Madurai', 'Government Rajaji Hospital, Madurai', [9.9255, 78.1350]],
  ['mmh', 'Meenakshi Mission Hospital', 'Hospital-based', 'Lake Area, Melur Road, Madurai', 'Madurai', 'Meenakshi Mission Hospital and Research Centre, Madurai', [9.9571, 78.1587]],
  ['cmch', 'Coimbatore Medical College Hospital', 'Government', 'Avinashi Road, Coimbatore', 'Coimbatore', 'Coimbatore Medical College Hospital, Coimbatore', [11.0166, 76.9694]],
  ['psg', 'PSG Hospitals', 'Hospital-based', 'Avinashi Road, Peelamedu, Coimbatore', 'Coimbatore', 'PSG Hospitals, Peelamedu, Coimbatore', [11.0246, 77.0010]],
  ['mgmgh', 'Mahatma Gandhi Memorial Government Hospital', 'Government', 'Tiruchirappalli', 'Tiruchirappalli', 'Mahatma Gandhi Memorial Government Hospital, Tiruchirappalli', [10.8164, 78.6885]],
  ['salem', 'Government Mohan Kumaramangalam Medical College Hospital', 'Government', 'Salem', 'Salem', 'Government Mohan Kumaramangalam Medical College Hospital, Salem', [11.6746, 78.1359]]
];
const CENTRES = [
  ['Institute of Nephrology, Rajiv Gandhi GGH', ['Kidney'], 'Chennai', 'Institute of Nephrology, Rajiv Gandhi Government General Hospital, Chennai', [13.0816, 80.2758]],
  ['MGM Healthcare, Aminjikarai', ['Kidney', 'Liver', 'Heart', 'Lungs'], 'Chennai', 'MGM Healthcare, Aminjikarai, Chennai', [13.0735, 80.2229]],
  ['Sankara Nethralaya Eye Bank, Nungambakkam', ['Cornea'], 'Chennai', 'Sankara Nethralaya, Nungambakkam, Chennai', [13.0611, 80.2409]],
  ['Kovai Medical Center and Hospital (KMCH)', ['Kidney', 'Liver'], 'Coimbatore', 'Kovai Medical Center and Hospital, Avinashi Road, Coimbatore', [11.0305, 77.0396]],
  ['Aravind Eye Hospital Eye Bank, Madurai', ['Cornea'], 'Madurai', 'Aravind Eye Hospital, Anna Nagar, Madurai', [9.9373, 78.1422]]
];
// title, organiser, venue, geocode query, fallback, days ahead, nearest hospital key
const CAMPS = [
  ['SRM NSS Blood Donation Camp', 'NSS Unit, SRM Institute of Science and Technology', 'SRM IST Campus, Kattankulathur', 'SRM Institute of Science and Technology, Kattankulathur', [12.8231, 80.0444], 1, 'srm'],
  ['Tamil Nadu Youth Welfare Blood Camp', 'Youth Welfare Association', 'Community Hall, Anna Nagar, Chennai', 'Anna Nagar, Chennai', [13.0850, 80.2101], 3, 'rggh'],
  ['Marina Volunteers Blood Drive', 'Marina Volunteers Forum', 'Marina Beach, Kamarajar Salai, Chennai', 'Marina Beach, Chennai', [13.0500, 80.2824], 5, 'royapettah'],
  ['Meenakshi Youth Blood Donation Camp', 'Madurai Youth Forum', 'Community Hall near Meenakshi Amman Temple, Madurai', 'Meenakshi Amman Temple, Madurai', [9.9195, 78.1193], 4, 'grh'],
  ['Kovai Rotary Blood Camp', 'Rotary Club of Coimbatore', 'Race Course Road, Coimbatore', 'Race Course, Coimbatore', [11.0035, 76.9740], 6, 'cmch'],
  ['Trichy Lions Club Blood Donation Camp', 'Lions Club, Tiruchirappalli', 'Srirangam, Tiruchirappalli', 'Srirangam, Tiruchirappalli', [10.8627, 78.6870], 8, 'mgmgh']
];
// patient (Tamil name), blood group, units, hospital key, urgency
const REQUESTS = [
  ['Murugesan Pillai', 'O+', 2, 'rggh', 'critical'], ['Lakshmi Ammal', 'B+', 1, 'apollo', 'urgent'], ['Karthik Raja', 'A+', 3, 'miot', 'urgent'],
  ['Thenmozhi Arasu', 'AB+', 1, 'srm', 'planned'], ['Selvaraj Kannan', 'O-', 2, 'grh', 'critical'], ['Pavithra Suresh', 'B-', 1, 'psg', 'urgent']
];
// [Latin name, Tamil name, gender]
const PEOPLE = [
  ['Murugan Selvam', 'முருகன் செல்வம்', 'M'], ['Karthikeyan Subramanian', 'கார்த்திகேயன் சுப்பிரமணியன்', 'M'], ['Vignesh Kumar', 'விக்னேஷ் குமார்', 'M'], ['Arun Pandian', 'அருண் பாண்டியன்', 'M'],
  ['Senthil Nathan', 'செந்தில் நாதன்', 'M'], ['Ganesh Babu', 'கணேஷ் பாபு', 'M'], ['Prakash Rajan', 'பிரகாஷ் ராஜன்', 'M'], ['Saravanan Mani', 'சரவணன் மணி', 'M'],
  ['Dinesh Kannan', 'தினேஷ் கண்ணன்', 'M'], ['Manikandan Raja', 'மணிகண்டன் ராஜா', 'M'], ['Vijay Anand', 'விஜய் ஆனந்த்', 'M'], ['Ramesh Chandran', 'ரமேஷ் சந்திரன்', 'M'],
  ['Balaji Sundaram', 'பாலாஜி சுந்தரம்', 'M'], ['Harish Venkat', 'ஹரிஷ் வெங்கட்', 'M'], ['Elango Thirumal', 'இளங்கோ திருமால்', 'M'], ['Gopinath Raman', 'கோபிநாத் ராமன்', 'M'],
  ['Naveen Karthik', 'நவீன் கார்த்திக்', 'M'], ['Siva Ganesan', 'சிவா கணேசன்', 'M'], ['Muthu Pandi', 'முத்து பாண்டி', 'M'], ['Anbu Selvan', 'அன்பு செல்வன்', 'M'],
  ['Selvi Murugesan', 'செல்வி முருகேசன்', 'F'], ['Meenakshi Sundaram', 'மீனாட்சி சுந்தரம்', 'F'], ['Kavitha Raman', 'கவிதா ராமன்', 'F'], ['Lakshmi Priya', 'லட்சுமி பிரியா', 'F'],
  ['Deepa Krishnan', 'தீபா கிருஷ்ணன்', 'F'], ['Nandhini Raj', 'நந்தினி ராஜ்', 'F'], ['Thenmozhi Arasu', 'தேன்மொழி அரசு', 'F'], ['Anitha Velan', 'அனிதா வேலன்', 'F'],
  ['Gayathri Devi', 'காயத்ரி தேவி', 'F'], ['Revathi Mani', 'ரேவதி மணி', 'F'], ['Yazhini Karthik', 'யாழினி கார்த்திக்', 'F'], ['Pavithra Suresh', 'பவித்ரா சுரேஷ்', 'F'],
  ['Abirami Natarajan', 'அபிராமி நடராஜன்', 'F'], ['Janani Prakash', 'ஜனனி பிரகாஷ்', 'F'], ['Sangeetha Mohan', 'சங்கீதா மோகன்', 'F'], ['Vasanthi Ezhil', 'வசந்தி எழில்', 'F'],
  ['Kalaiselvi Pandian', 'கலைச்செல்வி பாண்டியன்', 'F'], ['Mythili Sekar', 'மைதிலி சேகர்', 'F'], ['Oviya Sathish', 'ஓவியா சதீஷ்', 'F'], ['Bharathi Kannan', 'பாரதி கண்ணன்', 'F']
];
// donors are spread around these hospitals (weighted towards Chennai and the SRM / Kattankulathur area)
const SPREAD = ['rggh', 'miot', 'srm', 'apollo', 'srmc', 'srm', 'stanley', 'kauvery', 'rela', 'srm', 'royapettah', 'cgmch', 'grh', 'mmh', 'cmch', 'psg', 'mgmgh', 'salem', 'rggh', 'miot', 'srm', 'apollo'];
const BG_W = [['O+', 30], ['B+', 25], ['A+', 20], ['AB+', 7], ['O-', 6], ['B-', 5], ['A-', 5], ['AB-', 2]];

let seed = 20261016; const R = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pickBG = () => { let x = R() * 100; for (const [g, w] of BG_W) if ((x -= w) < 0) return g; return 'O+'; };

async function resolve(label, query, fb, maxKm, alts) {
  // try the full query, then simpler ones (OSM often knows a place under a shorter name)
  const tries = [query].concat(alts || []);
  let last = null;
  for (const q of tries) {
    await sleep(1150);
    const g = await geocode(q);
    if (g) last = g;
    if (g && hav(g.lat, g.lng, fb[0], fb[1]) <= maxKm) return { lat: +g.lat.toFixed(6), lng: +g.lng.toFixed(6), geo: 'osm', note: g.label.split(',').slice(0, 3).join(',') };
  }
  console.log('  ! kept fallback for', label, last ? '(closest OSM result ' + hav(last.lat, last.lng, fb[0], fb[1]).toFixed(1) + ' km away: ' + last.label.slice(0, 60) + ')' : '(no OSM result)');
  return { lat: fb[0], lng: fb[1], geo: 'fallback', note: '' };
}
const shortQ = (name, city) => [name.replace(/,.*$/, '') + ', ' + city, name.replace(/,.*$/, '').replace(/ (Hospital|Hospitals|Medical Centre|Medical College Hospital)$/i, '') + ' ' + city];

(async () => {
  const out = { builtAt: new Date().toISOString(), hospitals: [], centres: [], camps: [], requests: [], donors: [] };
  const at = {};
  for (const [key, name, type, address, city, q, fb] of HOSP) {
    const c = await resolve(name, q, fb, 6, shortQ(name, city));
    at[key] = c; out.hospitals.push({ key, name, type, address, city, hours: '24 x 7', lat: c.lat, lng: c.lng, geo: c.geo });
    console.log((c.geo === 'osm' ? 'ok  ' : 'FALL') + ' ' + name + ' -> ' + c.lat + ', ' + c.lng + '  ' + c.note);
  }
  for (const [name, programs, city, q, fb] of CENTRES) {
    const c = await resolve(name, q, fb, 6, shortQ(name, city));
    out.centres.push({ name, programs, city, lat: c.lat, lng: c.lng, geo: c.geo }); console.log((c.geo === 'osm' ? 'ok  ' : 'FALL') + ' ' + name + ' -> ' + c.lat + ', ' + c.lng);
  }
  for (const [title, org, venue, q, fb, days, near] of CAMPS) {
    const c = await resolve(venue, q, fb, 8);
    out.camps.push({ title, org, venue, days, bank: near, lat: c.lat, lng: c.lng, geo: c.geo }); console.log((c.geo === 'osm' ? 'ok  ' : 'FALL') + ' ' + title + ' -> ' + c.lat + ', ' + c.lng);
  }
  // donors: 40 people spread around the hospitals, within ~3 km of each
  PEOPLE.forEach(([name, nameTa, gender], i) => {
    const key = SPREAD[i % SPREAD.length], c = at[key], h = out.hospitals.find(x => x.key === key);
    const r = 3 * Math.sqrt(R()), t = R() * 6.2832;
    const lat = c.lat + r * Math.sin(t) / 111.32, lng = c.lng + r * Math.cos(t) / (111.32 * Math.cos(c.lat * Math.PI / 180));
    out.donors.push({ name, nameTa, gender, bg: pickBG(), city: h.city, area: h.address.split(',').slice(-1)[0].trim(), lat: +lat.toFixed(6), lng: +lng.toFixed(6),
      dobYear: 1984 + Math.floor(R() * 20), weight: 52 + Math.floor(R() * 34), donatedBefore: Math.floor(R() * 12), lastDaysAgo: R() < .45 ? 0 : 100 + Math.floor(R() * 260), verified: R() < .7 });
  });
  REQUESTS.forEach(([patient, bg, units, hospital, urgency]) => out.requests.push({ patient, bg, units, hospital, urgency }));
  const file = path.join(__dirname, '..', 'lib', 'sample_tn.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  console.log('\nWrote ' + file + ': ' + out.hospitals.length + ' hospitals, ' + out.centres.length + ' centres, ' + out.camps.length + ' camps, ' + out.donors.length + ' donors, ' + out.requests.length + ' requests.');
})();
