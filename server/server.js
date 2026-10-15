// LifeLink backend. Zero dependencies (Node 18+).      node server.js
//   /api/...   mobile app API (phone OTP login, donors, requests, camps, organ pledge, DigiLocker, push)
//   /api/admin/...  admin + blood-bank staff API        /admin   the admin portal (served from ./admin)
// See ../docs/BACKEND.md for setup, environment variables and deployment.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

/* ---------- env (.env file support, no dependency) ---------- */
if (!process.env.LIFELINK_NO_ENV) try {   // tests set LIFELINK_NO_ENV so a developer's .env cannot leak into them
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) {}
const env = process.env;

/* ---------- production safety checks ---------- */
const PROD = env.NODE_ENV === 'production';
if (PROD && env.DEV_OTP === '1') { console.error('  !! Refusing to start: DEV_OTP=1 shows login codes on screen and must never be set in production.'); process.exit(1); }
if (PROD && !env.JWT_SECRET) console.error('  !! JWT_SECRET is not set. Sessions will reset whenever the data folder is recreated. Set a long random JWT_SECRET.');
if (PROD && !/^https:\/\//.test(env.PUBLIC_BASE_URL || '')) console.error('  !! PUBLIC_BASE_URL should be your public https address (DigiLocker returns there).');
process.on('unhandledRejection', e => console.error('unhandled rejection:', e && e.stack || e));

const { Store } = require('./lib/store');
const A = require('./lib/auth');
const { HttpError } = require('./lib/http');
const { parseForm } = require('./lib/http');

const PORT = +env.PORT || 8787;
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
// MONGO_URI set -> user profiles and all app data live in MongoDB; otherwise the single JSON file (dev / tests).
const store = env.MONGO_URI ? new (require('./lib/mongostore').MongoStore)(env.MONGO_URI) : new Store(path.join(DATA_DIR, 'lifelink.json'));
const core = require('./lib/core').create(store, DATA_DIR);
const dl = require('./lib/digilocker')({ store, core, env, dataDir: DATA_DIR });

/* ---------- allowed browser origins (CORS) ---------- */
const ORIGINS = ['https://appassets.androidplatform.net', 'http://localhost:5188', 'http://localhost:8080', 'http://localhost:' + PORT]
  .concat((env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));

/* ---------- rate limiter (in-memory sliding window) ---------- */
const limiter = {
  hits: new Map(),
  take(key, max, windowMs) {
    const now = Date.now(), h = (this.hits.get(key) || []).filter(t => now - t < windowMs);
    if (h.length >= max) { this.hits.set(key, h); return false; }
    h.push(now); this.hits.set(key, h); return true;
  }
};
setInterval(() => { const now = Date.now(); for (const [k, v] of limiter.hits) if (!v.length || now - v[v.length - 1] > 3600e3) limiter.hits.delete(k); }, 600e3).unref();

/* ---------- router ---------- */
const routes = [];
const R = {
  add(method, pattern, opts, handler) {
    const keys = [], re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, opts: opts || {}, handler });
  }
};
require('./routes_app')(R, { store, core, dl, env, dataDir: DATA_DIR, limiter });
require('./routes_hospital')(R, { store, core });
require('./routes_admin')(R, { store, core, env, dataDir: DATA_DIR, limiter });

/* ---------- first admin ---------- */
function bootstrapAdmin() {
  if (store.list('admins').length) return;
  const email = (env.ADMIN_EMAIL || 'admin@lifelink.local').toLowerCase();
  const pw = env.ADMIN_PASSWORD || require('crypto').randomBytes(9).toString('base64url');
  store.insert('admins', { email, name: 'Administrator', role: 'admin', pass: A.hashPassword(pw), active: true, created: Date.now(), tv: 0 });
  store.flush();
  console.log('\n  First admin created -> email: ' + email + (env.ADMIN_PASSWORD ? '' : '   password: ' + pw + '   (shown once - change it in the portal)') + '\n');
}
// File store is ready immediately; MongoDB loads its collections first (tests/hosts must await `ready`).
const boot = () => { bootstrapAdmin(); core.migrate(); };
const ready = env.MONGO_URI ? store.init().then(boot) : (boot(), Promise.resolve());

