// VTTRPG – minimal connection test on Trystero (two files: index.html + app.js)
// DM = host in the browser. Players join via link / QR code and chat. Everything is logged.

const APP_VERSION = '0.7.0';
const TRYSTERO_VERSION = '0.26.0';               // pinned: the API changed a lot between releases
const APP_ID = 'vttrpg-trystero-v1';             // namespaces the public signaling relays (not secret)
const DEFAULT_STRATEGY = 'mqtt';                 // how peers find each other (signaling only, no chat data)
const STRATEGIES = { mqtt: '@trystero-p2p/mqtt', torrent: '@trystero-p2p/torrent', nostr: '@trystero-p2p/nostr' };
const CDNS = [p => `https://esm.run/${p}`, p => `https://esm.sh/${p}`];

// ============================================================================
// TURN – used AUTOMATICALLY by the DM and by every player (both load this same file).
// Without a TURN relay, devices on networks that cannot reach each other directly will NOT connect.
// Fill in ONE of the two. Anything here is readable by everyone who opens the page.
// ============================================================================
const TURN_SERVERS = [
  // { urls: ['turn:YOUR_HOST:3478', 'turns:YOUR_HOST:443?transport=tcp'], username: 'USER', credential: 'PASSWORD' },
];
const TURN_FETCH_URL = '';   // alternative: a URL that returns such a list as JSON (e.g. the "credentials" URL of a TURN provider)

const LS_CAMPAIGNS = 'vttrpg:campaigns';
const LS_NAME = 'vttrpg:playerName';
const JOIN_HINT_MS = 25000;

// ---------- helpers ----------
const rid = (n = 12) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => (b % 36).toString(36)).join(''); };
const short = id => String(id).slice(0, 6);
const safeStr = x => { try { return typeof x === 'string' ? x : (x?.message || JSON.stringify(x)); } catch { return String(x); } };
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

// ---------- global diagnostics: warnings/errors/online state go into the visible log ----------
let activeLog = null;
for (const lvl of ['warn', 'error']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => { orig(...a); try { activeLog?.(`console.${lvl}: ` + a.map(safeStr).join(' ').slice(0, 400)); } catch { } };
}
addEventListener('error', e => activeLog?.('window error: ' + e.message));
addEventListener('unhandledrejection', e => activeLog?.('unhandled rejection: ' + safeStr(e.reason)));
addEventListener('online', () => activeLog?.('browser went ONLINE'));
addEventListener('offline', () => activeLog?.('browser went OFFLINE'));
document.addEventListener('visibilitychange', () => activeLog?.('tab is now ' + document.visibilityState));
const footer = document.getElementById('version');
if (footer) footer.textContent = `VTTRPG v${APP_VERSION} · Trystero ${TRYSTERO_VERSION}`;

// Passive WebRTC logging (only listeners + getStats, nothing is overridden):
// shows candidate types (host/srflx = direct, relay = TURN), connectivity checks and the path finally used.
if (window.RTCPeerConnection && !window.__pcLogged) {
  window.__pcLogged = true;
  const Native = window.RTCPeerConnection; let count = 0;
  window.RTCPeerConnection = class extends Native {
    constructor(cfg, ...rest) {
      super(cfg, ...rest);
      const id = ++count, L = m => activeLog?.(`rtc#${id}: ${m}`);
      const kinds = {};
      (cfg?.iceServers || []).flatMap(s => [].concat(s.urls || [])).forEach(u => { const k = String(u).split(':')[0]; kinds[k] = (kinds[k] || 0) + 1; });
      L(`created; ICE servers ${JSON.stringify(kinds)}${cfg?.iceTransportPolicy ? ', policy ' + cfg.iceTransportPolicy : ''}`);
      const local = {}, typ = c => / typ (\w+)/.exec(c || '')?.[1] || '?';
      const stats = async label => {
        try {
          const st = await this.getStats(), pairs = [], remote = {};
          st.forEach(r => {
            if (r.type === 'remote-candidate') remote[r.candidateType] = (remote[r.candidateType] || 0) + 1;
            if (r.type === 'candidate-pair') { const l = st.get(r.localCandidateId), q = st.get(r.remoteCandidateId); pairs.push(`${r.nominated ? '*' : ''}${r.state} ${l?.candidateType}->${q?.candidateType} checks sent/answered ${r.requestsSent || 0}/${r.responsesReceived || 0}`); }
          });
          L(`${label}: pairs [${pairs.join('; ') || 'none'}] | remote candidates ${JSON.stringify(remote)} | local ${JSON.stringify(local)}`);
        } catch (e) { L('stats error: ' + e.message); }
      };
      this.addEventListener('icecandidate', e => {
        if (e.candidate) { const k = `${typ(e.candidate.candidate)}/${e.candidate.protocol || '?'}`; local[k] = (local[k] || 0) + 1; }
        else L(`ICE gathering done; local candidates ${JSON.stringify(local)}`);
      });
      this.addEventListener('icecandidateerror', e => L(`ICE candidate error ${e.errorCode || ''} ${e.url || ''} ${e.errorText || ''}`));
      this.addEventListener('iceconnectionstatechange', () => {
        L(`ice=${this.iceConnectionState}`);
        if (this.iceConnectionState === 'checking') [3000, 8000].forEach(t => setTimeout(() => { if (this.iceConnectionState === 'checking') stats(`in-flight @${t / 1000}s`); }, t));
      });
      this.addEventListener('connectionstatechange', () => {
        L(`conn=${this.connectionState}`);
        if (this.connectionState === 'failed') stats('FAILED');
        if (this.connectionState === 'connected') setTimeout(() => stats('CONNECTED, path used (* = selected)'), 500);
      });
    }
  };
}

