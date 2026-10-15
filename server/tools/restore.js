// Restore a backup made by tools/backup.js into MongoDB:  node tools/restore.js backups/lifelink-....json.gz [--yes]
// Replaces every collection with the backup's contents. Refuses to run without --yes.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
try {
  fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach(l => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
} catch (e) { /* no .env */ }

(async () => {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node tools/restore.js <backup.json.gz> --yes');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set');
  if (!process.argv.includes('--yes')) throw new Error('This REPLACES all current data. Re-run with --yes to confirm.');
  const { data } = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  const s = await new (require('../lib/mongostore').MongoStore)(process.env.MONGO_URI).init();
  Object.keys(s.data).forEach(k => { if (!(k in data)) delete s.data[k]; });   // collections absent from the backup are emptied
  Object.assign(s.data, data);
  await s.close();
  console.log('Restored: ' + Object.entries(data).map(([k, v]) => k + ':' + (Array.isArray(v) ? v.length : 'doc')).join(' '));
})().catch(e => { console.error('Restore failed:', e.message); process.exit(1); });
