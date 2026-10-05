// VTTRPG skeleton: DM-hosted, browser-only, WebRTC via PeerJS.
// Session behaviour is modelled on the 5.5e-companion reference (js/peer.js):
//  - DM = host with a STABLE room id (peer id "vttrpg-<roomId>") on the PeerJS cloud; the link never changes, a PIN guards each session
//  - DM re-claims its id when the signaling connection drops, retries when the id is still held (page refresh)
//  - players connect with a 10 s timeout and retry with exponential backoff (1 s .. 30 s), also on tab-visible / network-online
//  - players ping every 30 s, the DM answers and drops connections silent for 60 s
// On top of that the skeleton adds: approval lobby, numbered players, kick/ban, chat with history, export/import.

const APP_VERSION = '0.6.1';
const PEERJS_VERSION = '1.5.5';                   // loaded by index.html

const PEER_PREFIX = 'vttrpg-';
const STALE_MS = 60000, STALE_CHECK_MS = 15000, HEARTBEAT_MS = 30000;
const CONNECT_TIMEOUT_MS = 10000, RECONNECT_BASE_MS = 1000, RECONNECT_MAX_MS = 30000, JOIN_REPLY_TIMEOUT_MS = 8000;

// ---------- global diagnostics: forward warnings/errors/online state into the visible log ----------
let activeLog = null;                              // set by the current view's log()
const safeStr = x => { try { return typeof x === 'string' ? x : (x?.message || JSON.stringify(x)); } catch { return String(x); } };
for (const lvl of ['warn', 'error']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => { orig(...a); try { activeLog?.(`console.${lvl}: ` + a.map(safeStr).join(' ').slice(0, 400)); } catch { } };
}
addEventListener('error', e => activeLog?.('window error: ' + e.message));
addEventListener('unhandledrejection', e => activeLog?.('unhandled rejection: ' + safeStr(e.reason)));
addEventListener('online', () => activeLog?.('browser went ONLINE'));
addEventListener('offline', () => activeLog?.('browser went OFFLINE'));
document.addEventListener('visibilitychange', () => activeLog?.('tab is now ' + document.visibilityState));

// Log every WebRTC connection attempt: ICE servers, candidate types (host/srflx/relay), checks and the path finally used.
// host/srflx = direct connection, relay = through a TURN server. TURN problems show up as ICE candidate errors.
if (window.RTCPeerConnection && !window.__vttrpgPcPatched) {
  window.__vttrpgPcPatched = true;
  const NativePC = window.RTCPeerConnection; let pcCount = 0;
  window.RTCPeerConnection = class extends NativePC {
    constructor(cfg, ...rest) {
      super(cfg, ...rest);
      const id = ++pcCount, L = m => activeLog?.(`rtc#${id}: ${m}`);
      const kinds = {};
      (cfg?.iceServers || []).flatMap(s => [].concat(s.urls || s.url || [])).forEach(u => { const k = String(u).split(':')[0]; kinds[k] = (kinds[k] || 0) + 1; });
      L(`new connection; ICE servers: ${JSON.stringify(kinds)}${cfg?.iceTransportPolicy ? ', policy=' + cfg.iceTransportPolicy : ''}`);
      const cand = {}, remote = {};
      const typeOf = c => / typ (\w+)/.exec(c || '')?.[1];
      const summarize = async (label = 'FAILURE SUMMARY') => {
        try {
          const st = await this.getStats(); const lines = [];
          st.forEach(r => { if (r.type === 'candidate-pair') { const l = st.get(r.localCandidateId), q = st.get(r.remoteCandidateId); lines.push(`${r.nominated ? '*' : ''}${r.state} ${l?.candidateType}->${q?.candidateType} checks sent/answered ${r.requestsSent || 0}/${r.responsesReceived || 0}`); } });
          L(`${label}: ${lines.length} candidate pair(s) [${lines.join('; ')}]; remote candidates seen ${JSON.stringify(remote)}; conn=${this.connectionState}`);
        } catch (e) { L('stats error: ' + e.message); }
      };
      this.addEventListener('icecandidate', e => {
        if (e.candidate) { const k = `${typeOf(e.candidate.candidate) || '?'}/${e.candidate.protocol || '?'}`; cand[k] = (cand[k] || 0) + 1; }
        else L(`ICE gathering finished; local candidates: ${JSON.stringify(cand)}`);
      });
      this.addEventListener('icecandidateerror', e => L(`ICE candidate error ${e.errorCode || ''} ${e.url || ''} ${e.errorText || ''}`));
      this.addEventListener('iceconnectionstatechange', () => {
        L(`ice=${this.iceConnectionState}`);
        if (this.iceConnectionState === 'checking') [3000, 8000].forEach(t => setTimeout(() => { if (this.iceConnectionState === 'checking') summarize(`in-flight @${t / 1000}s`); }, t));
      });
      this.addEventListener('connectionstatechange', () => {
        L(`conn=${this.connectionState}`);
        if (this.connectionState === 'failed') summarize();
        if (this.connectionState === 'connected') setTimeout(() => summarize('CONNECTED, path used (* = selected)'), 500);
      });
      const origSRD = this.setRemoteDescription.bind(this);
      this.setRemoteDescription = d => {
        (d?.sdp || '').split('\n').filter(l => l.startsWith('a=candidate')).forEach(l => { const t = typeOf(l); if (t) remote[t] = (remote[t] || 0) + 1; });
        L(`remote ${d?.type} set; remote candidates so far: ${JSON.stringify(remote)}`);
        return origSRD(d);
      };
      const origAIC = this.addIceCandidate.bind(this);
      this.addIceCandidate = c => {
        const t = typeOf(c?.candidate); if (t) remote[t] = (remote[t] || 0) + 1;
        return origAIC(c).then(r => r, e => { L(`addIceCandidate REJECTED: ${e.name}: ${e.message}`); throw e; });
      };
    }
  };
}