// ---------- TURN resolution ----------
async function resolveTurn(log) {
  const list = [...TURN_SERVERS];
  if (TURN_FETCH_URL) {
    const t = performance.now(), ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(TURN_FETCH_URL, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json(), arr = Array.isArray(data) ? data : (data.iceServers || []);
      list.push(...arr); log(`TURN credentials fetched: ${arr.length} entries in ${Math.round(performance.now() - t)} ms`);
    } catch (e) { log('TURN fetch FAILED: ' + e.message); }
    finally { clearTimeout(to); }
  }
  const servers = list.filter(s => s && s.urls && [].concat(s.urls).length);
  const urls = servers.flatMap(s => [].concat(s.urls));
  if (urls.some(u => /^turns?:/i.test(u))) log(`TURN configured: ${urls.filter(u => /^turns?:/i.test(u)).map(u => u.replace(/\?.*$/, '')).join(', ')}`);
  else log('WARNING: no TURN server configured. Only direct connections can work (devices on different networks often fail). Set TURN_SERVERS or TURN_FETCH_URL at the top of app.js.');
  return servers;
}

// ---------- networking layer (the only code that talks to Trystero) ----------
async function loadStrategy(name, log) {
  const pkg = `${STRATEGIES[name]}@${TRYSTERO_VERSION}`;
  for (const mk of CDNS) {
    const url = mk(pkg), t = performance.now();
    log(`loading library: ${url}`);
    try { const mod = await import(url); log(`library loaded in ${Math.round(performance.now() - t)} ms`); return mod; }
    catch (e) { log(`library load FAILED after ${Math.round(performance.now() - t)} ms: ${e.message}`); }
  }
  throw new Error('could not load the networking library (strategy ' + name + ')');
}

