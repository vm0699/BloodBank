'use strict';
// Looks an address up on OpenStreetMap (Nominatim) so a hospital's pin and "Directions" point at its real building,
// not at the city centre. Safe by design: short timeout, never throws, and a result is only accepted when it is
// within maxKm of the point we already have (so a wrong match in another town is ignored).
const { hav } = require('./geo');
const UA = 'LifeLink/1.0 (blood donation app)';

async function geocode(query, nearLat, nearLng, maxKm) {
  if (!query || process.env.LIFELINK_NO_GEOCODE === '1') return null;
  try {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 4500);
    const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=' + encodeURIComponent(query), { headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: ac.signal });
    clearTimeout(t);
    const j = await r.json(); if (!j[0]) return null;
    const lat = +j[0].lat, lng = +j[0].lon;
    if (Number.isFinite(nearLat) && Number.isFinite(nearLng) && hav(lat, lng, nearLat, nearLng) > (maxKm || 60)) return null;
    return { lat, lng };
  } catch (e) { return null; }
}
module.exports = { geocode };
