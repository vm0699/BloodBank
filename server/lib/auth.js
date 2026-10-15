'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

let SECRET = null;
function secret(dataDir) {
  if (SECRET) return SECRET;
  if (process.env.JWT_SECRET) return (SECRET = process.env.JWT_SECRET);
  const f = path.join(dataDir, 'jwt.secret');
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch (e) {}
  if (!SECRET) { SECRET = crypto.randomBytes(48).toString('hex'); fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
  return SECRET;
}

function sign(payload, dataDir, ttlSec) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(Object.assign({}, payload, { iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec })));
  const sig = b64u(crypto.createHmac('sha256', secret(dataDir)).update(head + '.' + body).digest());
  return head + '.' + body + '.' + sig;
}
function verify(token, dataDir) {
  try {
    const [h, b, s] = String(token).split('.');
    const exp = b64u(crypto.createHmac('sha256', secret(dataDir)).update(h + '.' + b).digest());
    if (!s || s.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(exp))) return null;
    const p = JSON.parse(unb64u(b).toString('utf8'));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch (e) { return null; }
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  try {
    const [s, h] = String(stored).split(':');
    const x = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
    return crypto.timingSafeEqual(x, Buffer.from(h, 'hex'));
  } catch (e) { return false; }
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// Indian mobile numbers: accepts 9876543210, 09876543210, 919876543210, +91 98765 43210 -> "+919876543210"
function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  const ten = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? '+91' + ten : null;
}
const showPhone = p => (p && /^\+91\d{10}$/.test(p)) ? '+91 ' + p.slice(3, 8) + ' ' + p.slice(8) : (p || '');

module.exports = { sign, verify, hashPassword, checkPassword, sha, normPhone, showPhone, secret };