// returns { send(data, targetPeerId?), status(), leave() }
async function connect(strategy, roomId, secret, { log, onJoin, onLeave, onMessage }) {
  const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
  let tx = 0, rx = 0;
  log(`env: online=${navigator.onLine} secureContext=${isSecureContext} RTCPeerConnection=${typeof RTCPeerConnection !== 'undefined'}`);
  log(`browser: ${navigator.userAgent}`);
  log(`strategy "${strategy}", Trystero ${TRYSTERO_VERSION}, room ${short(roomId)}`);
  const turnConfig = await resolveTurn(log);
  const mod = await loadStrategy(strategy, log);
  log(`own peer id: ${short(mod.selfId)}`);
  const room = mod.joinRoom({ appId: APP_ID, password: secret, ...(turnConfig.length ? { turnConfig } : {}) }, roomId, {
    onJoinError: d => log('JOIN ERROR: ' + safeStr(d)),
  });
  log(`joined room after ${ms()} ms (handshake encrypted with the link secret)`);
  const action = room.makeAction('msg');

  const relayStates = () => {
    try {
      const names = ['connecting', 'open', 'closing', 'closed'];
      const list = Object.entries(mod.getRelaySockets?.() || {}).map(([u, s]) => `${u.replace(/^wss?:\/\//, '')}=${s.readyState !== undefined ? names[s.readyState] : (s.connected ? 'open' : 'not connected')}`);
      return list.length ? list.join('  ') : '(no relay sockets)';
    } catch (e) { return 'unavailable: ' + e.message; }
  };
  const peerStates = () => {
    try {
      const peers = room.getPeers?.() || {}, ids = Object.keys(peers);
      return ids.length ? ids.map(id => `${short(id)}[conn=${peers[id]?.connectionState},ice=${peers[id]?.iceConnectionState}]`).join(' ') : 'none';
    } catch (e) { return 'unavailable: ' + e.message; }
  };
  const status = () => `relays: ${relayStates()} | peers: ${peerStates()} | msgs sent=${tx} received=${rx} | up ${Math.round(ms() / 1000)} s`;

  room.onPeerJoin = pid => {
    log(`peer JOINED ${short(pid)} (after ${ms()} ms)`);
    Promise.resolve(room.ping?.(pid)).then(t => log(`${short(pid)} ping ${Math.round(t)} ms`)).catch(e => log(`${short(pid)} ping failed: ${e.message}`));
    onJoin(pid);
  };
  room.onPeerLeave = pid => { log(`peer LEFT ${short(pid)}`); onLeave(pid); };
  action.onMessage = (data, meta) => { rx++; log(`← ${short(meta.peerId)} ${data?.t ?? typeof data}`); onMessage(data, meta.peerId); };

  log('relays at join: ' + relayStates());
  const timers = [];
  [2000, 6000, 15000].forEach(t => timers.push(setTimeout(() => log(`status @${t / 1000}s: ${status()}`), t)));
  timers.push(setInterval(() => log('status: ' + status()), 30000));

  return {
    send(data, target) {
      tx++; log(`→ ${target ? short(target) : 'all'} ${data?.t ?? typeof data}`);
      Promise.resolve(action.send(data, target ? { target } : {})).catch(e => log('SEND FAILED: ' + e.message));
    },
    status() { log('status (manual): ' + status()); },
    leave() { timers.forEach(t => { clearTimeout(t); clearInterval(t); }); log('leaving room'); try { room.leave(); } catch (e) { log('leave error: ' + e.message); } },
  };
}

// ---------- storage (DM): campaigns live in this browser ----------
const loadAll = () => { try { return JSON.parse(localStorage.getItem(LS_CAMPAIGNS)) || {}; } catch { return {}; } };
function saveCampaign(c) { try { const all = loadAll(); all[c.id] = c; localStorage.setItem(LS_CAMPAIGNS, JSON.stringify(all)); } catch (e) { alert('Could not save (storage full?): ' + e.message); } }
function deleteCampaign(id) { const all = loadAll(); delete all[id]; localStorage.setItem(LS_CAMPAIGNS, JSON.stringify(all)); }

// ---------- UI parts ----------
function makeLog(role, onStatus) {
  const pre = h('pre', { class: 'log' });
  const log = s => { pre.textContent += `${new Date().toISOString().slice(11, 23)}  ${s}\n`; pre.scrollTop = pre.scrollHeight; console.log(`[vttrpg ${role}]`, s); };
  const toolbar = h('div', { class: 'row' },
    h('button', { onclick: () => onStatus() }, 'Log status now'),
    h('button', { onclick: async () => { try { await navigator.clipboard.writeText(`VTTRPG v${APP_VERSION} (${role})\n` + pre.textContent); log('log copied to clipboard'); } catch (e) { log('copy failed: ' + e.message); } } }, 'Copy log'),
    h('button', { onclick: () => { pre.textContent = ''; } }, 'Clear'));
  activeLog = log;
  log(`VTTRPG v${APP_VERSION} ${role} view started; page ${location.pathname}`);
  return { el: h('div', {}, toolbar, pre), log };
}

function makeChat(onSend) {
  const box = h('div', { class: 'chat' });
  const input = h('input', { placeholder: 'Message…', maxlength: '500' });
  const btn = h('button', {}, 'Send');
  const submit = () => { const t = input.value.trim(); if (!t) return; onSend(t); input.value = ''; };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  btn.addEventListener('click', submit);
  return {
    el: h('div', {}, box, h('div', { class: 'row' }, input, btn)),
    add(m) {
      box.append(h('div', { class: m.sys ? 'msg sys' : 'msg' },
        h('span', { class: 'ts' }, new Date(m.ts).toLocaleTimeString() + ' '),
        m.sys ? m.text : [h('b', {}, m.from + ': '), m.text]));
      box.scrollTop = box.scrollHeight;
    },
    clear: () => box.replaceChildren(),
    setEnabled: on => { input.disabled = !on; btn.disabled = !on; },
  };
}

