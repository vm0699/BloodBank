// One-time setup of LifeLink's dedicated MongoDB:  node mongo/setup-db.js
// Creates two logins on the LifeLink-only database server (never touches any other MongoDB):
//   lifelink_dbadmin  manages users (password kept in mongo/dbadmin.secret, git-ignored)
//   lifelink_app      read/write on database "lifelink" only (its URI is written to server/.env as MONGO_URI)
// Passwords are random and are never printed.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const HOST = process.env.LIFELINK_DB_HOST || '127.0.0.1:27418', DB = 'lifelink';
const envFile = path.join(__dirname, '..', '.env'), secretFile = path.join(__dirname, 'dbadmin.secret');
const rnd = () => crypto.randomBytes(24).toString('base64url');
const uri = (u, p, db) => 'mongodb://' + encodeURIComponent(u) + ':' + encodeURIComponent(p) + '@' + HOST + '/' + (db || 'admin') + (db === DB ? '?authSource=' + DB : '?authSource=admin');

async function main() {
  const envText = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  if (/^MONGO_URI=.+/m.test(envText)) { console.log('MONGO_URI already set in server/.env - nothing to do.'); return; }

  let adminPw;
  const open = new MongoClient('mongodb://' + HOST + '/admin', { serverSelectionTimeoutMS: 4000 });
  try {
    await open.connect();
    adminPw = rnd();
    await open.db('admin').command({ createUser: 'lifelink_dbadmin', pwd: adminPw, roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }] });
    fs.writeFileSync(secretFile, adminPw);
  } catch (e) {
    if (!fs.existsSync(secretFile)) throw new Error('Could not create the first database user (' + e.message + '). If this database already has users, put the app URI in server/.env as MONGO_URI.');
    adminPw = fs.readFileSync(secretFile, 'utf8').trim();
  } finally { await open.close().catch(() => {}); }

  const admin = new MongoClient(uri('lifelink_dbadmin', adminPw), { serverSelectionTimeoutMS: 4000 });
  await admin.connect();
  const appPw = rnd();
  try { await admin.db(DB).command({ dropUser: 'lifelink_app' }); } catch (e) { /* not there yet */ }
  await admin.db(DB).command({ createUser: 'lifelink_app', pwd: appPw, roles: [{ role: 'readWrite', db: DB }] });
  await admin.close();

  const line = 'MONGO_URI=' + uri('lifelink_app', appPw, DB);
  fs.writeFileSync(envFile, envText.replace(/\s*$/, '\n') + '\n# LifeLink-only MongoDB (own server on port 27418, own data folder: server/mongo/data)\n' + line + '\n');
  console.log('Done. Created logins lifelink_dbadmin and lifelink_app. MONGO_URI saved to server/.env (not printed).');
}
main().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
