'use strict';
// A tiny JSON-file database: every collection lives in memory and is written to one file atomically.
// Fine for a pilot (thousands of users on one server). To move to Postgres/Mongo later, only this file's
// API (list/get/insert/patch/remove/find/save) needs a new implementation - see docs/BACKEND.md.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const newId = () => crypto.randomBytes(8).toString('hex');

class Store {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.timer = null;
    if (file) {                                // subclasses (MongoStore) pass no file and load their own data
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { this.data = {}; }
      process.on('exit', () => this.flush());
    }
  }
  async init() { return this; }
  async health() { return 'file'; }
  _c(name) { return this.data[name] || (this.data[name] = []); }
  list(name) { return this._c(name); }
  get(name, id) { return this._c(name).find(d => d.id === id) || null; }
  find(name, fn) { return this._c(name).find(fn) || null; }
  filter(name, fn) { return this._c(name).filter(fn); }
  insert(name, doc) { if (!doc.id) doc.id = newId(); this._c(name).push(doc); this.save(); return doc; }
  patch(name, id, patch) { const d = this.get(name, id); if (d) { Object.assign(d, patch); this.save(); } return d; }
  remove(name, id) { const c = this._c(name), i = c.findIndex(d => d.id === id); if (i >= 0) { c.splice(i, 1); this.save(); return true; } return false; }
  removeWhere(name, fn) { const c = this._c(name), n = c.length; this.data[name] = c.filter(d => !fn(d)); if (this.data[name].length !== n) this.save(); return n - this.data[name].length; }
  doc(name, def) { if (!this.data[name] || Array.isArray(this.data[name])) this.data[name] = Object.assign({}, def); return this.data[name]; }
  save() { if (this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 250); if (this.timer.unref) this.timer.unref(); }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = this.file + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(this.data)); fs.renameSync(tmp, this.file); } catch (e) { console.error('store flush failed:', e.message); }
  }
}
module.exports = { Store, newId };
