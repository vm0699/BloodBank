'use strict';
class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; } }
const bad = (m, extra) => new HttpError(400, m, extra);

const str = (v, max, def) => { if (v == null) return def == null ? '' : def; return String(v).trim().slice(0, max || 200); };
const num = (v, min, max) => { const n = +v; return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const isDay = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(new Date(v + 'T00:00:00'));
const oneOf = (v, list) => list.includes(v) ? v : null;

function parseForm(body) { const o = {}; new URLSearchParams(body).forEach((v, k) => { o[k] = k in o ? [].concat(o[k], v) : v; }); return o; }

module.exports = { HttpError, bad, str, num, isDay, oneOf, parseForm };
