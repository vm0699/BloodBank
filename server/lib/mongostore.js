'use strict';
// MongoDB-backed store. Same synchronous API as lib/store.js, so the rest of the server does not change:
// every collection is loaded into memory at start-up (await store.init()), reads are served from memory,
// and every change is written to MongoDB shortly after (only the documents that actually changed).
// Single server process per database (the in-memory copy is the working set) - see docs/BACKEND.md.
const { Store } = require('./store');

const PREFIX = process.env.MONGO_COLLECTION_PREFIX || '';
// The database named in the connection string; "lifelink" when the string has none (the driver would otherwise use "test").
const dbNameFromUri = uri => { const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(String(uri || '')); return m ? decodeURIComponent(m[1]) : 'lifelink'; };
const DOCS = '_docs';                                  // singleton documents (config, counters...) live here as { _id: name, value }

class MongoStore extends Store {
  constructor(uri, opts) {
    super(null);
    this.uri = uri; this.dbName = (opts && opts.dbName) || ''; this.client = null; this.db = null;
    this.snap = new Map();                               // collection -> Map(id -> JSON string last written)
    this.docSnap = new Map();                            // singleton name -> JSON string last written
    this.writing = Promise.resolve();
    this.ready = false;
  }

  async init() {
    const { MongoClient } = require('mongodb');
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 10, appName: 'lifelink' });
    await this.client.connect();
    this.db = this.client.db(this.dbName || dbNameFromUri(this.uri));
    const existing = (await this.db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
    for (const full of existing) {
      if (full.startsWith('system.')) continue;
      const name = full.slice(PREFIX.length);
      if (PREFIX && !full.startsWith(PREFIX)) continue;
      const rows = await this.db.collection(full).find({}).toArray();
      if (name === DOCS) {
        for (const r of rows) { this.data[r._id] = r.value; this.docSnap.set(r._id, JSON.stringify(r.value)); }
        continue;
      }
      const m = new Map(), arr = [];
      for (const r of rows) { const d = Object.assign({}, r); delete d._id; d.id = d.id || String(r._id); arr.push(d); m.set(d.id, JSON.stringify(d)); }
      this.data[name] = arr; this.snap.set(name, m);
    }
    await this._indexes();
    this.ready = true;
    return this;
  }

  async _indexes() {
    const ix = (c, spec, o) => this.db.collection(PREFIX + c).createIndex(spec, o).catch(e => console.error('index ' + c + ':', e.message));
    await Promise.all([
      ix('users', { phone: 1 }), ix('users', { 'presence.seen': -1 }), ix('users', { city: 1, bg: 1 }),
      ix('requests', { status: 1, created: -1 }), ix('requests', { userId: 1 }),
      ix('donations', { userId: 1 }), ix('notifications', { userId: 1, t: -1 }),
      ix('audit', { t: -1 }), ix('otps', { exp: 1 }),
    ]);
  }

  /* persistence: diff memory against what was last written, write only the changes */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.db) return this.writing;
    this.writing = this.writing.then(() => this._persist()).catch(e => console.error('mongo flush failed:', e.message));
    return this.writing;
  }
  async _persist() {
    const ops = [];
    for (const name of Object.keys(this.data)) {
      const v = this.data[name], full = PREFIX + name;
      if (!Array.isArray(v)) {                           // singleton document
        const s = JSON.stringify(v);
        if (this.docSnap.get(name) !== s) { ops.push(this.db.collection(PREFIX + DOCS).replaceOne({ _id: name }, { _id: name, value: JSON.parse(s) }, { upsert: true }).then(() => this.docSnap.set(name, s))); }
        continue;
      }
      let m = this.snap.get(name); if (!m) { m = new Map(); this.snap.set(name, m); }
      const seen = new Set(), writes = [], changed = [];
      for (const d of v) {
        if (!d.id) continue;
        seen.add(d.id);
        const s = JSON.stringify(d);
        if (m.get(d.id) !== s) { writes.push({ replaceOne: { filter: { _id: d.id }, replacement: Object.assign({ _id: d.id }, JSON.parse(s)), upsert: true } }); changed.push([d.id, s]); }
      }
      const gone = [];
      for (const id of m.keys()) if (!seen.has(id)) gone.push(id);
      if (gone.length) writes.push({ deleteMany: { filter: { _id: { $in: gone } } } });
      if (writes.length) ops.push(this.db.collection(full).bulkWrite(writes, { ordered: false }).then(() => { changed.forEach(([id, s]) => m.set(id, s)); gone.forEach(id => m.delete(id)); }));
    }
    await Promise.all(ops);
  }

  async health() { await this.db.command({ ping: 1 }); return 'mongodb'; }

  async close() { await this.flush(); if (this.client) { await this.client.close(); this.client = null; } }
}
module.exports = { MongoStore, dbNameFromUri };
