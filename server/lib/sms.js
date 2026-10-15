'use strict';
// OTP delivery. Choose with SMS_PROVIDER:
//
//   console        prints the code in the server log (development)
//   twilio_verify  Twilio Verify (recommended): Twilio generates, sends and checks the code.
//                  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SID (starts with VA)
//   twilio         plain Twilio SMS: we generate the code and send it as a message.
//                  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM (number / sender ID) or TWILIO_MESSAGING_SERVICE_SID
//   msg91          MSG91 OTP API: MSG91_AUTHKEY, MSG91_TEMPLATE_ID
//
// India: carriers only deliver SMS whose sender ID and template are registered on the DLT portal (TRAI). That registration
// is done with Twilio / MSG91 and is the slow part (days). TWILIO_EXTRA_PARAMS (JSON) is merged into the Twilio request
// for anything their India setup asks for (e.g. a ContentSid or template fields).
const env = process.env;
const provider = () => String(env.SMS_PROVIDER || 'console').toLowerCase();
const verifyMode = () => provider() === 'twilio_verify';

const sid = () => env.TWILIO_ACCOUNT_SID || env.TWILIO_SID || '';
const token = () => env.TWILIO_AUTH_TOKEN || env.TWILIO_TOKEN || '';
const basic = () => 'Basic ' + Buffer.from(sid() + ':' + token()).toString('base64');
const extra = () => { try { return JSON.parse(env.TWILIO_EXTRA_PARAMS || '{}'); } catch (e) { return {}; } };
const apiBase = () => (env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');
const verifyBase = () => (env.TWILIO_VERIFY_BASE || 'https://verify.twilio.com').replace(/\/$/, '');

async function twilioForm(url, fields) {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: basic(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.assign({}, fields, extra())) });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok) { const err = new Error('twilio ' + r.status + ' ' + (j.message || t.slice(0, 200))); err.status = r.status; err.code = j.code; throw err; }
  return j;
}

/** Twilio Verify: ask Twilio to text a code to this number. */
async function startVerify(phone) {
  await twilioForm(verifyBase() + '/v2/Services/' + env.TWILIO_VERIFY_SID + '/Verifications', { To: phone, Channel: 'sms' });
}
/** Twilio Verify: true if the code is the one Twilio sent. */
async function checkVerify(phone, code) {
  try {
    const j = await twilioForm(verifyBase() + '/v2/Services/' + env.TWILIO_VERIFY_SID + '/VerificationCheck', { To: phone, Code: code });
    return j.status === 'approved';
  } catch (e) {
    if (e.status === 404) return false;            // no pending verification (expired / already used)
    throw e;
  }
}

/** Providers where we generate the code ourselves. */
async function sendOtp(phone, otp) {
  const p = provider();
  const text = otp + ' is your LifeLink verification code. It expires in 5 minutes. Do not share it with anyone.';
  if (p === 'twilio') {
    const f = { To: phone, Body: text };
    if (env.TWILIO_MESSAGING_SERVICE_SID) f.MessagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID; else f.From = env.TWILIO_FROM;
    await twilioForm(apiBase() + '/2010-04-01/Accounts/' + sid() + '/Messages.json', f);
    return;
  }
  if (p === 'msg91') {
    const u = 'https://control.msg91.com/api/v5/otp?' + new URLSearchParams({ template_id: env.MSG91_TEMPLATE_ID, mobile: phone.replace('+', ''), authkey: env.MSG91_AUTHKEY, otp });
    const r = await fetch(u, { method: 'POST' });
    if (!r.ok) throw new Error('msg91 ' + r.status);
    return;
  }
  console.log('[sms:console] OTP for ' + phone + ': ' + otp);
}
/** Startup check: what is missing for the chosen provider ('' = fine). */
function missing() {
  const p = provider();
  if (p === 'twilio_verify') return [!sid() && 'TWILIO_ACCOUNT_SID', !token() && 'TWILIO_AUTH_TOKEN', !env.TWILIO_VERIFY_SID && 'TWILIO_VERIFY_SID'].filter(Boolean).join(', ');
  if (p === 'twilio') return [!sid() && 'TWILIO_ACCOUNT_SID', !token() && 'TWILIO_AUTH_TOKEN', !(env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID) && 'TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID'].filter(Boolean).join(', ');
  if (p === 'msg91') return [!env.MSG91_AUTHKEY && 'MSG91_AUTHKEY', !env.MSG91_TEMPLATE_ID && 'MSG91_TEMPLATE_ID'].filter(Boolean).join(', ');
  return '';
}
module.exports = { sendOtp, provider, verifyMode, startVerify, checkVerify, missing };
