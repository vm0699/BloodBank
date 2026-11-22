'use strict';
// Turns an address into a map point so a hospital's pin and "Directions" land on its real building, not on the city centre.
// Uses Mapbox Geocoding when MAPBOX_TOKEN (or MAPBOX_GEOCODE_TOKEN) is set, and OpenStreetMap Nominatim otherwise or as a fallback.
// Safe by design: short timeout, never throws, and a result is only accepted when it is within maxKm of the point we already have
// (so a wrong match in another town is ignored).
// Note: Mapbox's terms treat geocoding results you STORE as "permanent geocoding"; set MAPBOX_PERMANENT=1 once that is enabled on the account.
const { hav } = require('./geo');
const UA = 'LifeLink/1.0 (blood donation app)';
const token = () => process.env.MAPBOX_GEOCODE_TOKEN || process.env.MAPBOX_TOKEN || '';

async function getJson(url, headers) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 4500);
  try { const r = await fetch(url, { headers: headers || {}, signal: ac.signal }); return r.ok ? await r.json() : null; } finally { clearTimeout(t); }
}

// Mapbox Geocoding v6 forward search -> [{ label, name, city, lat, lng }]
async function mapboxSearch(query, nearLat, nearLng, limit, autocomplete) {
  const tk = token(); if (!tk || !query) return [];
  try {
    const u = new URL('https://api.mapbox.com/search/geocode/v6/forward');
    u.searchParams.set('q', query); u.searchParams.set('country', 'in'); u.searchParams.set('language', 'en');
    u.searchParams.set('limit', String(limit || 1)); u.searchParams.set('autocomplete', autocomplete ? 'true' : 'false'); u.searchParams.set('access_token', tk);
    if (Number.isFinite(nearLat) && Number.isFinite(nearLng)) u.searchParams.set('proximity', nearLng + ',' + nearLat);
    if (process.env.MAPBOX_PERMANENT === '1') u.searchParams.set('permanent', 'true');
    const j = await getJson(u.toString());
    return ((j && j.features) || []).map(f => {
      const p = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [];
      return { label: p.full_address || [p.name, p.place_formatted].filter(Boolean).join(', '), name: p.name || '', city: (p.context && p.context.place && p.context.place.name) || '', lat: +c[1], lng: +c[0] };
    }).filter(r => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  } catch (e) { return []; }
}

async function nominatim(query) {
  try {
    const j = await getJson('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=' + encodeURIComponent(query), { 'User-Agent': UA, 'Accept-Language': 'en' });
    return j && j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
  } catch (e) { return null; }
}

async function geocode(query, nearLat, nearLng, maxKm) {
  if (!query || process.env.LIFELINK_NO_GEOCODE === '1') return null;
  const ok = g => g && Number.isFinite(g.lat) && Number.isFinite(g.lng) && !(Number.isFinite(nearLat) && Number.isFinite(nearLng) && hav(g.lat, g.lng, nearLat, nearLng) > (maxKm || 60));
  const m = (await mapboxSearch(query, nearLat, nearLng, 1, false))[0];
  if (ok(m)) return { lat: m.lat, lng: m.lng };
  const n = await nominatim(query);
  return ok(n) ? n : null;
}

// Address suggestions for the hospital registration form (autocomplete). Empty when no Mapbox token is configured.
async function suggest(query, nearLat, nearLng) {
  if (!query || query.length < 3 || process.env.LIFELINK_NO_GEOCODE === '1') return [];
  return (await mapboxSearch(query, nearLat, nearLng, 5, true)).map(r => ({ label: r.label, name: r.name, city: r.city, lat: r.lat, lng: r.lng }));
}
module.exports = { geocode, suggest, mapboxEnabled: () => !!token() };
