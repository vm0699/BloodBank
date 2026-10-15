'use strict';
// DigiLocker verification, bound to the signed-in LifeLink user. Three interchangeable providers (DL_PROVIDER):
//
//   mock        built-in stand-in for DigiLocker's sign-in + consent screens (development / demos). Default with no credentials.
//   oauth       direct DigiLocker "requester" partner (OAuth2 + PKCE): DL_CLIENT_ID / DL_CLIENT_SECRET.
//   setu        Setu's DigiLocker API (documented: consent link -> status -> Aadhaar JSON; scopes ADHAR / DRVLC / PANCR).
//               SETU_CLIENT_ID, SETU_CLIENT_SECRET, SETU_PRODUCT_INSTANCE_ID.
//   aggregator  any other licensed provider with a "create consent link" API (Gridlines, Cashfree, Digio ...): AGG_API_KEY,
//               with configurable paths and response fields.
//
// Flow (all providers):
//   app: POST /api/digilocker/start (signed in)  -> {session, authUrl}     "Continue to DigiLocker?" -> Yes
//   the app opens authUrl in a Chrome Custom Tab: the person signs in ON DIGILOCKER'S OWN SITE (we never see the
//   password or OTP) and is asked whether LifeLink may access their documents
//   DigiLocker/provider -> our return URL; we fetch name, DOB, gender, masked Aadhaar and the issued documents, save them
//   on the user's profile, and redirect back into the app (savrolifelink://digilocker/done?session=...).
//   app: GET /api/digilocker/result?session= and refreshes.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { sha } = require('./auth');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = n => b64u(crypto.randomBytes(n));

function docType(s) {
  s = String(s || '').toLowerCase();
  if (/adhar|aadhaar|aadhar/.test(s)) return 'aadhaar';
  if (/drvlc|driving/.test(s)) return 'dl';
  if (/pancr|\bpan\b/.test(s)) return 'pan';
  if (/votid|voter|epic/.test(s)) return 'voter';
  if (/passport/.test(s)) return 'passport';
  if (/blood|donor/.test(s)) return 'blood';
  return 'other';
}
const IDENTITY = ['aadhaar', 'dl', 'pan', 'voter', 'passport'];
const MOCK_DOCS = [['aadhaar', 'Aadhaar Card', 'UIDAI'], ['dl', 'Driving License', 'Transport Department'], ['pan', 'PAN Verification Record', 'Income Tax Department'], ['voter', 'Voter ID Card', 'Election Commission of India'], ['blood', 'Blood Donor Certificate', 'State Blood Transfusion Council']];

