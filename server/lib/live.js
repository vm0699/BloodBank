'use strict';
// Real-time hub (server-sent events). Signed-in apps keep one stream open to /api/live; the server pushes small
// events the moment something changes, so the donor map moves live instead of waiting for the next poll:
//   donor  {id,name,bg,lat,lng,seen,...}  a donor moved / came online (position is already jittered, never exact)
//   gone   {id}                           a donor went offline or was removed
//   feed                                   a new blood request appeared near you  -> app re-syncs
//   notice                                 you have a new notification            -> app re-syncs
// A single process holds the connections (same one-process-per-database rule as the store).
const { hav } = require('./geo');

const clients = new Set();                       // { res, uid, lat, lng }
const MAX_PER_USER = 3;
const NEAR_KM = 60;

function write(c, event, data) {
  if (c.res.writableEnded || c.res.destroyed) { clients.delete(c); return; }
  if (c.res.writableNeedDrain) return;           // slow client: drop this event, the periodic sync catches up
  try { c.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data || {}) + '\n\n'); } catch (e) { clients.delete(c); }
}

function add(req, res, uid, lat, lng) {
  const mine = [...clients].filter(c => c.uid === uid);
  while (mine.length >= MAX_PER_USER) { const old = mine.shift(); try { old.res.end(); } catch (e) { /* closed */ } clients.delete(old); }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': res.getHeader('Access-Control-Allow-Origin') || '', 'Vary': 'Origin' });
  const c = { res, uid, lat: Number.isFinite(lat) ? lat : null, lng: Number.isFinite(lng) ? lng : null };
  clients.add(c);
  res.write('retry: 3000\n\n');
  write(c, 'hello', { t: Date.now() });
  req.on('close', () => clients.delete(c));
  return c;
}

function setPos(uid, lat, lng) { clients.forEach(c => { if (c.uid === uid) { c.lat = lat; c.lng = lng; } }); }
function near(c, lat, lng, km) { return c.lat == null || hav(c.lat, c.lng, lat, lng) <= km; }

function emitNear(lat, lng, event, data, exceptUid, km) { clients.forEach(c => { if (c.uid !== exceptUid && near(c, lat, lng, km || NEAR_KM)) write(c, event, data); }); }
function emitUser(uid, event, data) { clients.forEach(c => { if (c.uid === uid) write(c, event, data); }); }
function emitAll(event, data) { clients.forEach(c => write(c, event, data)); }
const count = () => clients.size;

const beat = setInterval(() => clients.forEach(c => { if (c.res.writableEnded || c.res.destroyed) clients.delete(c); else { try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(c); } } }), 20e3);
beat.unref();

function closeAll() { clients.forEach(c => { try { c.res.end(); } catch (e) { /* closed */ } }); clients.clear(); }

module.exports = { add, setPos, emitNear, emitUser, emitAll, count, closeAll };