const footer = document.getElementById('version');
if (footer) footer.textContent = `VTTRPG skeleton v${APP_VERSION} · PeerJS ${PEERJS_VERSION}`;

const short = id => String(id).slice(0, 8);

// Optional TURN relay + relay-only test flag travel in the join link (URL hash, never sent to a server)
const b64e = o => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
const parseOpts = q => {
  const p = new URLSearchParams(q); let turn = null;
  try {
    const o = p.get('t') && b64d(p.get('t'));
    const urls = [].concat(o?.urls || []).map(String).filter(u => /^(turns?|stuns?):/.test(u));
    if (urls.length) turn = { urls, username: String(o.username || ''), credential: String(o.credential || '') };
  } catch { }
  return { turn, relayOnly: p.get('r') === '1' };
};

// ---------- networking: PeerJS transport (behaviour copied from the reference repo) ----------
// Default = exactly the reference setup (PeerJS defaults: cloud signaling, Google STUN + PeerJS shared TURN).
// Only when the DM adds a TURN server or ticks the relay test do we pass an explicit ICE configuration.
function peerOptions({ turn, relayOnly, log }) {
  if (!turn && !relayOnly) { log('ICE servers: PeerJS defaults = Google STUN only in practice (the PeerJS shared TURN servers in the defaults were discontinued in 2023). No relay available: networks that cannot connect directly will fail.'); return {}; }
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
  if (turn) iceServers.push(turn);
  log(`ICE servers: Google/Cloudflare STUN${turn ? ', custom TURN ' + turn.urls.join(',') : ''}${relayOnly ? ' | RELAY-ONLY test (direct paths disabled)' : ''}`);
  if (relayOnly && !turn) log('WARNING: relay-only mode without a TURN server cannot connect.');
  return { config: { iceServers, sdpSemantics: 'unified-plan', ...(relayOnly ? { iceTransportPolicy: 'relay' } : {}) } };
}

// DM side: registers "vttrpg-<roomId>" at the PeerJS cloud and accepts player data channels.
function createDMPeer(roomId, { log, turn, relayOnly, onPlayerConnect, onPlayerDisconnect, onMessage, onSignaling }) {
  const peerId = PEER_PREFIX + roomId;
  const connections = new Map();                   // playerPeerId -> { conn, lastActivity }
  const opts = peerOptions({ turn, relayOnly, log });
  let peer = null, destroyed = false, opened = false, staleTimer = null, sigTimer = null, sigAttempt = 0, sent = 0, received = 0;

  function init() { return new Promise((resolve, reject) => tryInit(resolve, reject, 0)); }

  function tryInit(resolve, reject, attempt) {
    log(`registering ${peerId} at the PeerJS cloud (attempt ${attempt + 1})…`);
    opened = false;
    peer = new window.Peer(peerId, { debug: 0, ...opts });
    peer.on('open', id => {
      if (!opened) { opened = true; log(`PeerJS signaling connected as ${id}`); resolve(id); }
      else { sigAttempt = 0; clearTimeout(sigTimer); sigTimer = null; log('signaling connection re-established (id reclaimed)'); onSignaling('connected'); }
    });
    peer.on('error', err => {
      if (destroyed) return;
      log(`PeerJS error (${err?.type || 'unknown'}): ${safeStr(err)}`);
      if (!opened) {
        if (err?.type === 'unavailable-id' && attempt < 3) {          // the cloud may still hold the id after a page refresh
          const delay = 2000 * (attempt + 1);
          log(`id still held by the signaling server, retrying in ${delay} ms (attempt ${attempt + 1}/3)…`);
          peer.destroy(); setTimeout(() => { if (!destroyed) tryInit(resolve, reject, attempt + 1); }, delay);
        } else reject(new Error(err?.type === 'unavailable-id' ? 'Session ID is still held by another connection. Wait a moment and try again.' : 'Connection error: ' + (err?.type || safeStr(err))));
      } else if (peer.disconnected) scheduleSignalingReconnect();
    });
    peer.on('disconnected', () => { if (!destroyed && opened) scheduleSignalingReconnect(); });
    peer.on('connection', handleIncoming);
  }

  function scheduleSignalingReconnect() {          // keep the DM id alive on the signaling server
    if (destroyed || sigTimer) return;
    const delay = Math.min(1000 * 2 ** sigAttempt, RECONNECT_MAX_MS); sigAttempt++;
    log(`signaling connection lost – reclaiming the id in ${delay} ms (attempt ${sigAttempt}); new players cannot find the DM meanwhile`);
    onSignaling('reconnecting');
    sigTimer = setTimeout(() => {
      sigTimer = null;
      if (destroyed || !peer || peer.destroyed) return;
      if (peer.disconnected) { try { peer.reconnect(); } catch (e) { log('reconnect failed: ' + e.message); } }
    }, delay);
  }

  function handleIncoming(conn) {
    const pid = conn.peer;
    log(`incoming connection from ${short(pid)} (negotiating…)`);
    conn.on('iceStateChanged', s => log(`${short(pid)} PeerJS ICE state: ${s}`));
    conn.on('open', () => {
      connections.set(pid, { conn, lastActivity: Date.now() });
      log(`data channel open: ${short(pid)}`);
      ensureStaleCheck(); onPlayerConnect(pid);
    });
    conn.on('data', data => {
      const e = connections.get(pid); if (e && e.conn === conn) e.lastActivity = Date.now();
      received++;
      if (data && data.t === 'ping') { try { conn.send({ t: 'pong', ts: data.ts }); } catch { } return; }   // keep-alive, as in the reference
      log(`← ${short(pid)} ${data?.t ?? typeof data}`);
      onMessage(data, pid);
    });
    const drop = reason => {
      const e = connections.get(pid);
      if (!e || e.conn !== conn) return;           // a newer connection of the same player replaced this one
      connections.delete(pid); log(`player ${short(pid)} gone (${reason})`); onPlayerDisconnect(pid);
    };
    conn.on('close', () => drop('closed'));
    conn.on('error', err => { log(`connection error ${short(pid)}: ${err?.type || ''} ${safeStr(err)}`); drop('error'); });
  }

  function ensureStaleCheck() {                    // drop connections that went silent (phone backgrounded, WebRTC died quietly)
    if (staleTimer) return;
    staleTimer = setInterval(() => {
      if (destroyed) { clearInterval(staleTimer); staleTimer = null; return; }
      const now = Date.now();
      for (const [pid, e] of connections) {
        if (now - e.lastActivity > STALE_MS) {
          log(`stale connection ${short(pid)} (silent for ${Math.round((now - e.lastActivity) / 1000)} s) – dropping`);
          connections.delete(pid); try { e.conn.close(); } catch { } onPlayerDisconnect(pid);
        }
      }
      if (!connections.size) { clearInterval(staleTimer); staleTimer = null; }
    }, STALE_CHECK_MS);
  }

  return {
    init,
    send(data, target) {                           // target = one player's peer id, or everybody
      const list = target ? [[target, connections.get(target)]] : [...connections];
      for (const [pid, e] of list) if (e?.conn?.open) { try { e.conn.send(data); sent++; log(`→ ${short(pid)} ${data?.t ?? typeof data}`); } catch (err) { log('send failed: ' + err.message); } }
    },
    close(pid) { const e = connections.get(pid); if (e) { connections.delete(pid); try { e.conn.close(); } catch { } } },
    isConnected: () => !!peer && !peer.disconnected && !peer.destroyed,
    status() { log(`DM peer ${peerId}: signaling ${peer?.disconnected ? 'DISCONNECTED' : peer?.destroyed ? 'destroyed' : 'connected'} | players connected=${connections.size} | messages sent=${sent} received=${received}`); },
    destroy() {
      destroyed = true; clearInterval(staleTimer); clearTimeout(sigTimer); staleTimer = sigTimer = null;
      try { peer?.destroy(); } catch { } peer = null; connections.clear(); log('DM peer destroyed (id released)');
    },
  };
}

