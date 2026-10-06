// ==UserScript==
// @name         Plex to IINA ▶
// @namespace    pyro.plex.iina
// @version      1.0.0
// @description  Play any film or episode from Plex Web in IINA (macOS): the original file, no transcoding. An eye switch on the button decides whether Plex records what you watch (progress, resume point, watched), with the Plex Sync plugin for IINA.
// @author       Pyro
// @license      MIT
// @homepageURL  https://github.com/PyroDzeus/iina-plex-sync
// @match        https://app.plex.tv/*
// @match        http://*/web/*
// @match        https://*/web/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      plex.direct
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @icon         https://watch.plex.tv/icons/favicon.ico
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/PyroDzeus/iina-plex-sync/main/plex-to-iina.user.js
// @updateURL    https://raw.githubusercontent.com/PyroDzeus/iina-plex-sync/main/plex-to-iina.user.js
// ==/UserScript==

/*
 * A stripped-down, IINA-only version of Plex Sidekick
 * (https://github.com/PyroDzeus/userscripts), which also links to 20+ film
 * sites and supports other players.
 *
 * How tracking works: with the eye on, the Plex ID of the item (`psk_rk=…`)
 * is added to the file link sent to IINA. Plex ignores it; the Plex Sync
 * plugin for IINA reads it and reports playback to your server. With the eye
 * off, the link carries nothing extra and the plugin stays silent.
 */