// ---------- router ----------
const $app = document.getElementById('app');
let cleanup = null;
function route() {
  cleanup?.(); cleanup = null; activeLog = null; $app.replaceChildren();
  const hash = location.hash.replace(/^#/, '') || '/';
  let m;
  if ((m = hash.match(/^\/join\/([a-z0-9]+)\.([a-z0-9]+)(?:\.([a-z]+))?$/))) return viewPlayer(m[1], m[2], STRATEGIES[m[3]] ? m[3] : DEFAULT_STRATEGY);
  if ((m = hash.match(/^\/dm\/([a-z0-9]+)$/))) return viewDM(m[1]);
  viewHome();
}
addEventListener('hashchange', route);
route();

// ---------- HOME: create / open campaigns ----------
function viewHome() {
  const nameIn = h('input', { placeholder: 'New campaign name' });
  const listEl = h('div');
  const create = () => {
    const name = nameIn.value.trim(); if (!name) return;
    const c = { id: rid(10), name, created: Date.now(), roomId: rid(14), secret: rid(20), chat: [] };
    saveCampaign(c); location.hash = '#/dm/' + c.id;
  };
  nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') create(); });
  const render = () => {
    const all = Object.values(loadAll());
    listEl.replaceChildren(...(all.length ? all.map(c => h('div', { class: 'row' },
      h('b', {}, c.name), h('span', { class: 'muted' }, `${(c.chat || []).length} messages`),
      h('button', { onclick: () => { location.hash = '#/dm/' + c.id; } }, 'Open as DM'),
      h('button', { onclick: () => { if (confirm(`Delete "${c.name}" from this browser?`)) { deleteCampaign(c.id); render(); } } }, 'Delete')
    )) : [h('div', { class: 'muted' }, 'No campaigns in this browser yet.')]));
  };
  render();
  $app.append(
    h('section', {}, h('h2', {}, 'Create campaign (you become the DM)'), h('div', { class: 'row' }, nameIn, h('button', { onclick: create }, 'Create'))),
    h('section', {}, h('h2', {}, 'Your campaigns (stored in this browser only)'), listEl),
    h('section', { class: 'muted' }, 'Players: you need nothing here. Open the link or scan the QR code the DM gave you.')
  );
}

// ---------- DM ----------
function viewDM(cid) {
  const camp = loadAll()[cid];
  if (!camp) { location.hash = '#/'; return; }
  if (!camp.roomId || !camp.secret) { camp.roomId = camp.roomId || rid(14); camp.secret = rid(20); }
  camp.chat = camp.chat || []; saveCampaign(camp);
  const { el: logEl, log } = makeLog('DM', () => conn ? conn.status() : log('no active session'));
  log(`campaign "${camp.name}" (${cid}) loaded: ${camp.chat.length} chat messages`);
  const chat = makeChat(text => postChat({ from: 'DM', text }));
  camp.chat.slice(-100).forEach(chat.add);
  chat.setEnabled(false);

  let conn = null, busy = false;
  const peers = new Map();   // peerId -> { name }

  const stratSel = h('select', {}, ...Object.keys(STRATEGIES).map(k => h('option', { value: k }, k + (k === DEFAULT_STRATEGY ? ' (default)' : ''))));
  stratSel.value = DEFAULT_STRATEGY;
  const toggleBtn = h('button', { onclick: () => conn ? stopSession() : startSession() }, 'Start session');
  const stateEl = h('span', { class: 'tag' }, 'stopped');
  const linkIn = h('input', { readonly: '', placeholder: 'Start the session to get the link' });
  const copyBtn = h('button', { onclick: () => { linkIn.select(); navigator.clipboard?.writeText(linkIn.value); log('join link copied'); } }, 'Copy link');
  const qrCanvas = h('canvas'); qrCanvas.style.display = 'none';
  const playersEl = h('div', { class: 'muted' }, 'No players connected.');

  const sendTo = (data, pid) => conn?.send(data, pid);
  const joined = () => [...peers.keys()];
  const roster = () => [...peers.values()].map(p => p.name);
  const broadcastRoster = () => joined().forEach(pid => sendTo({ t: 'roster', roster: roster() }, pid));
  const renderPlayers = () => { playersEl.textContent = peers.size ? `Connected players (${peers.size}): ${roster().join(', ')}` : 'No players connected.'; };

  async function startSession() {
    if (busy || conn) return;
    busy = true; toggleBtn.disabled = stratSel.disabled = true; stateEl.textContent = 'starting…';
    const strategy = stratSel.value;
    log(`starting session with strategy ${strategy}`);
    try {
      conn = await connect(strategy, camp.roomId, camp.secret, {
        log,
        onJoin: pid => log(`player peer ${short(pid)} connected, waiting for its join message`),
        onLeave: pid => { const p = peers.get(pid); if (p) { peers.delete(pid); log(`${p.name} left`); systemMsg(`${p.name} left`); renderPlayers(); broadcastRoster(); } },
        onMessage: onMsg,
      });
    } catch (e) { log('COULD NOT START SESSION: ' + e.message); busy = false; toggleBtn.disabled = stratSel.disabled = false; stateEl.textContent = 'failed'; return; }
    const link = `${location.href.split('#')[0]}#/join/${camp.roomId}.${camp.secret}.${strategy}`;
    linkIn.value = link;
    if (window.QRCode) QRCode.toCanvas(qrCanvas, link, { width: 240, margin: 2 }, err => { if (err) log('QR error: ' + err.message); else { qrCanvas.style.display = ''; log('QR code drawn'); } });
    else log('QR library not loaded – use the link');
    busy = false; toggleBtn.disabled = false; toggleBtn.textContent = 'Stop session'; stateEl.textContent = 'running'; chat.setEnabled(true);
    log('SESSION RUNNING – share the link or QR code. Keep this tab open and in the foreground.');
  }

  function stopSession() {
    if (!conn) return;
    log(`stopping session; telling ${peers.size} player(s)`);
    joined().forEach(pid => sendTo({ t: 'closed' }, pid));
    const c = conn; setTimeout(() => c.leave(), 400);
    conn = null; peers.clear(); renderPlayers();
    linkIn.value = ''; qrCanvas.style.display = 'none'; toggleBtn.textContent = 'Start session'; stateEl.textContent = 'stopped'; stratSel.disabled = false; chat.setEnabled(false);
  }

  function onMsg(m, pid) {
    if (!m || typeof m !== 'object') return log(`ignored malformed message from ${short(pid)}`);
    if (m.t === 'join') {
      const name = String(m.name || '').trim().slice(0, 30) || 'Player';
      const known = peers.has(pid);
      peers.set(pid, { name });
      log(`JOIN from ${short(pid)} as "${name}"${known ? ' (repeat)' : ''}`);
      sendTo({ t: 'welcome', campaign: camp.name, history: camp.chat.slice(-50), roster: roster() }, pid);
      if (!known) systemMsg(`${name} joined`);
      renderPlayers(); broadcastRoster(); return;
    }
    const p = peers.get(pid);
    if (!p) return log(`ignored "${m.t}" from ${short(pid)}: has not joined`);
    if (m.t === 'chat') { const text = String(m.text || '').trim().slice(0, 500); if (text) postChat({ from: p.name, text }); }
    else log(`ignored unknown message type "${m.t}" from ${p.name}`);
  }

  function systemMsg(text) { postChat({ sys: true, text }); }
  function postChat(partial) {
    const msg = { id: rid(8), ts: Date.now(), ...partial };
    camp.chat.push(msg); if (camp.chat.length > 1000) camp.chat.splice(0, camp.chat.length - 1000);
    saveCampaign(camp); chat.add(msg);
    joined().forEach(pid => sendTo({ t: 'chat', msg }, pid));
  }

  $app.append(
    h('div', { class: 'row' }, h('a', { href: '#/' }, '← Campaigns'), h('b', {}, `DM: ${camp.name}`)),
    h('section', {}, h('h2', {}, 'Session'),
      h('div', { class: 'row' }, 'Signaling:', stratSel, toggleBtn, stateEl),
      h('div', { class: 'row' }, linkIn, copyBtn), qrCanvas, playersEl,
      h('div', { class: 'muted' }, 'The link stays the same for this campaign. Anyone with the link can join, so share it only with your players.')),
    h('section', {}, h('h2', {}, 'Chat (stored in this browser)'), chat.el),
    h('section', {}, h('h2', {}, 'Connection log'), logEl)
  );
  cleanup = () => { conn?.leave(); conn = null; };
}

// ---------- PLAYER ----------
function viewPlayer(roomId, secret, strategy) {
  const { el: logEl, log } = makeLog('Player', () => conn ? conn.status() : log('not connected yet'));
  log(`link: room ${short(roomId)}, strategy ${strategy}`);
  const statusEl = h('div', { class: 'status' }, 'Enter your name and join.');
  const rosterEl = h('div', { class: 'muted' });
  const nameIn = h('input', { value: localStorage.getItem(LS_NAME) || '', placeholder: 'Your name', maxlength: '30' });
  const joinBtn = h('button', { onclick: () => join() }, 'Join');
  let conn = null, dmPid = null, state = 'idle', hintTimer = null, t0 = 0;
  const queued = [];
  const chat = makeChat(text => { if (state === 'joined' && dmPid) conn.send({ t: 'chat', text }, dmPid); });
  chat.setEnabled(false);

  const setState = (s, text) => { if (s !== state) log(`state: ${state} -> ${s} | ${text}`); state = s; statusEl.textContent = text; chat.setEnabled(s === 'joined'); };
  const sendJoin = pid => { log(`sending join to ${short(pid)}`); conn.send({ t: 'join', name: nameIn.value.trim() || 'Player' }, pid); };

  async function join() {
    const name = nameIn.value.trim(); if (!name) { nameIn.focus(); return; }
    localStorage.setItem(LS_NAME, name); joinBtn.disabled = nameIn.disabled = true; t0 = performance.now();
    log(`Join clicked as "${name}"`);
    setState('connecting', 'Looking for the DM… (can take 5–20 s)');
    try {
      const c = await connect(strategy, roomId, secret, {
        log,
        onJoin: pid => { if (!conn) queued.push(pid); else if (!dmPid) sendJoin(pid); },
        onLeave: pid => { if (pid === dmPid) { dmPid = null; log('the DM disconnected'); setState('connecting', 'DM disconnected. Waiting for it to come back…'); } },
        onMessage: onMsg,
      });
      conn = c; queued.splice(0).forEach(pid => { if (!dmPid) sendJoin(pid); });
    } catch (e) { log('COULD NOT START NETWORKING: ' + e.message); setState('error', 'Could not start networking: ' + e.message); return; }
    hintTimer = setTimeout(() => { if (state === 'connecting') { log(`no DM answered after ${Math.round((performance.now() - t0) / 1000)} s, see relay and ICE lines above`); setState('connecting', 'No DM found yet. Is the session running? Still trying… (see the log)'); } }, JOIN_HINT_MS);
  }

  function onMsg(m, pid) {
    if (!m || typeof m !== 'object') return log(`ignored malformed message from ${short(pid)}`);
    if (m.t === 'welcome' && !dmPid) {
      dmPid = pid; clearTimeout(hintTimer); chat.clear(); (m.history || []).forEach(chat.add); renderRoster(m.roster);
      log(`WELCOME from the DM ${short(pid)}; ${(m.history || []).length} history message(s); ${Math.round((performance.now() - t0) / 1000)} s since Join`);
      return setState('joined', `Joined "${m.campaign}"`);
    }
    if (pid !== dmPid) return log(`ignored "${m.t}" from ${short(pid)} (not the DM)`);
    if (m.t === 'chat') chat.add(m.msg);
    else if (m.t === 'roster') renderRoster(m.roster);
    else if (m.t === 'closed') { dmPid = null; setState('connecting', 'The DM stopped the session. Waiting for it to start again…'); }
    else log(`unknown message type "${m.t}"`);
  }

  function renderRoster(r = []) { rosterEl.textContent = r.length ? 'In session: ' + r.join(', ') : ''; }

  $app.append(
    h('section', {}, h('h2', {}, 'Join session'), h('div', { class: 'row' }, nameIn, joinBtn), statusEl, rosterEl),
    h('section', {}, h('h2', {}, 'Chat'), chat.el),
    h('section', {}, h('h2', {}, 'Connection log'), logEl)
  );
  cleanup = () => { clearTimeout(hintTimer); conn?.leave(); conn = null; };
}