// Player side: one data channel to the DM, with timeout, backoff retries and heartbeat.
function createPlayerPeer(roomId, { log, turn, relayOnly, onConnect, onDisconnect, onReconnecting, onMessage }) {
  const hostId = PEER_PREFIX + roomId;
  const opts = peerOptions({ turn, relayOnly, log });
  let peer = null, conn = null, destroyed = false, reconnectAttempt = 0, reconnectTimer = null, attemptTimer = null, heartbeat = null;
  let connectNo = 0, lastIce = 'n/a', sent = 0, received = 0;

  function start() { destroyed = false; createPeer(); }

  function createPeer() {
    if (peer && !peer.destroyed) peer.destroy();
    log('registering at the PeerJS cloud…');
    peer = new window.Peer(undefined, { debug: 0, ...opts });
    peer.on('open', id => { log(`PeerJS signaling connected as ${short(id)}`); if (!conn?.open) openConnection(); });
    peer.on('disconnected', () => {
      if (destroyed) return;
      log('lost the PeerJS signaling connection – reconnecting in 1 s');
      setTimeout(() => { if (!destroyed && peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 1000);
    });
    peer.on('error', err => {
      if (destroyed) return;
      log(`PeerJS error (${err?.type || 'unknown'}): ${safeStr(err)}${err?.type === 'peer-unavailable' ? '  -> the DM is not registered (session closed, or DM lost its signaling connection)' : ''}`);
      scheduleReconnect();
    });
    peer.on('connection', c => { log(`refused incoming connection from ${short(c.peer)} (players only talk to the DM)`); c.on('open', () => c.close()); });
  }

  function openConnection() {
    if (destroyed || !peer || peer.destroyed) return;
    if (conn) { const old = conn; conn = null; try { old.close(); } catch { } }
    const no = ++connectNo;
    log(`connecting to the DM (attempt ${no}, ${CONNECT_TIMEOUT_MS / 1000} s timeout)…`);
    const c = peer.connect(hostId, { reliable: true });
    conn = c; let opened = false;
    clearTimeout(attemptTimer);
    attemptTimer = setTimeout(() => {
      if (opened || destroyed || conn !== c) return;
      log(`attempt ${no} timed out (last ICE state: ${lastIce})`);
      try { c.close(); } catch { }
      scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);
    c.on('iceStateChanged', s => { lastIce = s; log(`PeerJS ICE state: ${s}`); });
    c.on('open', () => {
      opened = true; clearTimeout(attemptTimer); reconnectAttempt = 0;
      log(`data channel to the DM open (attempt ${no})`); startHeartbeat(); onConnect();
    });
    c.on('data', data => {
      received++;
      if (data && data.t === 'pong') return;
      log(`← DM ${data?.t ?? typeof data}`); onMessage(data);
    });
    c.on('close', () => {
      clearTimeout(attemptTimer);
      if (conn !== c || destroyed) return;
      stopHeartbeat(); log('data channel to the DM closed');
      if (opened) onDisconnect();
      scheduleReconnect();
    });
    c.on('error', err => {
      clearTimeout(attemptTimer);
      if (conn !== c || destroyed) return;
      stopHeartbeat(); log(`connection error: ${err?.type || ''} ${safeStr(err)}`);
      if (opened) onDisconnect();
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (destroyed || reconnectTimer) return;
    clearTimeout(attemptTimer);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS); reconnectAttempt++;
    log(`retry ${reconnectAttempt} in ${delay} ms`); onReconnecting(reconnectAttempt, delay);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; if (!destroyed) doReconnect(); }, delay);
  }

  function doReconnect() {
    if (destroyed) return;
    if (!peer || peer.destroyed) createPeer();
    else if (peer.disconnected) { log('reconnecting to the signaling server first…'); peer.reconnect(); }
    else openConnection();
  }

  function cancelReconnect() { clearTimeout(reconnectTimer); reconnectTimer = null; reconnectAttempt = 0; }
  function startHeartbeat() { stopHeartbeat(); heartbeat = setInterval(() => { if (conn?.open) { try { conn.send({ t: 'ping', ts: Date.now() }); } catch { } } }, HEARTBEAT_MS); }
  function stopHeartbeat() { clearInterval(heartbeat); heartbeat = null; }

  return {
    start,
    isConnected: () => !!(conn && conn.open),
    send(data) { if (conn?.open) { conn.send(data); sent++; log(`→ DM ${data?.t ?? typeof data}`); } else log(`not sent (no connection to the DM): ${data?.t}`); },
    reconnectNow(why) { if (destroyed || (conn && conn.open)) return; log(`reconnecting now (${why})`); cancelReconnect(); clearTimeout(attemptTimer); doReconnect(); },
    status() { log(`player peer: signaling ${peer?.disconnected ? 'DISCONNECTED' : peer?.destroyed ? 'destroyed' : peer ? 'connected' : 'none'} | DM channel ${conn?.open ? 'open' : 'closed'} | attempts=${connectNo} | messages sent=${sent} received=${received}`); },
    destroy() { destroyed = true; cancelReconnect(); clearTimeout(attemptTimer); stopHeartbeat(); try { peer?.destroy(); } catch { } peer = null; conn = null; },
  };
}

// ---------- constants & helpers ----------
const LS_CAMPAIGNS = 'vttrpg:campaigns';       // DM side: all campaigns (localStorage for the skeleton)
const LS_NAME = 'vttrpg:playerName';           // player side: last used name
const SS_TOKEN = 'vttrpg:playerToken';         // player side: per-TAB identity so several tabs can be tested on one computer
const LS_TURN = 'vttrpg:turn';                 // DM side: optional TURN relay settings

const rid = (n = 12) => {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map(b => (b % 36).toString(36)).join('');
};

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

// ---------- storage (DM) ----------
const loadAll = () => { try { return JSON.parse(localStorage.getItem(LS_CAMPAIGNS)) || {}; } catch { return {}; } };
function saveCampaign(c) {
  try { const all = loadAll(); all[c.id] = c; localStorage.setItem(LS_CAMPAIGNS, JSON.stringify(all)); }
  catch (e) { alert('Could not save (storage full?): ' + e.message); }
}
function deleteCampaign(id) { const all = loadAll(); delete all[id]; localStorage.setItem(LS_CAMPAIGNS, JSON.stringify(all)); }

// ---------- small UI parts ----------
// Log box with toolbar: copy / clear / "log status now"
function makeLog(role, onStatus) {
  const pre = h('pre', { class: 'log' });
  const log = s => {
    pre.textContent += `${new Date().toISOString().slice(11, 23)}  ${s}\n`;
    pre.scrollTop = pre.scrollHeight; console.log(`[vttrpg ${role}]`, s);
  };
  const toolbar = h('div', { class: 'row' },
    onStatus ? h('button', { onclick: () => onStatus() }, 'Log status now') : null,
    h('button', { onclick: async () => { try { await navigator.clipboard.writeText(`VTTRPG v${APP_VERSION} (${role})\n` + pre.textContent); log('log copied to clipboard'); } catch (e) { log('copy failed: ' + e.message); } } }, 'Copy log'),
    h('button', { onclick: () => { pre.textContent = ''; } }, 'Clear'));
  activeLog = log;
  log(`VTTRPG v${APP_VERSION} ${role} view started; page ${location.pathname}`);
  log(`env: online=${navigator.onLine} secureContext=${isSecureContext} RTCPeerConnection=${typeof RTCPeerConnection !== 'undefined'} PeerJS=${window.Peer ? 'loaded' : 'MISSING'}`);
  log(`browser: ${navigator.userAgent}`);
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
  if (cleanup) { cleanup(); cleanup = null; }
  activeLog = null;
  $app.replaceChildren();
  const [hash, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  let m;
  if ((m = hash.match(/^\/join\/([a-z0-9]+)$/))) return viewPlayer(m[1], parseOpts(query));
  if ((m = hash.match(/^\/dm\/([a-z0-9]+)$/))) return viewDM(m[1]);
  viewHome();
}
addEventListener('hashchange', route);
route();

// ---------- HOME ----------
function viewHome() {
  const nameIn = h('input', { placeholder: 'New campaign name' });
  const listEl = h('div');
  const create = () => {
    const name = nameIn.value.trim(); if (!name) return;
    const c = { id: rid(10), name, created: Date.now(), nextNum: 1, players: {}, chat: [] };
    saveCampaign(c); location.hash = '#/dm/' + c.id;
  };
  const fileIn = h('input', {
    type: 'file', accept: 'application/json', onchange: async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const c = JSON.parse(await f.text());
        if (!c.id || !c.name || !Array.isArray(c.chat) || typeof c.players !== 'object') throw new Error('not a campaign file');
        if (loadAll()[c.id] && !confirm('A campaign with this ID exists. Overwrite?')) return;
        saveCampaign(c); renderList();
      } catch (err) { alert('Import failed: ' + err.message); }
      e.target.value = '';
    }
  });
  function renderList() {
    const all = Object.values(loadAll());
    listEl.replaceChildren(...(all.length ? all.map(c => h('div', { class: 'row' },
      h('b', {}, c.name),
      h('span', { class: 'muted' }, `${Object.keys(c.players).length} players, ${c.chat.length} messages`),
      h('button', { onclick: () => location.hash = '#/dm/' + c.id }, 'Open as DM'),
      h('button', { onclick: () => { if (confirm(`Delete "${c.name}" from this browser?`)) { deleteCampaign(c.id); renderList(); } } }, 'Delete')
    )) : [h('div', { class: 'muted' }, 'No campaigns in this browser yet.')]));
  }
  renderList();
  $app.append(
    h('section', {}, h('h2', {}, 'Create campaign (you become the DM)'), h('div', { class: 'row' }, nameIn, h('button', { onclick: create }, 'Create'))),
    h('section', {}, h('h2', {}, 'Your campaigns (stored in this browser only)'), listEl,
      h('div', { class: 'muted' }, 'Import a campaign file: '), fileIn),
    h('section', { class: 'muted' }, 'Players: you do not need anything here. Open the join link the DM sent you and enter the PIN.')
  );
}

// ---------- DM ----------
function viewDM(cid) {
  const camp = loadAll()[cid];
  if (!camp) { location.hash = '#/'; return; }
  const save = () => saveCampaign(camp);
  const { el: logEl, log } = makeLog('DM', () => dmPeer ? dmPeer.status() : log('no active session'));
  log(`campaign "${camp.name}" (${cid}) loaded from localStorage: ${Object.keys(camp.players).length} known players, ${camp.chat.length} chat messages`);
  const chat = makeChat(text => postChat({ from: 'DM', text }));
  camp.chat.slice(-100).forEach(chat.add);

  let dmPeer = null, session = null, opening = false;
  const peers = new Map();       // playerPeerId -> {token, name, status:'pending'|'approved', num}
  const badPins = new Map();     // playerPeerId -> wrong PIN count

  const modeSel = h('select', { onchange: () => { if (session) session.mode = modeSel.value; log('join mode -> ' + modeSel.value); } },
    h('option', { value: 'approval' }, 'Approval required'),
    h('option', { value: 'open' }, 'Open (auto-approve)'),
    h('option', { value: 'locked' }, 'Locked (only known players)'));
  const pinIn = h('input', { value: camp.pin || rid(4).toUpperCase(), maxlength: '12', size: '8', title: '3-12 letters or digits' });
  const toggleBtn = h('button', { onclick: () => session ? closeSession() : openSession() }, 'Open session');
  const sigEl = h('span', { class: 'tag' }, 'no session');
  const linkIn = h('input', { readonly: '', placeholder: 'Open the session to see the link (it stays the same for this campaign)' });
  const copyBtn = h('button', { onclick: () => { linkIn.select(); navigator.clipboard?.writeText(linkIn.value); log('join link copied'); } }, 'Copy link');
  const lobbyEl = h('div'), playersEl = h('div');
  const qrEl = h('div');
  const savedTurn = (() => { try { return JSON.parse(localStorage.getItem(LS_TURN)) || {}; } catch { return {}; } })();
  const turnUrls = h('input', { placeholder: 'turn:host:3478, turns:host:443?transport=tcp', value: savedTurn.urls || '' });
  const turnUser = h('input', { placeholder: 'username', value: savedTurn.username || '' });
  const turnCred = h('input', { placeholder: 'credential', value: savedTurn.credential || '' });
  const relayChk = h('input', { type: 'checkbox' });
  const readTurn = () => {
    localStorage.setItem(LS_TURN, JSON.stringify({ urls: turnUrls.value, username: turnUser.value, credential: turnCred.value }));
    const urls = turnUrls.value.split(',').map(s => s.trim()).filter(Boolean);
    return urls.length ? { urls, username: turnUser.value.trim(), credential: turnCred.value.trim() } : null;
  };
  chat.setEnabled(false);

  // Checks the TURN credentials on their own: asks the server for a relay address. No second device needed.
  const turnTestEl = h('span', { class: 'muted' });
  const testTurn = async () => {
    const turn = readTurn();
    if (!turn) { turnTestEl.textContent = 'Enter TURN URL, username and credential first.'; return; }
    turnTestEl.textContent = 'testing… (up to 10 s)'; log(`TURN test: asking ${turn.urls.join(', ')} for a relay address…`);
    const pc = new RTCPeerConnection({ iceServers: [turn], iceTransportPolicy: 'relay' });
    pc.createDataChannel('turn-test');
    let found = false, lastErr = '';
    const finish = (ok, msg) => { try { pc.close(); } catch { } turnTestEl.textContent = (ok ? 'OK: ' : 'FAILED: ') + msg; log('TURN test ' + (ok ? 'OK' : 'FAILED') + ': ' + msg); };
    const timer = setTimeout(() => { if (!found) finish(false, 'no relay address received' + (lastErr ? ` (last error: ${lastErr})` : '') + '. Check URL, username, credential, or the server is blocked on this network.'); }, 10000);
    pc.addEventListener('icecandidate', e => { if (!found && e.candidate && / typ relay /.test(e.candidate.candidate)) { found = true; clearTimeout(timer); finish(true, 'the TURN server issued a relay address, so URL and credentials work.'); } });
    pc.addEventListener('icecandidateerror', e => { lastErr = `${e.errorCode || ''} ${e.errorText || ''}`.trim(); });
    try { await pc.setLocalDescription(await pc.createOffer()); } catch (e) { clearTimeout(timer); finish(false, e.message); }
  };

  const sendTo = (data, pid) => dmPeer?.send(data, pid);
  const approvedPids = () => [...peers].filter(([, p]) => p.status === 'approved').map(([pid]) => pid);
  const isOnline = tok => [...peers.values()].some(p => p.token === tok && p.status === 'approved');
  const roster = () => Object.values(camp.players).filter(p => !p.banned)
    .map(p => ({ num: p.num, name: p.name, online: [...peers.values()].some(x => x.num === p.num && x.status === 'approved') }));
  const broadcastRoster = () => approvedPids().forEach(pid => sendTo({ t: 'roster', roster: roster() }, pid));

  async function openSession() {
    if (opening || session) return;
    const pin = pinIn.value.trim();
    if (!/^[a-zA-Z0-9]{3,12}$/.test(pin)) { alert('The PIN must be 3 to 12 letters or digits.'); return; }
    opening = true; toggleBtn.disabled = true; sigEl.textContent = 'connecting…';
    if (!camp.roomId) { camp.roomId = rid(14); log('created a permanent room id for this campaign: ' + camp.roomId); }
    camp.pin = pin; save();
    const turn = readTurn(), relayOnly = relayChk.checked;
    log(`opening session: mode=${modeSel.value}, room=${camp.roomId}, PIN set`);
    const p = createDMPeer(camp.roomId, {
      log, turn, relayOnly,
      onPlayerConnect: pid => log('player connected ' + short(pid) + ' – waiting for its join request'),
      onPlayerDisconnect: pid => {
        badPins.delete(pid);
        const pl = peers.get(pid);
        if (pl) { log(`${pl.name} (${pl.status}) left`); peers.delete(pid); if (pl.status === 'approved') systemMsg(`${pl.name} (Player ${pl.num}) disconnected`); renderPeople(); broadcastRoster(); }
        else log(`peer ${short(pid)} left (had not been admitted)`);
      },
      onMessage: (m, pid) => onMsg(m, pid),
      onSignaling: s => { sigEl.textContent = s === 'connected' ? 'signaling OK' : 'signaling lost, reconnecting…'; },
    });
    try { await p.init(); }
    catch (e) { log('COULD NOT OPEN SESSION: ' + e.message); p.destroy(); opening = false; toggleBtn.disabled = false; sigEl.textContent = 'failed'; return; }
    dmPeer = p; session = { pin, mode: modeSel.value }; opening = false; toggleBtn.disabled = false; pinIn.disabled = true;
    const qs = [turn ? 't=' + b64e(turn) : '', relayOnly ? 'r=1' : ''].filter(Boolean).join('&');
    linkIn.value = `${location.origin}${location.pathname}#/join/${camp.roomId}${qs ? '?' + qs : ''}`;
    if (turn) log('join link includes the custom TURN settings (anyone with the link can use that TURN account)');
    if (relayOnly) log('RELAY-ONLY test mode is on: both sides must connect through a TURN server');
    qrEl.replaceChildren();
    if (window.QRCode) new window.QRCode(qrEl, { text: linkIn.value, width: 220, height: 220 });
    else qrEl.append('QR code library could not be loaded. Use the link instead.');
    sigEl.textContent = 'signaling OK'; toggleBtn.textContent = 'Close session'; chat.setEnabled(true);
    log(`SESSION OPEN – players need the link and the PIN "${pin}". Waiting for players.`);
    renderPeople();
  }

  function closeSession() {
    if (!session) return;
    log(`closing session; notifying ${peers.size} connected player(s)`);
    [...peers.keys()].forEach(pid => sendTo({ t: 'closed' }, pid));
    const p = dmPeer; setTimeout(() => p?.destroy(), 400); // let 'closed' go out first
    peers.clear(); badPins.clear(); session = null; dmPeer = null; pinIn.disabled = false;
    linkIn.value = ''; toggleBtn.textContent = 'Open session'; chat.setEnabled(false); sigEl.textContent = 'no session';
    qrEl.replaceChildren();
    log('session closed (the link stays the same; reopening the session lets players reconnect automatically)'); renderPeople();
  }

  function onMsg(m, pid) {
    if (!m || typeof m !== 'object') { log(`ignored malformed message from ${short(pid)}`); return; }
    if (!session) { log(`ignored ${m.t} from ${short(pid)}: no open session`); return; }
    if (m.t === 'join') return handleJoin(m, pid);
    const p = peers.get(pid);
    if (!p || p.status !== 'approved') { log(`ignored ${m.t} from ${short(pid)}: not an approved player`); return; }
    if (m.t === 'chat') {
      const text = String(m.text || '').trim().slice(0, 500);
      if (text) { log(`chat from Player ${p.num}, relaying to ${approvedPids().length} player(s)`); postChat({ from: `${p.name} (P${p.num})`, text }); }
    } else log(`ignored unknown message type "${m.t}" from Player ${p.num}`);
  }

  function handleJoin(m, pid) {
    if (String(m.pin) !== session.pin) {
      const n = (badPins.get(pid) || 0) + 1; badPins.set(pid, n);
      log(`join request from ${short(pid)} with a WRONG PIN (${n}/5)`);
      sendTo({ t: 'badpin' }, pid);
      if (n >= 5) { log('too many wrong PINs – closing that connection'); setTimeout(() => dmPeer?.close(pid), 300); }
      return;
    }
    badPins.delete(pid);
    const token = String(m.token || '').slice(0, 64);
    const name = String(m.name || '').trim().slice(0, 30) || 'Player';
    if (!token) { log(`join request from ${short(pid)} without token – ignored`); return; }
    const rec = camp.players[token];
    log(`JOIN REQUEST from ${short(pid)} "${name}" token ${token.slice(0, 6)}…${rec ? ` (known: Player ${rec.num}${rec.banned ? ', BANNED' : ''})` : ' (new)'} – mode ${session.mode}`);
    if (rec?.banned) { log('-> denied (banned)'); return sendTo({ t: 'denied', reason: 'You are banned.' }, pid); }
    for (const [oid, o] of peers) if (o.token === token && oid !== pid) { log(`dropping stale connection ${short(oid)} of the same player`); peers.delete(oid); dmPeer?.close(oid); }
    if (rec) {                                          // known player: re-admit, keep number
      rec.name = name; save();
      const wasAlready = peers.get(pid)?.status === 'approved';
      peers.set(pid, { token, name, status: 'approved', num: rec.num });
      log(`-> re-admitted as Player ${rec.num}`);
      sendAccepted(pid); if (!wasAlready) systemMsg(`${name} (Player ${rec.num}) reconnected`); renderPeople(); broadcastRoster(); return;
    }
    if (peers.get(pid)?.status === 'pending') { log('-> still pending, re-sending "pending"'); return sendTo({ t: 'pending' }, pid); }
    if (session.mode === 'locked') { log('-> denied (session locked)'); return sendTo({ t: 'denied', reason: 'Session is locked.' }, pid); }
    peers.set(pid, { token, name, status: 'pending' });
    if (session.mode === 'open') { log('-> auto-approving (open mode)'); return approve(pid); }
    log('-> waiting for DM approval (see Lobby)');
    sendTo({ t: 'pending' }, pid); renderPeople();
  }

  function approve(pid) {
    const p = peers.get(pid); if (!p) return;
    const num = camp.nextNum++;
    camp.players[p.token] = { num, name: p.name, banned: false };
    p.status = 'approved'; p.num = num; save();
    log(`APPROVED ${p.name} as Player ${num}; saved to localStorage`);
    sendAccepted(pid); systemMsg(`${p.name} joined as Player ${num}`); renderPeople(); broadcastRoster();
  }
  const sendAccepted = pid => {
    const p = peers.get(pid), history = camp.chat.slice(-50);
    log(`sending accepted + ${history.length} history message(s) to Player ${p.num}`);
    sendTo({ t: 'accepted', num: p.num, name: p.name, campaignName: camp.name, history, roster: roster() }, pid);
  };
  function deny(pid) { log(`DENIED ${peers.get(pid)?.name}`); sendTo({ t: 'denied', reason: 'The DM declined your request.' }, pid); peers.delete(pid); setTimeout(() => dmPeer?.close(pid), 300); renderPeople(); }
  function kick(token, ban) {
    const pid = [...peers].find(([, p]) => p.token === token)?.[0];
    if (pid) { sendTo({ t: 'kicked', ban }, pid); peers.delete(pid); setTimeout(() => dmPeer?.close(pid), 300); }
    if (ban && camp.players[token]) { camp.players[token].banned = true; save(); }
    log(`${ban ? 'BANNED' : 'KICKED'} token ${token.slice(0, 6)}… (was ${pid ? 'online' : 'offline'})`); renderPeople(); broadcastRoster();
  }
  function unban(token) { camp.players[token].banned = false; save(); log('unbanned token ' + token.slice(0, 6) + '…'); renderPeople(); }

  function systemMsg(text) { postChat({ sys: true, text }); }
  function postChat(partial) {
    const msg = { id: rid(8), ts: Date.now(), ...partial };
    camp.chat.push(msg); if (camp.chat.length > 1000) camp.chat.splice(0, camp.chat.length - 1000);
    save(); chat.add(msg);
    approvedPids().forEach(pid => sendTo({ t: 'chat', msg }, pid));
  }

  function renderPeople() {
    const pending = [...peers].filter(([, p]) => p.status === 'pending');
    lobbyEl.replaceChildren(...(pending.length ? pending.map(([pid, p]) => h('div', { class: 'row' },
      h('b', {}, p.name), h('span', { class: 'muted' }, 'wants to join'),
      h('button', { onclick: () => approve(pid) }, 'Approve'), h('button', { onclick: () => deny(pid) }, 'Deny')))
      : [h('div', { class: 'muted' }, 'Nobody waiting.')]));
    const known = Object.entries(camp.players);
    playersEl.replaceChildren(...(known.length ? known.map(([tok, p]) => h('div', { class: 'row' },
      h('b', {}, `Player ${p.num}: ${p.name}`),
      h('span', { class: 'tag' }, p.banned ? 'banned' : isOnline(tok) ? 'online' : 'offline'),
      p.banned ? h('button', { onclick: () => unban(tok) }, 'Unban') : [
        isOnline(tok) ? h('button', { onclick: () => kick(tok, false) }, 'Kick') : null,
        h('button', { onclick: () => kick(tok, true) }, 'Ban')]))
      : [h('div', { class: 'muted' }, 'No players yet.')]));
  }

  function exportCampaign() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(camp, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `${camp.name.replace(/[^\w-]+/g, '_')}.vttrpg.json` });
    document.body.append(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    log('campaign exported to file');
  }

  renderPeople();
  $app.append(
    h('div', { class: 'row' }, h('a', { href: '#/' }, '← Campaigns'), h('b', {}, `DM view: ${camp.name}`),
      h('button', { onclick: exportCampaign }, 'Export to file')),
    h('section', {}, h('h2', {}, 'Session'),
      h('div', { class: 'row' }, 'Join mode:', modeSel, 'PIN:', pinIn, toggleBtn, sigEl), h('div', { class: 'row' }, linkIn, copyBtn), qrEl,
      h('div', { class: 'muted' }, 'Players open the link, enter a name and this PIN. The link stays the same for the campaign; the PIN is per session. Keep this tab open and in the foreground while playing. PeerJS only introduces the browsers; chat and game data use the direct WebRTC channel.')),
    h('section', {}, h('h2', {}, 'TURN relay (optional) and relay test'),
      h('div', { class: 'row' }, turnUrls, turnUser, turnCred),
      h('div', { class: 'row' }, h('button', { onclick: testTurn }, 'Test TURN credentials'), turnTestEl),
      h('div', { class: 'row' }, relayChk, 'Relay-only test: force all traffic through TURN (if this connects, TURN works; if not, TURN is unreachable). Applies to the next session you open.'),
      h('div', { class: 'muted' }, 'Without a TURN server only direct connections work (PeerJS discontinued its free TURN in 2023). Get free credentials from a TURN provider, paste them above and press the test button. They are saved in this browser and added to the join link (open the session again and copy the NEW link).')),
    h('section', {}, h('h2', {}, 'Lobby (waiting for approval)'), lobbyEl),
    h('section', {}, h('h2', {}, 'Players of this campaign'), playersEl),
    h('section', {}, h('h2', {}, 'Chat (stored in this browser)'), chat.el),
    h('section', {}, h('h2', {}, 'Connection log'), logEl)
  );
  cleanup = () => { dmPeer?.destroy(); dmPeer = null; };
}