(function () {
  'use strict';

  const ROOT_ID = 'p2i-root';
  const STORE = 'p2iSettings';

  let settings = { track: true };
  try { Object.assign(settings, JSON.parse(GM_getValue(STORE, '{}'))); } catch (e) {}
  const save = () => GM_setValue(STORE, JSON.stringify(settings));

  /* ============================================================
     Which item, which server
     ============================================================ */
  function getRatingKey() {
    const m = location.hash.match(/key=([^&]+)/);
    if (!m) return null;
    const km = decodeURIComponent(m[1]).match(/\/library\/metadata\/(\d+)/);
    return km ? km[1] : null;
  }

  const PLEX_TV = /(^|\.)plex\.tv$/i;
  const badServers = new Set();
  let serverInfo = null;

  /* Every address + token pair the page uses for your library (posters,
     artwork…), newest first. plex.tv is skipped: it's Plex's metadata
     service, not your server. */
  function serverList() {
    const urls = [];
    document.querySelectorAll('img[src*="X-Plex-Token"]').forEach(i => urls.push(i.src));
    document.querySelectorAll('[style*="X-Plex-Token"]').forEach(el => {
      const m = (el.getAttribute('style') || '').match(/url\(["']?(.*?X-Plex-Token=.*?)["']?\)/);
      if (m) urls.push(m[1]);
    });
    try {
      performance.getEntriesByType('resource').forEach(e => {
        if (e.name.includes('X-Plex-Token') && /\/(library|photo|video)\//.test(e.name)) urls.push(e.name);
      });
    } catch (e) {}
    const out = [], seen = new Set();
    for (const u of urls.reverse()) {
      try {
        const url = new URL(u, location.href);
        const token = url.searchParams.get('X-Plex-Token');
        if (!token || PLEX_TV.test(url.hostname)) continue;
        const k = url.origin + '|' + token;
        if (seen.has(k) || badServers.has(k)) continue;
        seen.add(k);
        out.push({ origin: url.origin, token });
      } catch (e) {}
    }
    // Plex Web served by the server itself (…:32400/web): its own address is
    // the most direct way in, so try it first.
    const servedByPlex = location.port === '32400' || /^\/web(\/|$)/.test(location.pathname);
    if (servedByPlex && out.length && !out.some(s => s.origin === location.origin)) {
      const here = { origin: location.origin, token: out[0].token };
      if (!badServers.has(here.origin + '|' + here.token)) out.unshift(here);
    }
    return out;
  }

  function getServer() {
    if (!serverInfo) serverInfo = serverList()[0] || null;
    return serverInfo;
  }
  function dropServer() {
    if (serverInfo) badServers.add(serverInfo.origin + '|' + serverInfo.token);
    serverInfo = null;
    return !!getServer();
  }

  function fetchXml(srv, path, cb) {
    let done = false;
    const once = doc => { if (!done) { done = true; cb(doc); } };
    GM_xmlhttpRequest({
      method: 'GET',
      url: `${srv.origin}${path}?X-Plex-Token=${srv.token}`,
      headers: { Accept: 'application/xml' },
      timeout: 8000,
      onload: res => {
        if (res.status && (res.status < 200 || res.status >= 300)) return once(null);
        try { once(new DOMParser().parseFromString(res.responseText, 'text/xml')); } catch (e) { once(null); }
      },
      onerror: () => once(null),
      ontimeout: () => once(null),
    });
    setTimeout(() => once(null), 10000);
  }

  /* ============================================================
     The item and its files (a film can have 4K + 1080p versions)
     ============================================================ */
  const kids = (el, tag) => [...el.children].filter(c => c.tagName === tag);
  const resLabel = r => (r === '4k' ? '4K' : /^\d+$/.test(r) ? r + 'p' : (r || '').toUpperCase());
  const size = b => (b ? (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB') : '');

  function parseItem(doc) {
    const el = doc && doc.querySelector('MediaContainer > Video');
    if (!el) return null;
    const type = el.getAttribute('type');
    if (type !== 'movie' && type !== 'episode') return null;
    const versions = [];
    kids(el, 'Media').forEach(m => {
      const parts = kids(m, 'Part');
      parts.forEach((p, i) => {
        const audio = kids(p, 'Stream').find(s => s.getAttribute('streamType') === '2' && s.getAttribute('selected') === '1')
          || kids(p, 'Stream').find(s => s.getAttribute('streamType') === '2');
        const res = resLabel((m.getAttribute('videoResolution') || '').toLowerCase());
        const codec = (m.getAttribute('videoCodec') || '').toUpperCase();
        versions.push({
          partKey: p.getAttribute('key'),
          short: res || codec || 'File',
          label: [res, codec, m.getAttribute('editionTitle') || '', parts.length > 1 ? `part ${i + 1}/${parts.length}` : '']
            .filter(Boolean).join(' · '),
          sub: [size(+p.getAttribute('size')), m.getAttribute('bitrate') ? (m.getAttribute('bitrate') / 1000).toFixed(1) + ' Mb/s' : '',
            audio ? audio.getAttribute('displayTitle') : ''].filter(Boolean).join(' · '),
          file: (p.getAttribute('file') || '').split(/[\\/]/).pop(),
          score: (+m.getAttribute('width') || 0) * (+m.getAttribute('height') || 0) * 1e6 + (+m.getAttribute('bitrate') || 0),
        });
      });
    });
    if (!versions.length) return null;
    versions.sort((a, b) => b.score - a.score);       // best quality first: that's what ▶ plays
    return { ratingKey: el.getAttribute('ratingKey'), versions };
  }

  /* ============================================================
     Opening IINA
     ============================================================ */
  function iinaLink(item, version) {
    const srv = getServer();
    let direct = `${srv.origin}${version.partKey}?X-Plex-Token=${srv.token}`;
    if (settings.track) direct += `&psk_rk=${item.ratingKey}`;
    return 'iina://weblink?url=' + encodeURIComponent(direct);
  }

  // A throwaway iframe opens the app without leaving or reloading Plex.
  function openLink(href) {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    f.src = href;
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 1500);
  }

  /* ============================================================
     UI
     ============================================================ */
  const SVGNS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    play: 'M8 5.14v13.72a1 1 0 0 0 1.53.85l10.8-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z',
    // Material "visibility" / "visibility_off" (Apache 2.0): Plex sees / doesn't see.
    eyeOn: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
    eyeOff: 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z',
  };
  function icon(name) {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', ICONS[name]);
    p.setAttribute('fill', 'currentColor');
    svg.appendChild(p);
    return svg;
  }

  const style = document.createElement('style');
  style.textContent = `
    #${ROOT_ID} {
      position: fixed; top: 90px; right: 18px; z-index: 99999; display: flex; height: 36px;
      font: 700 13px -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif;
      border-radius: 10px; overflow: hidden; box-shadow: 0 4px 16px rgba(0,0,0,.45);
      background: rgba(22,24,30,.72); border: 1px solid rgba(255,255,255,.14);
      backdrop-filter: blur(14px) saturate(1.6); -webkit-backdrop-filter: blur(14px) saturate(1.6);
      animation: p2i-in .25s ease backwards;
    }
    @keyframes p2i-in { from { opacity: 0; transform: translateX(14px); } to { opacity: 1; transform: none; } }
    #${ROOT_ID} button {
      all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
      gap: 8px; height: 100%; cursor: pointer; color: #f2f2f2; transition: background .15s ease, color .15s ease;
    }
    #${ROOT_ID} button:hover { background: rgba(255,255,255,.1); }
    #${ROOT_ID} button:focus-visible { outline: 2px solid #e5a00d; outline-offset: -2px; }
    #${ROOT_ID} button + button { border-left: 1px solid rgba(255,255,255,.12); }
    #${ROOT_ID} svg { width: 16px; height: 16px; flex: 0 0 auto; }
    #${ROOT_ID} .p2i-play { padding: 0 14px 0 12px; }
    #${ROOT_ID} .p2i-play small { font-weight: 600; opacity: .6; }
    #${ROOT_ID} .p2i-eye, #${ROOT_ID} .p2i-more { width: 36px; }
    #${ROOT_ID} .p2i-eye { color: rgba(255,255,255,.45); }
    #${ROOT_ID} .p2i-eye.on { color: #e5a00d; }
    #${ROOT_ID}.off .p2i-play { opacity: .45; cursor: default; }
    #${ROOT_ID}.off .p2i-play:hover { background: none; }

    .p2i-menu {
      position: fixed; z-index: 2147483000; min-width: 250px; max-width: 360px; padding: 6px;
      background: #16181d; border: 1px solid #34363c; border-radius: 10px;
      box-shadow: 0 12px 34px rgba(0,0,0,.6); font: 12px -apple-system, Helvetica, Arial, sans-serif;
    }
    .p2i-menu-h { padding: 5px 8px 7px; color: #9aa0aa; font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    .p2i-menu button {
      all: unset; box-sizing: border-box; display: block; width: 100%; cursor: pointer;
      padding: 7px 9px; border-radius: 7px; color: #eee; line-height: 1.35;
    }
    .p2i-menu button:hover, .p2i-menu button:focus-visible { background: #262a33; }
    .p2i-menu b { display: block; font-size: 12.5px; }
    .p2i-menu span { display: block; color: #8b919b; font-size: 11px; }
  `;
  document.head.appendChild(style);

  let menu = null;
  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
    document.removeEventListener('mousedown', onOutside, true);
  }
  function onOutside(e) { if (menu && !menu.contains(e.target) && !e.target.closest('.p2i-more')) closeMenu(); }

  function openMenu(anchor, item) {
    if (menu) return closeMenu();
    menu = document.createElement('div');
    menu.className = 'p2i-menu';
    menu.dataset.pyroIgnore = '';
    const h = document.createElement('div');
    h.className = 'p2i-menu-h';
    h.textContent = 'Play in IINA';
    menu.appendChild(h);
    item.versions.forEach(v => {
      const b = document.createElement('button');
      const t = document.createElement('b'); t.textContent = v.label || v.short;
      const s = document.createElement('span'); s.textContent = v.sub || v.file;
      b.title = v.file;
      b.append(t, s);
      b.addEventListener('click', () => { closeMenu(); openLink(iinaLink(item, v)); });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.right = Math.max(8, innerWidth - r.right) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onOutside, true));
  }

  function removeUI() {
    closeMenu();
    const r = document.getElementById(ROOT_ID);
    if (r) r.remove();
  }

  /** item: null while loading, false if Plex didn't answer */
  function render(item) {
    closeMenu();
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.dataset.pyroIgnore = '';
      document.body.appendChild(root);
    }
    root.innerHTML = '';
    root.classList.toggle('off', !item);

    const play = document.createElement('button');
    play.className = 'p2i-play';
    play.append(icon('play'), document.createTextNode('IINA'));
    if (item && item.versions.length > 1) {
      const s = document.createElement('small');
      s.textContent = item.versions[0].short;
      play.appendChild(s);
    }
    play.title = item === false ? 'Plex did not answer — click to retry'
      : !item ? 'Loading…'
      : `Play in IINA${item.versions.length > 1 ? ' — ' + item.versions[0].label : ''}`
        + (settings.track ? ' · Plex tracking on' : ' · no Plex tracking');
    play.addEventListener('click', () => {
      if (item) openLink(iinaLink(item, item.versions[0]));
      else if (item === false) { lastKey = null; badServers.clear(); serverInfo = null; update(); }
    });
    root.appendChild(play);

    const eye = document.createElement('button');
    eye.className = 'p2i-eye' + (settings.track ? ' on' : '');
    eye.setAttribute('aria-pressed', String(settings.track));
    eye.setAttribute('aria-label', 'Plex tracking');
    eye.appendChild(icon(settings.track ? 'eyeOn' : 'eyeOff'));
    eye.title = settings.track
      ? 'Plex tracking on: Plex records what IINA plays (progress, resume point, watched).\nClick to play without recording anything.\nNeeds the Plex Sync plugin for IINA.'
      : 'Plex tracking off: IINA plays without telling Plex anything.\nClick to turn tracking on.';
    eye.addEventListener('click', () => { settings.track = !settings.track; save(); render(item); });
    root.appendChild(eye);

    if (item && item.versions.length > 1) {
      const more = document.createElement('button');
      more.className = 'p2i-more';
      more.textContent = '▾';
      more.title = `Choose a version (${item.versions.length})`;
      more.addEventListener('click', () => openMenu(more, item));
      root.appendChild(more);
    }
    root.style.display = isWatching() ? 'none' : 'flex';
  }

  // Hidden while Plex's own player is up.
  function isWatching() {
    if (document.fullscreenElement) return true;
    const v = document.querySelector('video');
    return !!v && v.getBoundingClientRect().width > innerWidth * 0.5;
  }
  setInterval(() => {
    const r = document.getElementById(ROOT_ID);
    if (r) r.style.display = isWatching() ? 'none' : 'flex';
  }, 700);

  /* ============================================================
     Page changes
     ============================================================ */
  const cache = {};
  let lastKey = null;

  function update(tries = 0) {
    const key = getRatingKey();
    if (!key) { removeUI(); lastKey = null; return; }
    if (key === lastKey) return;
    const srv = getServer();
    if (!srv && tries < 12) { setTimeout(() => update(tries + 1), 400); return; }
    lastKey = key;
    if (key in cache) { cache[key] ? render(cache[key]) : removeUI(); return; }
    if (!srv) return render(false);

    render(null);
    fetchXml(srv, `/library/metadata/${key}`, doc => {
      if (getRatingKey() !== key) return;
      if (!doc) {                                   // that address didn't answer: try the next one
        if (dropServer()) { lastKey = null; update(); } else render(false);
        return;
      }
      const item = parseItem(doc);                  // null = a show, a season, music…: no button
      cache[key] = item;
      item ? render(item) : removeUI();
    });
  }

  window.addEventListener('hashchange', () => update());
  new MutationObserver(() => update()).observe(document.body, { childList: true, subtree: true });
  update();
})();