/* ---------- http plumbing ---------- */
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ORIGINS.includes(o)) { res.setHeader('Access-Control-Allow-Origin', o); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
}
function readBody(req, max) {
  return new Promise((ok, fail) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > max) { fail(new HttpError(413, 'Payload too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)' };
if (/^https:\/\//.test(env.PUBLIC_BASE_URL || '')) SEC['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
// Admin portal + legal pages only (not the DigiLocker pages, which redirect back into the app's own URL scheme)
const PAGE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const send = (res, code, type, body, extra) => { res.writeHead(code, Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store' }, SEC, extra || {})); res.end(body); };
const sendJson = (res, code, obj) => send(res, code, 'application/json', JSON.stringify(obj));

const STATIC = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(res, file) {
  try { send(res, 200, STATIC[path.extname(file)] || 'application/octet-stream', fs.readFileSync(file), { 'Cache-Control': 'no-cache', 'Content-Security-Policy': PAGE_CSP }); return true; } catch (e) { return false; }
}

async function handle(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const ip = (env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  if (!limiter.take('ip:' + ip, 300, 60e3)) return sendJson(res, 429, { error: 'Too many requests' });
  const url = new URL(req.url, 'http://x');

  /* admin portal + its assets */
  if (url.pathname === '/' ) { res.writeHead(302, { Location: '/admin' }); return res.end(); }
  if (url.pathname === '/privacy' || url.pathname === '/terms') {
    try {
      const support = env.SUPPORT_EMAIL ? 'at ' + env.SUPPORT_EMAIL : 'through Settings in the LifeLink app';
      const html = fs.readFileSync(path.join(__dirname, 'legal', url.pathname.slice(1) + '.html'), 'utf8').replace(/\{\{SUPPORT\}\}/g, support);
      return send(res, 200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'public, max-age=3600', 'Content-Security-Policy': PAGE_CSP });
    } catch (e) { /* falls through to 404 */ }
  }
  if (url.pathname === '/admin' || url.pathname === '/admin/') { if (serveStatic(res, path.join(__dirname, 'admin', 'index.html'))) return; }
  if (url.pathname.startsWith('/admin/leaflet.')) { if (serveStatic(res, path.join(__dirname, '..', 'libs', 'leaflet', url.pathname.slice(7)))) return; }
  if (url.pathname === '/admin/favicon.svg') { if (serveStatic(res, path.join(__dirname, '..', 'icon.svg'))) return; }
  if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });

  const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
  if (!route) return sendJson(res, 404, { error: 'Not found' });
  const m = url.pathname.match(route.re), params = {};
  route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

  const ctx = { req, res, ip, url, params, query: Object.fromEntries(url.searchParams), body: {}, user: null, admin: null };
  const auth = route.opts.auth || 'public';
  if (auth !== 'public') {
    const tok = String(req.headers.authorization || '').replace(/^Bearer /, ''), p = A.verify(tok, DATA_DIR);
    if (auth === 'user') {
      const u = p && p.typ === 'user' && store.get('users', p.sub);
      if (!u || (u.tv || 0) !== (p.tv || 0)) throw new HttpError(401, 'Please sign in again');
      if (u.status === 'suspended') throw new HttpError(403, 'This account is suspended. Contact support.');
      ctx.user = u;
    } else {
      const a = p && p.typ === 'admin' && store.get('admins', p.sub);
      if (!a || a.active === false || (a.tv || 0) !== (p.tv || 0)) throw new HttpError(401, 'Please sign in again');
      if (route.opts.role && a.role !== route.opts.role) throw new HttpError(403, 'Not allowed for your role');
      ctx.admin = a;
    }
  }
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    const raw = await readBody(req, route.opts.maxBody || 256 * 1024);
    if (route.opts.form) ctx.body = parseForm(raw);
    else if (raw) { try { ctx.body = JSON.parse(raw); } catch (e) { throw new HttpError(400, 'Invalid JSON'); } }
  }
  if (auth === 'user' && core.cfg().maintenance) throw new HttpError(503, 'LifeLink is under maintenance. Please try again soon.');
  const out = await route.handler(ctx);
  if (out && out.__stream) return;   // the handler took over the response (live event stream)
  if (out && out.__html !== undefined) return send(res, out.code || 200, 'text/html; charset=utf-8', out.__html);
  if (out && out.__redirect) { res.writeHead(302, { Location: out.__redirect }); return res.end(); }
  if (out && out.__raw !== undefined) return send(res, 200, out.type || 'application/octet-stream', out.__raw, out.filename ? { 'Content-Disposition': 'attachment; filename="' + out.filename + '"' } : {});
  sendJson(res, 200, out || { ok: true });
}
const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (e instanceof HttpError) return sendJson(res, e.status, Object.assign({ error: e.message }, e.extra));
    console.error(e); if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
  });
});

if (require.main === module) {
  const smsMissing = require('./lib/sms').missing();
  if (smsMissing) console.error('\n  !! SMS_PROVIDER=' + require('./lib/sms').provider() + ' is missing: ' + smsMissing + '  (OTP login will fail until set)\n');
  ready.then(() => {
    server.listen(PORT, () => {
      console.log('LifeLink API on ' + (env.PUBLIC_BASE_URL || 'http://localhost:' + PORT) + '  | admin portal: /admin  | DigiLocker: ' + dl.PROVIDER +
        ' | SMS: ' + require('./lib/sms').provider() + ' | push: ' + (require('./lib/push').enabled() ? 'FCM on' : 'off') +
        ' | database: ' + (env.MONGO_URI ? 'MongoDB ' + env.MONGO_URI.replace(/\/\/[^@]*@/, '//').replace(/\?.*$/, '') : 'JSON file ' + DATA_DIR));
    });
    setInterval(() => { try { core.jobs(); } catch (e) { console.error('jobs failed:', e.message); } }, 10 * 60e3).unref();
    core.jobs();
  }).catch(e => { console.error('\n  !! Could not start: ' + e.message + (env.MONGO_URI ? '\n  Is the LifeLink database running?  server\\mongo\\start-db.cmd\n' : '\n')); process.exit(1); });
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; Promise.resolve(store.close ? store.close() : store.flush()).catch(() => {}).then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
module.exports = { server, store, core, ready };