function toISODate(d) {
  if (!d) return '';
  const m = String(d).match(/^(\d{2})[-/]?(\d{2})[-/]?(\d{4})$/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : (/^\d{4}-\d{2}-\d{2}/.test(d) ? String(d).slice(0, 10) : '');
}
const gender = g => ({ M: 'M', F: 'F', T: 'O', MALE: 'M', FEMALE: 'F' }[String(g || '').toUpperCase()] || 'O');
function nameMatches(a, b) {
  const t = s => String(s).toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const A = t(a), B = t(b); if (!A.length || !B.length) return false;
  const [sm, lg] = A.length <= B.length ? [A, B] : [B, A];
  return sm.every(w => lg.some(x => x === w || (w.length === 1 && x[0] === w) || (x.length === 1 && w[0] === x)));
}
// depth-first search for the first non-empty scalar whose key matches `re` (provider JSON shapes vary)
function deepFind(o, re, depth) {
  if (!o || typeof o !== 'object' || (depth || 0) > 5) return undefined;
  for (const k of Object.keys(o)) { const v = o[k]; if (re.test(k) && v != null && typeof v !== 'object' && v !== '') return v; }
  for (const k of Object.keys(o)) { const r = deepFind(o[k], re, (depth || 0) + 1); if (r !== undefined) return r; }
  return undefined;
}
// first present value among "a.b|c.d" style alternatives
function pick(o, paths) {
  for (const p of String(paths).split('|')) {
    let v = o; for (const k of p.split('.')) { v = v == null ? undefined : v[k]; }
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}
const tenDigits = p => String(p || '').replace(/\D/g, '').slice(-10);

module.exports = function digilocker({ store, core, env, dataDir }) {
  const PORT = +env.PORT || 8787;
  const pub = () => (env.PUBLIC_BASE_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
  // Production host and paths per the official DigiLocker Requester API Specification (v1.12)
  const DL_BASE = (env.DL_BASE || 'https://api.digitallocker.gov.in').replace(/\/$/, '');
  const ID = env.DL_CLIENT_ID || '', SECRET = env.DL_CLIENT_SECRET || '';
  const URLS = {
    authorize: env.DL_AUTHORIZE_URL || DL_BASE + '/public/oauth2/1/authorize', token: env.DL_TOKEN_URL || DL_BASE + '/public/oauth2/1/token',
    user: env.DL_USER_URL || DL_BASE + '/public/oauth2/1/user', issued: env.DL_ISSUED_URL || DL_BASE + '/public/oauth2/2/files/issued',
    file: env.DL_FILE_URL || DL_BASE + '/public/oauth2/1/file', eaadhaar: env.DL_EAADHAAR_URL || DL_BASE + '/public/oauth2/3/xml/eaadhaar'
  };
  // Aggregator defaults follow Gridlines' documented init call; the other paths/field names are best-effort defaults and
  // every one is overridable. Run `node tools/dl-check.js` with a sandbox key to see the real responses and adjust.
  const AGG = {
    base: (env.AGG_BASE || 'https://api.gridlines.io').replace(/\/$/, ''), key: env.AGG_API_KEY || '',
    init: env.AGG_INIT_PATH || '/digilocker/init', issued: env.AGG_ISSUED_PATH || '/digilocker/issued-files',
    profile: env.AGG_PROFILE_PATH || '/digilocker/eaadhaar', file: env.AGG_FILE_PATH || '/digilocker/issued-file',
    signup: env.AGG_SIGNUP || 'PINLESS', consentDays: +env.AGG_CONSENT_DAYS || 30
  };
  const SETU = {
    base: (env.SETU_BASE || (env.SETU_ENV === 'production' ? 'https://dg.setu.co' : 'https://dg-sandbox.setu.co')).replace(/\/$/, ''),
    id: env.SETU_CLIENT_ID || '', secret: env.SETU_CLIENT_SECRET || '', instance: env.SETU_PRODUCT_INSTANCE_ID || ''
  };
  const PROVIDER = String(env.DL_PROVIDER || (ID ? 'oauth' : SETU.id ? 'setu' : AGG.key ? 'aggregator' : 'mock')).toLowerCase();
  const MOCK = PROVIDER === 'mock';
  const APP_RETURN = env.APP_RETURN_URL || 'savrolifelink://digilocker/done';
  const FETCH_FILES = env.DL_FETCH_FILES === '1';
  const PURPOSE = env.DL_PURPOSE || 'Blood donor identity verification';
  const sessions = new Map();
  setInterval(() => { const t = Date.now() - 20 * 60e3; for (const [k, v] of sessions) if (v.created < t) sessions.delete(k); }, 60e3).unref();

  const page = (title, inner) => '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title>' +
    '<style>body{font-family:system-ui,sans-serif;background:#F4F6FA;color:#1b2430;margin:0;padding:20px;max-width:460px;margin:auto}.card{background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 12px rgba(0,0,0,.08)}h1{font-size:20px;margin:0 0 6px}p{color:#51606f;font-size:14px}' +
    'label{display:block;font-size:13px;margin:12px 0 5px}input[type=text],input[type=password],select{width:100%;box-sizing:border-box;padding:12px;border:1px solid #cdd5df;border-radius:10px;font-size:16px;background:#fff}' +
    '.b{display:block;width:100%;box-sizing:border-box;text-align:center;padding:13px;border-radius:8px;background:#2ea44f;color:#fff;text-decoration:none;font-weight:600;border:0;font-size:16px;margin-top:16px}.g{background:#e8edf5;color:#1b2430}' +
    '.w{background:#FFF4D6;padding:10px 12px;border-radius:10px;font-size:13px;margin-bottom:14px}.d{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 4px;border-bottom:1px solid #e1e6ee;font-size:14px}.m{color:#6b7a8a}.ck{display:flex;gap:8px;align-items:center;font-size:14px;margin:8px 0}</style>' + inner;
  const MOCKBAR = '<div class="w"><b>Mock DigiLocker (development)</b> &middot; stands in for DigiLocker\'s own sign-in and consent pages. No real account or data is used.</div>';
  const expired = () => ({ html: page('Expired', '<div class="card"><h1>Session expired</h1><p>Go back to LifeLink and try again.</p></div>'), code: 400 });

  async function start(user, b) {
    const platform = b.platform === 'android' ? 'android' : 'web';
    let returnUrl = '';
    if (platform === 'web') {
      returnUrl = String(b.returnUrl || '');
      const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean).concat(['http://localhost:5188', 'http://localhost:8080', pub()]);
      if (!allowed.some(o => returnUrl === o || returnUrl.startsWith(o + '/'))) return { error: 'returnUrl not allowed' };
    }
    const id = rand(24), state = rand(16), verifier = rand(48), challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    const s = { id, userId: user.id, state, verifier, platform, returnUrl, result: null, created: Date.now(), phone: tenDigits(user.phone) };
    sessions.set(id, s);
    let authUrl;
    if (PROVIDER === 'mock') authUrl = pub() + '/api/digilocker/mock?state=' + state;
    else if (PROVIDER === 'oauth') {
      const q = { response_type: 'code', client_id: ID, redirect_uri: pub() + '/api/digilocker/callback', state, code_challenge: challenge, code_challenge_method: 'S256',
        purpose: env.DL_PURPOSE_CODE || 'verification',                                        // kyc | verification | compliance | availing_services | educational
        consent_valid_till: String(Math.floor(Date.now() / 1000) + (+env.DL_CONSENT_DAYS || 30) * 86400),
        verified_mobile: s.phone };                                                           // the number we already verified by OTP
      if (env.DL_REQ_DOCTYPE) q.req_doctype = env.DL_REQ_DOCTYPE;                             // e.g. ADHAR,DRVLC,PANCR (only types approved for your client id)
      authUrl = URLS.authorize + '?' + new URLSearchParams(q);
    }
    else if (PROVIDER === 'setu') { const l = await setuInit(s); s.tx = l.tx; authUrl = l.url; }
    else { const l = await aggInit(s); s.tx = l.tx; authUrl = l.url; }
    return { session: id, authUrl, mock: MOCK, provider: PROVIDER };
  }
  const byState = state => { for (const [, v] of sessions) if (v.state === state) return v; return null; };

  /* ---- aggregator ---- */
  const aggHeaders = (ref, tx) => Object.assign({ 'X-API-Key': AGG.key, 'X-Auth-Type': 'API-Key', 'X-Reference-ID': ref, 'Content-Type': 'application/json' }, tx ? { 'X-Transaction-ID': tx } : {});
  async function aggGet(p, ref, tx, qs) {
    const r = await fetch(AGG.base + p + (qs ? '?' + new URLSearchParams(qs) : ''), { headers: aggHeaders(ref, tx) });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
    if (!r.ok) throw new Error('provider ' + p + ' ' + r.status + ' ' + t.slice(0, 200));
    return { j, t, r };
  }
  async function aggInit(s) {
    const body = Object.assign({ redirect_uri: pub() + '/api/digilocker/return/' + s.state, mobile_number: s.phone, check_account_linked: true, sign_up_preference: AGG.signup, consent: 'Y', purpose: PURPOSE },
      (() => { try { return JSON.parse(env.AGG_INIT_EXTRA || '{}'); } catch (e) { return {}; } })());
    const r = await fetch(AGG.base + AGG.init, { method: 'POST', headers: aggHeaders(s.id), body: JSON.stringify(body) });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
    if (!r.ok) throw new Error('provider init ' + r.status + ' ' + t.slice(0, 300));
    const url = pick(j, env.AGG_URL_PATH || 'data.url|data.digilocker_url|data.redirect_url|data.link|url|link');
    const tx = pick(j, env.AGG_TX_PATH || 'data.transaction_id|data.request_id|data.verification_id|data.id|transaction_id|request_id') || r.headers.get('x-transaction-id') || '';
    if (!url) throw new Error('provider returned no consent link: ' + t.slice(0, 300));
    return { url, tx };
  }
  async function aggComplete(s, q, user) {
    if (/denied|reject|cancel|fail|expired/i.test(String(q.error || q.status || ''))) return { ok: false, error: 'denied' };
    const tx = s.tx || q.transaction_id || q.request_id || q.verification_id || '';
    const iss = (await aggGet(AGG.issued, s.id, tx)).j;
    const items = [].concat(pick(iss, env.AGG_ITEMS_PATH || 'data.files|data.documents|data.items|data.issued_files|data|files|items|documents') || []);
    const docs = [];
    for (const i of items.filter(x => x && typeof x === 'object')) {
      const uri = pick(i, 'uri|file_uri|document_uri'), name = pick(i, 'name|document_name|doc_name|doctype|type') || '';
      const type = docType(name + ' ' + (pick(i, 'doctype|document_type') || '') + ' ' + (uri || ''));
      if (type === 'other') continue;
      const d = { id: rand(6), uri, name: String(name), type, issuer: pick(i, 'issuer|issuer_name|issuerid') || '', at: Date.now(), file: false };
      if (FETCH_FILES && type !== 'aadhaar' && uri) {
        try {
          const r = await fetch(AGG.base + AGG.file + '?' + new URLSearchParams({ file_uri: uri, format: 'pdf' }), { headers: aggHeaders(s.id, tx) });
          if (r.ok) { const dir = path.join(dataDir, 'docs', user.id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, d.id + '.bin'), Buffer.from(await r.arrayBuffer())); d.file = true; d.mime = r.headers.get('content-type') || 'application/pdf'; }
        } catch (e) {}
      }
      docs.push(d);
    }
    let prof = {}; try { prof = (await aggGet(AGG.profile, s.id, tx)).j; } catch (e) { console.error('digilocker profile fetch failed:', e.message); }
    const name = String(pick(prof, 'data.name|name|data.full_name') || ''), dob = toISODate(pick(prof, 'data.dob|dob|data.date_of_birth')), g = gender(pick(prof, 'data.gender|gender'));
    const uid = String(pick(prof, 'data.uid|data.aadhaar_number|data.masked_aadhaar|uid|masked_aadhaar') || ''), digits = uid.replace(/\D/g, ''), last4 = digits.length >= 4 ? digits.slice(-4) : '';
    return { ok: true, dlid: String(pick(prof, 'data.digilocker_id|digilocker_id') || (name && dob ? 'agg-' + sha(name.toLowerCase() + dob + last4).slice(0, 24) : '')), name, dob, gender: g, last4, docs, consentUntil: Date.now() + AGG.consentDays * 864e5 };
  }

  /* ---- Setu ---- */
  const setuHeaders = () => ({ 'x-client-id': SETU.id, 'x-client-secret': SETU.secret, 'x-product-instance-id': SETU.instance, 'Content-Type': 'application/json' });
  async function setuCall(method, p, body) {
    const r = await fetch(SETU.base + p, { method, headers: setuHeaders(), body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
    if (!r.ok) throw new Error('setu ' + method + ' ' + p + ' ' + r.status + ' ' + t.slice(0, 300));
    return j;
  }
  async function setuInit(s) {
    const j = await setuCall('POST', '/api/digilocker/', { redirectUrl: pub() + '/api/digilocker/return/' + s.state });
    const url = pick(j, 'data.url|url'), tx = pick(j, 'data.id|id');
    if (!url || !tx) throw new Error('setu returned no consent link: ' + JSON.stringify(j).slice(0, 300));
    return { url, tx };
  }
  async function setuComplete(s, q, user) {
    console.log('[setu] return params:', JSON.stringify(Object.keys(q).filter(k => k !== 'state').reduce((o, k) => (o[k] = String(q[k]).slice(0, 80), o), {})));
    if (String(q.success).toLowerCase() === 'false' || q.error || q.errCode) return { ok: false, error: 'denied' };
    const id = s.tx || q.id, scope = String(q.scope || '').toUpperCase().split(/[\s,]+/);
    try { const st = String(pick(await setuCall('GET', '/api/digilocker/' + id + '/status'), 'data.status|status') || 'authenticated').toLowerCase(); if (st !== 'authenticated') return { ok: false, error: 'denied' }; } catch (e) { console.error('setu status failed:', e.message); }
    let aad = {};
    if (scope.includes('ADHAR') || !q.scope) { try { aad = await setuCall('GET', '/api/digilocker/' + id + '/aadhaar'); } catch (e) { console.error('setu aadhaar failed:', e.message); } }
    const name = String(deepFind(aad, /^(full_?name|name)$/i) || ''), dobRaw = deepFind(aad, /^(dob|date_?of_?birth|birth_?date)$/i), g = gender(deepFind(aad, /^gender$/i));
    const uid = String(deepFind(aad, /(^uid$|aadhaar.*(num|no)|masked)/i) || ''), digits = uid.replace(/\D/g, ''), last4 = digits.length >= 4 ? digits.slice(-4) : '';
    const docs = [];
    if (name || scope.includes('ADHAR')) docs.push({ id: rand(6), name: 'Aadhaar Card', type: 'aadhaar', issuer: 'UIDAI', at: Date.now(), file: false });
    if (scope.includes('DRVLC')) docs.push({ id: rand(6), name: 'Driving Licence', type: 'dl', issuer: 'Transport Department', at: Date.now(), file: false });
    if (scope.includes('PANCR')) docs.push({ id: rand(6), name: 'PAN Card', type: 'pan', issuer: 'Income Tax Department', at: Date.now(), file: false });
    console.log('[setu] aadhaar fields found: name=' + !!name + ' dob=' + !!dobRaw + ' last4=' + !!last4 + ' scope=' + scope.join(','));
    try { await setuCall('GET', '/api/digilocker/' + id + '/revoke'); } catch (e) {}      // we have what we need; do not keep access
    return { ok: true, dlid: name && dobRaw ? 'setu-' + sha(name.toLowerCase() + toISODate(dobRaw) + last4).slice(0, 24) : '', name, dob: toISODate(dobRaw), gender: g, last4, docs, consentUntil: Date.now() + 30 * 864e5 };
  }

  /* ---- mock DigiLocker pages (mirror the real screens: sign-in -> OTP -> consent) ---- */
  function mockLoginPage(state, msg) {
    const s = byState(state); if (!s) return expired().html;
    return page('DigiLocker (mock)', MOCKBAR + '<div class="card"><h1>Sign in to your account via DigiLocker</h1>' + (msg ? '<p style="color:#b3261e">' + esc(msg) + '</p>' : '') +
      '<form method="post" action="/api/digilocker/mock/login"><input type="hidden" name="state" value="' + esc(state) + '">' +
      '<label>Sign in with</label><select name="mode"><option>Mobile</option><option>Username</option><option>Other ID</option></select>' +
      '<label>Mobile number / username / ID</label><input type="text" name="uid" value="' + esc(s.phone) + '" autocomplete="off">' +
      '<div class="ck"><input type="checkbox" name="pinless" checked> PIN less authentication</div><div class="ck"><input type="checkbox" name="consent" checked> I consent to terms of use.</div>' +
      '<button class="b" type="submit">Sign In</button></form></div>');
  }
  function mockOtpPage(state, uid, msg) {
    return page('DigiLocker (mock)', MOCKBAR + '<div class="card"><h1>Verify OTP</h1><div class="w" style="background:#d9efe3">DigiLocker has sent you an OTP to your registered mobile (xxxxxx' + esc(String(uid).replace(/\D/g, '').slice(-4)) + '). OTP will be valid for 10 minutes. <b>Demo: any 6 digits work.</b></div>' +
      (msg ? '<p style="color:#b3261e">' + esc(msg) + '</p>' : '') + '<form method="post" action="/api/digilocker/mock/otp"><input type="hidden" name="state" value="' + esc(state) + '"><label>Enter OTP*</label><input type="password" name="otp" inputmode="numeric" maxlength="6" autocomplete="off">' +
      '<button class="b" type="submit">Sign In</button></form></div>');
  }
  const aadhaarMasked = s => { const d = String((s.mock && s.mock.uid) || '').replace(/\D/g, ''); return 'XX' + (d.length === 12 ? d.slice(-4) : String(parseInt(sha(s.phone + 'x').slice(0, 6), 16) % 10000).padStart(4, '0')); };
  function mockConsentPage(state) {
    const s = byState(state), until = new Date(Date.now() + 30 * 864e5);
    const f = n => String(n).padStart(2, '0'), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return page('DigiLocker (mock)', MOCKBAR + '<div class="card"><h1>Consent</h1><p>Please provide your consent to share the following with <b>LifeLink</b>:</p>' +
      '<form method="post" action="/api/digilocker/mock/consent"><input type="hidden" name="state" value="' + esc(state) + '">' +
      '<div class="d"><b>Issued Documents (' + MOCK_DOCS.length + ')</b></div>' +
      MOCK_DOCS.map((d, i) => '<label class="d" style="margin:0"><span>' + d[1] + (d[0] === 'aadhaar' ? ' ( ' + aadhaarMasked(s) + ' )' : ' <span class="m">(can be accessed)</span>') + '</span><input type="checkbox" name="doc" value="' + d[0] + '"' + (i === 0 ? ' checked' : '') + '></label>').join('') +
      '<div class="d"><span><b>Profile information</b><br><span class="m">Name, Date of Birth, Gender</span></span></div>' +
      '<div class="d"><span><b>Consent validity date</b> <span class="m">(Today + 30 days)</span><br>' + f(until.getDate()) + '-' + M[until.getMonth()] + '-' + until.getFullYear() + '</span></div>' +
      '<div class="d"><span><b>Purpose</b><br>' + esc(PURPOSE) + '</span></div>' +
      '<p class="m" style="font-size:12px">Consent validity is subject to applicable laws.</p>' +
      '<button class="b" type="submit" name="decision" value="allow">Allow</button><button class="b g" type="submit" name="decision" value="deny">Deny</button></form></div>');
  }
  function mockLogin(form) {
    const s = byState(form.state); if (!s) return expired();
    if (!String(form.uid || '').trim()) return { html: mockLoginPage(form.state, 'Enter your mobile number, username or ID.'), code: 200 };
    if (!form.consent) return { html: mockLoginPage(form.state, 'Please accept the terms of use to continue.'), code: 200 };
    s.mock = { uid: String(form.uid).trim() };
    return { html: mockOtpPage(form.state, form.uid), code: 200 };
  }
  function mockOtp(form) {
    const s = byState(form.state); if (!s || !s.mock) return expired();
    if (!/^\d{6}$/.test(String(form.otp || ''))) return { html: mockOtpPage(form.state, s.mock.uid, 'Enter the 6-digit OTP.'), code: 200 };
    s.mock.otpOk = true;
    return { html: mockConsentPage(form.state), code: 200 };
  }
  function mockConsent(form) {
    const s = byState(form.state);
    if (!s || !s.mock || !s.mock.otpOk) return { redirect: pub() + '/api/digilocker/callback?error=expired&state=' + encodeURIComponent(form.state || '') };
    if (form.decision !== 'allow') return { redirect: pub() + '/api/digilocker/callback?error=access_denied&state=' + encodeURIComponent(form.state) };
    s.mock.docs = [].concat(form.doc || []);
    return { redirect: pub() + '/api/digilocker/callback?code=mock&state=' + encodeURIComponent(form.state) };
  }

  /* ---- direct OAuth exchange ---- */
  async function dlFetch(url, opts) { const r = await fetch(url, opts); const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {} if (!r.ok) throw new Error('DigiLocker ' + r.status); return { j, t, r }; }
  async function exchangeLive(code, verifier, user) {
    const body = new URLSearchParams({ code, grant_type: 'authorization_code', client_id: ID, client_secret: SECRET, redirect_uri: pub() + '/api/digilocker/callback', code_verifier: verifier });
    const tok = (await dlFetch(URLS.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })).j;
    const auth = { headers: { Authorization: 'Bearer ' + tok.access_token } };
    let u = {}; try { u = (await dlFetch(URLS.user, auth)).j; } catch (e) {}
    const docs = [];
    try {
      const items = (await dlFetch(URLS.issued, auth)).j.items || [];
      for (const i of items) {
        const type = docType((i.doctype || '') + ' ' + (i.name || '') + ' ' + (i.uri || ''));
        if (type === 'other') continue;                       // data minimisation: keep only identity / donor documents
        const d = { id: rand(6), uri: i.uri, name: i.name || i.doctype, type, issuer: i.issuer || '', at: Date.now(), file: false };
        if (FETCH_FILES && type !== 'aadhaar' && i.uri) {      // never keep an Aadhaar copy; the others are stored for later manual verification
          try {
            const r = await fetch(URLS.file + '/' + encodeURIComponent(i.uri), auth);
            if (r.ok) { const dir = path.join(dataDir, 'docs', user.id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, d.id + '.bin'), Buffer.from(await r.arrayBuffer())); d.file = true; d.mime = r.headers.get('content-type') || 'application/pdf'; }
          } catch (e) {}
        }
        docs.push(d);
      }
    } catch (e) {}
    let last4 = '';
    try { const m = (await dlFetch(URLS.eaadhaar, auth)).t.match(/uid="[^"]*?(\d{4})"/); if (m) last4 = m[1]; } catch (e) {}
    return { ok: true, dlid: tok.digilockerid || u.digilockerid || '', name: tok.name || u.name || '', dob: toISODate(tok.dob || u.dob), gender: gender(tok.gender || u.gender), last4, docs, consentUntil: Date.now() + 30 * 864e5 };
  }
  function exchangeMock(s, user) {
    const uid = (s.mock && s.mock.uid) || 'demo', last4 = aadhaarMasked(s).slice(2);
    return {
      ok: true, dlid: 'mock-' + sha(uid).slice(0, 16), name: user.name || 'Demo User', dob: user.dob || '1995-01-01', gender: user.gender || 'M', last4, consentUntil: Date.now() + 30 * 864e5,
      docs: MOCK_DOCS.filter(d => (s.mock.docs || []).includes(d[0])).map(d => ({ id: rand(6), name: d[1], type: d[0], issuer: d[2], at: Date.now(), file: false }))
    };
  }

  /* ---- store the result on the user ---- */
  function apply(user, r) {
    // Aadhaar is mandatory: no Aadhaar document, no verification (a driving licence alone is never enough)
    if (!r.docs.some(d => d.type === 'aadhaar')) return { ok: false, error: 'aadhaar_required' };
    if (r.dlid) {
      const other = store.find('users', u => u.id !== user.id && u.dlHash === sha(r.dlid));
      if (other) return { ok: false, error: 'id_in_use' };
      user.dlHash = sha(r.dlid);
    }
    const mismatch = !r.name || !r.dob || !!(r.name && user.name && !nameMatches(r.name, user.name)) || !!(r.dob && user.dob && r.dob !== user.dob);
    user.verify = { status: 'verified', method: 'digilocker', at: Date.now(), name: r.name, dob: r.dob, gender: r.gender, last4: r.last4 || '', mismatch, consentUntil: r.consentUntil || 0, provider: PROVIDER, docs: r.docs.map(d => ({ name: d.name, type: d.type, issuer: d.issuer })) };
    user.documents = (user.documents || []).filter(d => !r.docs.some(n => n.type === d.type)).concat(r.docs);
    if (!user.dob && r.dob) user.dob = r.dob;
    if (!user.gender && r.gender) user.gender = r.gender;
    store.save();
    core.notify(user.id, 'verified', {}, {});
    return { ok: true, mismatch, docs: r.docs.length };
  }

  async function callback(q) {
    const s = byState(q.state);
    if (!s) return expired();
    const user = store.get('users', s.userId);
    let result;
    if (!user || ((PROVIDER === 'mock' || PROVIDER === 'oauth') && (!q.code || q.error))) result = { ok: false, error: q.error || 'denied' };
    else {
      try {
        const ex = PROVIDER === 'mock' ? exchangeMock(s, user) : PROVIDER === 'oauth' ? await exchangeLive(q.code, s.verifier, user)
          : PROVIDER === 'setu' ? await setuComplete(s, q, user) : await aggComplete(s, q, user);
        result = ex.ok ? apply(user, ex) : ex;
      } catch (e) { console.error('digilocker completion failed:', e.message); result = { ok: false, error: 'exchange_failed' }; }
    }
    s.result = result;
    if (s.platform === 'android') {
      const url = APP_RETURN + '?session=' + encodeURIComponent(s.id) + '&status=' + (result.ok ? 'ok' : 'error');
      return { html: page('Return to LifeLink', '<div class="card"><h1>' + (result.ok ? 'All set' : 'Verification did not complete') + '</h1><p>Return to the LifeLink app to continue.</p><a class="b" href="' + esc(url) + '">Open LifeLink</a></div><script>setTimeout(function(){location.href=' + JSON.stringify(url) + '},400)</script>'), code: 200 };
    }
    return { redirect: s.returnUrl + (s.returnUrl.includes('?') ? '&' : '?') + 'dl_session=' + encodeURIComponent(s.id) };
  }
  function result(user, id) {
    const s = sessions.get(id);
    if (!s || s.userId !== user.id) return null;
    if (!s.result) return { ok: false, pending: true };
    sessions.delete(id);
    return s.result;
  }
  return { start, mockLoginPage, mockLogin, mockOtp, mockConsent, callback, result, MOCK, PROVIDER, docType, IDENTITY };
};
module.exports.nameMatches = nameMatches;
module.exports.IDENTITY = IDENTITY;
module.exports.docType = docType;
module.exports.pick = pick;
