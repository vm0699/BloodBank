'use strict';
const crypto = require('crypto');

function hav(la1, lo1, la2, lo2) {
  const r = Math.PI / 180, dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
// Donors are never shown at their exact position: a stable-per-hour offset of up to `meters` is applied,
// so repeatedly polling cannot average the noise away within the hour.
function jitter(lat, lng, seed, meters) {
  const h = crypto.createHash('sha256').update(seed + ':' + Math.floor(Date.now() / 36e5)).digest();
  const ang = h.readUInt16BE(0) / 65535 * 2 * Math.PI, d = h.readUInt16BE(2) / 65535 * (meters || 300);
  return [lat + d * Math.sin(ang) / 111320, lng + d * Math.cos(ang) / (111320 * Math.cos(lat * Math.PI / 180))];
}
const validLL = (la, lo) => Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180;
module.exports = { hav, jitter, validLL };
