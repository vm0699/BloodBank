// Copy an existing JSON-file database (DATA_DIR/lifelink.json) into MongoDB:  node tools/migrate-to-mongo.js [--force]
// Refuses to run when MongoDB already has users, unless --force. Reads MONGO_URI from server/.env.
'use strict';
const fs = require('fs');
const path = require('path');
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env */ }
const { MongoStore } = require('../lib/mongostore');

(async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set (server/.env)');
  const file = path.join(path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')), 'lifelink.json');
  const src = JSON.parse(fs.readFileSync(file, 'utf8'));
  const store = await new MongoStore(process.env.MONGO_URI).init();
  if (store.list('users').length && !process.argv.includes('--force')) throw new Error('MongoDB already has ' + store.list('users').length + ' users. Use --force to merge anyway.');
  let n = 0;
  for (const [name, v] of Object.entries(src)) {
    if (Array.isArray(v)) { for (const d of v) { if (d && d.id && !store.get(name, d.id)) { store.insert(name, d); n++; } } }
    else store.data[name] = v;
  }
  await store.close();
  console.log('Migrated ' + n + ' records from ' + file + ' into MongoDB.');
})().catch(e => { console.error('Migration failed:', e.message); process.exit(1); });