// ---------- PLAYER ----------
function viewPlayer(roomId, opts = {}) {
  let token = sessionStorage.getItem(SS_TOKEN);
  const newToken = !token;
  if (!token) { token = rid(24); sessionStorage.setItem(SS_TOKEN, token); }
  let peer = null, state = 'idle', joinTimer = null, wantJoin = false, t0 = 0;
  const { el: logEl, log } = makeLog('Player', () => peer ? peer.status() : log('not connected yet'));
  log(`link: room ${roomId}; identity token ${token.slice(0, 6)}… (${newToken ? 'new for this tab' : 'kept from earlier in this tab'})`);
  const statusEl = h('div', { class: 'status' }, 'Enter your name and the PIN, then join.');
  const rosterEl = h('div', { class: 'muted' });
  const nameIn = h('input', { value: localStorage.getItem(LS_NAME) || '', placeholder: 'Your name', maxlength: '30' });
  const pinIn = h('input', { placeholder: 'PIN', maxlength: '12', size: '8' });
  const joinBtn = h('button', { onclick: () => join() }, 'Join');
  const chat = makeChat(text => { if (state === 'accepted') peer.send({ t: 'chat', text }); });
  chat.setEnabled(false);

  const setState = (s, text) => { if (s !== state) log(`state: ${state} -> ${s} | ${text}`); state = s; statusEl.textContent = text; chat.setEnabled(s === 'accepted'); };
  const unlockForm = () => { joinBtn.disabled = nameIn.disabled = pinIn.disabled = false; };
  const stopPeer = () => { clearTimeout(joinTimer); peer?.destroy(); peer = null; wantJoin = false; };

  function sendJoin() {
    peer.send({ t: 'join', pin: pinIn.value.trim(), token, name: nameIn.value.trim() || 'Player' });
    clearTimeout(joinTimer);
    joinTimer = setTimeout(() => {
      if (state === 'joining') { log(`no reply from the DM ${JOIN_REPLY_TIMEOUT_MS / 1000} s after the join request`); setState('joining', 'No response from the DM yet. Check that the session is open. Still waiting…'); }
    }, JOIN_REPLY_TIMEOUT_MS);
  }

  function join() {
    const name = nameIn.value.trim(), pin = pinIn.value.trim();
    if (!name) { nameIn.focus(); return; }
    if (!pin) { pinIn.focus(); return; }
    localStorage.setItem(LS_NAME, name); joinBtn.disabled = nameIn.disabled = pinIn.disabled = true; wantJoin = true; t0 = performance.now();
    log(`Join clicked as "${name}"`);
    if (peer?.isConnected()) { setState('joining', 'Asking the DM to let you in…'); sendJoin(); return; }
    if (peer) return;
    setState('connecting', 'Connecting to the DM… (retries automatically)');
    peer = createPlayerPeer(roomId, {
      log, turn: opts.turn, relayOnly: opts.relayOnly,
      onConnect: () => { if (wantJoin) { setState('joining', 'Connected. Asking the DM to let you in…'); sendJoin(); } },
      onDisconnect: () => { if (state === 'accepted' || state === 'pending') setState('connecting', 'Connection to the DM lost. Reconnecting…'); },
      onReconnecting: (n, delay) => { if (['connecting', 'joining'].includes(state)) setState('connecting', `Could not reach the DM yet (retry ${n}, next try in ${Math.round(delay / 1000)} s). Is the session open? See the log.`); },
      onMessage: m => onMsg(m),
    });
    peer.start();
  }

  function onMsg(m) {
    if (!m || typeof m !== 'object') { log('ignored malformed message'); return; }
    switch (m.t) {
      case 'pending': clearTimeout(joinTimer); setState('pending', 'Waiting for the DM to approve you…'); break;
      case 'accepted':
        clearTimeout(joinTimer); chat.clear(); (m.history || []).forEach(chat.add); renderRoster(m.roster);
        log(`ACCEPTED as Player ${m.num}; received ${(m.history || []).length} history message(s); ${Math.round((performance.now() - t0) / 1000)} s since Join`);
        setState('accepted', `Joined "${m.campaignName}" as Player ${m.num} (${m.name})`); break;
      case 'badpin': clearTimeout(joinTimer); setState('badpin', 'Wrong PIN. Check it and try again.'); unlockForm(); pinIn.focus(); break;
      case 'denied': setState('denied', 'Not admitted: ' + (m.reason || 'denied')); stopPeer(); unlockForm(); break;
      case 'kicked': setState('kicked', m.ban ? 'You were banned by the DM.' : 'You were kicked by the DM.'); stopPeer(); unlockForm(); break;
      case 'closed': clearTimeout(joinTimer); setState('closed', 'The DM closed the session. Waiting for it to reopen (reconnecting automatically)…'); break;
      case 'chat': chat.add(m.msg); break;
      case 'roster': renderRoster(m.roster); log(`roster update: ${(m.roster || []).length} player(s)`); break;
      default: log(`unknown message type "${m.t}"`);
    }
  }

  function renderRoster(r = []) {
    rosterEl.textContent = 'In session: ' + r.map(p => `P${p.num} ${p.name}${p.online ? '' : ' (offline)'}`).join(', ');
  }

  // as in the reference: retry when the tab comes back to the foreground (phone backgrounding) or the network returns
  const onVisible = () => { if (document.visibilityState === 'visible' && peer && wantJoin) peer.reconnectNow('tab visible'); };
  const onOnline = () => { if (peer && wantJoin) peer.reconnectNow('network online'); };
  document.addEventListener('visibilitychange', onVisible); addEventListener('online', onOnline);

  $app.append(
    h('section', {}, h('h2', {}, 'Join session'), h('div', { class: 'row' }, nameIn, pinIn, joinBtn), statusEl, rosterEl),
    h('section', {}, h('h2', {}, 'Chat'), chat.el),
    h('section', {}, h('h2', {}, 'Connection log'), logEl)
  );
  cleanup = () => { document.removeEventListener('visibilitychange', onVisible); removeEventListener('online', onOnline); stopPeer(); };
}
