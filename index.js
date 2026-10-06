/*
 * Plex Sync — IINA plugin
 * https://github.com/PyroDzeus/iina-plex-sync
 *
 * The "Plex to IINA" userscript (or Plex Sidekick) adds `psk_rk=<ratingKey>`
 * to the file URL it sends to IINA when Plex tracking is switched on. This plugin only wakes up for those
 * links: it reports playing / paused / stopped and the position to the Plex
 * server (so Plex keeps the resume point and "Continue Watching"), resumes
 * where Plex left off, and marks the item as watched past the threshold.
 *
 * Without `psk_rk` in the URL (tracking off, or any other file), the plugin
 * does nothing at all and sends nothing to Plex.
 */

const { core, mpv, event, http, console, preferences } = iina;

const VERSION = '1.0.0';
const TAG = '[Plex Sync]';

let session = null;     // the item currently tracked, or null
let ticker = null;

/* ---------- small helpers ---------- */

function pref(key, fallback) {
  const v = preferences.get(key);
  return v === undefined || v === null || v === '' ? fallback : v;
}

function osd(msg) {
  if (pref('osd', true)) core.osd(msg);
}

function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const two = n => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

// A stable ID so Plex sees one "IINA" device, not a new one per file.
function clientId() {
  let id = preferences.get('clientId');
  if (!id) {
    id = 'iina-plex-sync-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    preferences.set('clientId', id);
  }
  return id;
}

/** Reads server, token and ratingKey out of the URL Plex Sidekick sent. */
function parseUrl(url) {
  if (!url) return null;
  const m = /^(https?:\/\/[^/?#]+)[^?#]*\?([^#]*)/i.exec(url);
  if (!m) return null;
  const q = {};
  for (const pair of m[2].split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    try { q[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1)); } catch (e) {}
  }
  const rk = q.psk_rk;
  const token = q['X-Plex-Token'];
  if (!rk || !/^\d+$/.test(rk) || !token) return null;
  return { origin: m[1], token, rk };
}

function headers(s) {
  return {
    'Accept': 'application/json',
    'X-Plex-Token': s.token,
    'X-Plex-Client-Identifier': clientId(),
    'X-Plex-Product': 'IINA',
    'X-Plex-Version': VERSION,
    'X-Plex-Platform': 'macOS',
    'X-Plex-Device': 'Mac',
    'X-Plex-Device-Name': 'IINA',
  };
}

// IINA only accepts string values for query parameters.
function strParams(obj) {
  const out = {};
  for (const k in obj) out[k] = String(obj[k]);
  return out;
}

async function plexGet(s, path, params) {
  try {
    const res = await http.get(s.origin + path, { headers: headers(s), params: strParams(params || {}) });
    return res && res.data;
  } catch (res) {
    console.log(`${TAG} ${path} failed: ${res && (res.statusCode || res.reason)}`);
    return null;
  }
}

async function fetchMeta(s) {
  const data = await plexGet(s, `/library/metadata/${s.rk}`);
  const list = data && data.MediaContainer && data.MediaContainer.Metadata;
  return list && list[0] ? list[0] : null;
}

/* ---------- reporting ---------- */

function currentPos() {
  const p = core.status.position;
  return typeof p === 'number' && isFinite(p) ? p : null;
}

function sendTimeline(s, state) {
  if (!s.durationMs) return;
  const timeMs = Math.min(Math.round(s.lastPos * 1000), s.durationMs);
  s.lastSent = Date.now();
  plexGet(s, '/:/timeline', {
    ratingKey: s.rk,
    key: `/library/metadata/${s.rk}`,
    state,
    time: timeMs,
    duration: s.durationMs,
  });
}

async function markWatched(s) {
  if (s.watched) return;
  s.watched = true;
  // Plex often marks the item itself from the timeline: check first, so the
  // view count isn't bumped twice.
  const meta = await fetchMeta(s);
  const already = meta && (meta.viewCount || 0) > s.viewCount0;
  if (!already) await plexGet(s, '/:/scrobble', { identifier: 'com.plexapp.plugins.library', key: s.rk });
  osd('Plex: marked as watched ✓');
  console.log(`${TAG} ${s.label} marked as watched${already ? ' (by Plex)' : ''}`);
}

function checkThreshold(s) {
  if (s.watchQueued || !s.durationMs) return;
  const pct = Number(pref('threshold', 90)) / 100;
  if (s.lastPos * 1000 >= s.durationMs * pct) {
    s.watchQueued = true;
    // Report the position right away so Plex can mark it itself, then check
    // a few seconds later and only scrobble if Plex didn't.
    if (session === s) sendTimeline(s, core.status.paused ? 'paused' : 'playing');
    setTimeout(() => markWatched(s), 4000);
  }
}

function tick() {
  const s = session;
  if (!s || !s.ready) return;
  const p = currentPos();
  if (p !== null) s.lastPos = p;
  const every = Math.max(5, Number(pref('interval', 10))) * 1000;
  if (Date.now() - s.lastSent >= every) sendTimeline(s, core.status.paused ? 'paused' : 'playing');
  checkThreshold(s);
}

/* ---------- session lifecycle ---------- */

function stopSession() {
  const s = session;
  if (!s) return;
  session = null;
  if (!s.ready) return;
  const p = currentPos();
  if (p !== null && p > 0) s.lastPos = p;
  checkThreshold(s);
  sendTimeline(s, 'stopped');
  console.log(`${TAG} stopped ${s.label} at ${clock(s.lastPos)}`);
}

async function startSession() {
  stopSession();
  const info = parseUrl(mpv.getString('path')) || parseUrl(core.status.url);
  if (!info) return;                       // not a tracked Plex link: stay silent

  const s = Object.assign(info, {
    ready: false, lastPos: 0, lastSent: 0, durationMs: 0,
    viewCount0: 0, watched: false, watchQueued: false, label: `#${info.rk}`,
  });
  session = s;

  const meta = await fetchMeta(s);
  if (session !== s) return;               // another file was opened meanwhile
  if (!meta) { osd('Plex: server unreachable, not tracking'); session = null; return; }

  s.durationMs = Number(meta.duration) || Math.round((core.status.duration || 0) * 1000);
  s.viewCount0 = Number(meta.viewCount) || 0;
  s.label = meta.type === 'episode'
    ? `${meta.grandparentTitle} S${String(meta.parentIndex).padStart(2, '0')}E${String(meta.index).padStart(2, '0')}`
    : meta.title;

  const offset = Number(meta.viewOffset) || 0;
  if (pref('resume', true) && offset > 30000 && offset < s.durationMs * 0.95) {
    mpv.command('seek', [String(offset / 1000), 'absolute']);
    s.lastPos = offset / 1000;
    osd(`Plex: resuming at ${clock(offset / 1000)}`);
  } else {
    s.lastPos = currentPos() || 0;
    osd('Plex: tracking on');
  }
  s.ready = true;
  sendTimeline(s, core.status.paused ? 'paused' : 'playing');
  console.log(`${TAG} tracking ${s.label}`);
}

event.on('iina.file-loaded', () => { startSession(); });
event.on('mpv.pause.changed', () => {
  const s = session;
  if (!s || !s.ready) return;
  const p = currentPos();
  if (p !== null) s.lastPos = p;
  sendTimeline(s, core.status.paused ? 'paused' : 'playing');
});
event.on('mpv.end-file', () => { stopSession(); });
event.on('iina.window-will-close', () => { stopSession(); });

ticker = setInterval(tick, 1000);
