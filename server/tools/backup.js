// Full logical backup of the LifeLink database to a compressed JSON file:  node tools/backup.js
//   writes server/backups/lifelink-YYYYMMDD-HHMM.json.gz, keeps the newest BACKUP_KEEP (default 14).
// Works with MongoDB (MONGO_URI) or the JSON-file store. Restore: node tools/restore.js <file> (see docs/BACKEND.md).
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
  let data;
  if (process.env.MONGO_URI) {
    const s = await new (require('../lib/mongostore').MongoStore)(process.env.MONGO_URI).init();
    data = s.data; await s.client.close();
  } else {
    const f = path.join(path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')), 'lifelink.json');
    data = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  const dir = path.join(__dirname, '..', 'backups'); fs.mkdirSync(dir, { recursive: true });
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const file = path.join(dir, 'lifelink-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.json.gz');
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ at: d.toISOString(), data })));
  const keep = +process.env.BACKUP_KEEP || 14;
  fs.readdirSync(dir).filter(f => /^lifelink-.*\.json\.gz$/.test(f)).sort().reverse().slice(keep).forEach(f => fs.unlinkSync(path.join(dir, f)));
  const counts = Object.entries(data).map(([k, v]) => k + ':' + (Array.isArray(v) ? v.length : 'doc')).join(' ');
  console.log('Backup written: ' + file + '\n  ' + counts);
})().catch(e => { console.error('Backup failed:', e.message); process.exit(1); });
