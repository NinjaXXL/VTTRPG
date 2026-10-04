// VTTRPG skeleton: DM-hosted, browser-only, WebRTC via Trystero.
// The DM's browser is the authority. Players only talk to the DM (chat is relayed by the DM).

const APP_VERSION = '0.4.2';
const APP_ID = 'vttrpg-skeleton-v2';              // namespace for the signaling relays (not secret)
const TRYSTERO_VERSION = '0.26.0';                // pinned: the API changed a lot between releases

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

// Log every WebRTC connection attempt (ICE servers, candidate types, state changes).
// This shows WHY a direct connection fails: no srflx = STUN blocked; srflx on both sides but still failing = strict NAT -> needs TURN.
if (window.RTCPeerConnection && !window.__vttrpgPcPatched) {
  window.__vttrpgPcPatched = true;
  const NativePC = window.RTCPeerConnection; let pcCount = 0;
  window.RTCPeerConnection = class extends NativePC {
    constructor(cfg, ...rest) {
      super(cfg, ...rest);
      const id = ++pcCount, L = m => activeLog?.(`rtc#${id}: ${m}`);
      const kinds = {};
      (cfg?.iceServers || []).flatMap(s => [].concat(s.urls || [])).forEach(u => { const k = String(u).split(':')[0]; kinds[k] = (kinds[k] || 0) + 1; });
      L(`new connection; ICE servers: ${JSON.stringify(kinds)}${cfg?.iceTransportPolicy ? ', policy=' + cfg.iceTransportPolicy : ''}`);
      const cand = {};
      this.addEventListener('icecandidate', e => {
        if (e.candidate) { const t = / typ (\w+)/.exec(e.candidate.candidate)?.[1] || '?'; const k = `${t}/${e.candidate.protocol || '?'}`; cand[k] = (cand[k] || 0) + 1; }
        else L(`ICE gathering finished; local candidates: ${JSON.stringify(cand)}`);
      });
      this.addEventListener('icecandidateerror', e => L(`ICE candidate error ${e.errorCode || ''} ${e.url || ''} ${e.errorText || ''}`));
      this.addEventListener('iceconnectionstatechange', () => {
        L(`ice=${this.iceConnectionState}`);
        if (this.iceConnectionState === 'checking') [3000, 8000, 12000].forEach(t => setTimeout(() => { if (this.iceConnectionState === 'checking') summarize(`in-flight @${t / 1000}s`); }, t));
      });
      this.addEventListener('connectionstatechange', () => { L(`conn=${this.connectionState}`); if (this.connectionState === 'failed') summarize(); });
      // what the OTHER side offered (candidate types only, no addresses are logged)
      const remote = {};
      const countRemote = c => { const t = / typ (\w+)/.exec(c || '')?.[1]; if (t) remote[t] = (remote[t] || 0) + 1; };
      const origSRD = this.setRemoteDescription.bind(this);
      this.setRemoteDescription = d => {
        (d?.sdp || '').split('\n').filter(l => l.startsWith('a=candidate')).forEach(countRemote);
        L(`remote ${d?.type} set; remote candidates so far: ${JSON.stringify(remote)}`);
        return origSRD(d);
      };
      const origAIC = this.addIceCandidate.bind(this);
      this.addIceCandidate = c => {
        countRemote(c?.candidate);
        const kind = c?.candidate ? `${/ typ (\w+)/.exec(c.candidate)?.[1]}${/ [0-9a-f-]+\.local /.test(c.candidate) ? ' (mDNS name)' : ''}` : 'end-of-candidates';
        L(`addIceCandidate ${kind}; signaling=${this.signalingState}, remoteDescription=${this.remoteDescription ? 'set' : 'NOT SET'}`);
        return origAIC(c).then(r => r, e => { L(`addIceCandidate REJECTED: ${e.name}: ${e.message}`); throw e; });
      };
      const summarize = async (label = 'FAILURE SUMMARY') => {
        try {
          const st = await this.getStats(); const lines = [];
          st.forEach(r => { if (r.type === 'candidate-pair') { const l = st.get(r.localCandidateId), q = st.get(r.remoteCandidateId); lines.push(`${r.state} ${l?.candidateType}->${q?.candidateType} checks sent/answered ${r.requestsSent || 0}/${r.responsesReceived || 0}`); } });
          L(`${label}: ${lines.length} candidate pair(s) [${lines.join('; ')}]; remote candidates seen ${JSON.stringify(remote)}; connectionState=${this.connectionState}`);
        } catch (e) { L('stats error: ' + e.message); }
      };
    }
  };
}
const footer = document.getElementById('version');
if (footer) footer.textContent = `VTTRPG skeleton v${APP_VERSION} · Trystero ${TRYSTERO_VERSION}`;

// ---------- networking layer (the only place that knows about Trystero) ----------
const STRATEGIES = {                              // how peers find each other (signaling only, no game data)
  mqtt:    { pkg: '@trystero-p2p/mqtt',    label: 'MQTT brokers (default)' },
  torrent: { pkg: '@trystero-p2p/torrent', label: 'BitTorrent trackers' },
  nostr:   { pkg: '@trystero-p2p/nostr',   label: 'Nostr relays' },
};
const DEFAULT_STRATEGY = 'mqtt';
const CDNS = [pkgAtVer => `https://esm.run/${pkgAtVer}`, pkgAtVer => `https://esm.sh/${pkgAtVer}`];
const short = id => String(id).slice(0, 6);

async function loadStrategy(name, log) {
  const pkgAtVer = `${STRATEGIES[name].pkg}@${TRYSTERO_VERSION}`;
  for (const mk of CDNS) {
    const url = mk(pkgAtVer), t = performance.now();
    log(`loading library: ${url}`);
    try { const mod = await import(url); log(`library loaded in ${Math.round(performance.now() - t)} ms`); return mod; }
    catch (e) { log(`library load FAILED after ${Math.round(performance.now() - t)} ms: ${e.message}`); }
  }
  throw new Error('Could not load the networking library for strategy ' + name);
}

async function candidateInfo(pc) {                // which network path is used? host/srflx = direct, relay = TURN
  try {
    const stats = await pc.getStats(); let pair;
    stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
    if (!pair) stats.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    if (!pair) return 'no selected pair yet';
    const l = stats.get(pair.localCandidateId), r = stats.get(pair.remoteCandidateId);
    return `local ${l?.candidateType}/${l?.protocol}  remote ${r?.candidateType}/${r?.protocol}`;
  } catch (e) { return 'stats error: ' + e.message; }
}

// Returns { send(data, targetPeerId?), leave(), status() }
async function connect(strategy, roomId, secret, { log, onJoin, onLeave, onMessage, turn }) {
  const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
  let tx = 0, rx = 0;
  log(`env: online=${navigator.onLine} secureContext=${isSecureContext} RTCPeerConnection=${typeof RTCPeerConnection !== 'undefined'}`);
  log(`browser: ${navigator.userAgent}`);
  log(`strategy "${strategy}", Trystero ${TRYSTERO_VERSION}`);
  const mod = await loadStrategy(strategy, log);
  log(`library ready after ${ms()} ms (exports: ${Object.keys(mod).join(', ')})`);
  log(`joining room ${short(roomId)}… appId=${APP_ID}, handshake encrypted with the link secret`);
  log(turn ? `TURN relay configured: ${turn.urls.join(', ')}` : 'no TURN relay configured (STUN only: direct connections only)');
  const room = mod.joinRoom({ appId: APP_ID, password: secret, ...(turn ? { turnConfig: [turn] } : {}) }, roomId, {
    onJoinError: d => log('JOIN ERROR: ' + safeStr(d)),
  });
  log(`joinRoom() returned after ${ms()} ms`);
  const action = room.makeAction('msg');

  const relayStates = () => {
    try {
      const socks = mod.getRelaySockets?.() || {};
      const names = ['connecting', 'open', 'closing', 'closed'];
      const list = Object.entries(socks).map(([u, s]) => {
        const st = s.readyState !== undefined ? names[s.readyState] : (s.connected ? 'open' : 'not connected');
        return `${u.replace(/^wss?:\/\//, '')}=${st}`;
      });
      return list.length ? list.join('  ') : '(no relay sockets)';
    } catch (e) { return 'relay state unavailable: ' + e.message; }
  };
  const peerStates = () => {
    try {
      const peers = room.getPeers?.() || {}, ids = Object.keys(peers);
      if (!ids.length) return 'no peers connected';
      return ids.map(id => { const pc = peers[id]; return `${short(id)}[conn=${pc?.connectionState},ice=${pc?.iceConnectionState}]`; }).join(' ');
    } catch (e) { return 'peer state unavailable: ' + e.message; }
  };
  const status = () => `relays: ${relayStates()} | peers: ${peerStates()} | msgs sent=${tx} received=${rx} | up ${Math.round(ms() / 1000)}s`;

  function watchPeer(pid) {
    const pc = room.getPeers?.()[pid];
    if (!pc?.addEventListener) { log(`(no RTCPeerConnection handle for ${short(pid)})`); return; }
    for (const ev of ['connectionstatechange', 'iceconnectionstatechange'])
      pc.addEventListener(ev, () => log(`${short(pid)} ${ev}: conn=${pc.connectionState} ice=${pc.iceConnectionState}`));
    log(`${short(pid)} state: conn=${pc.connectionState} ice=${pc.iceConnectionState}`);
    candidateInfo(pc).then(s => log(`${short(pid)} network path: ${s}`));
    Promise.resolve(room.ping?.(pid)).then(t => log(`${short(pid)} ping ${Math.round(t)} ms`)).catch(e => log(`${short(pid)} ping failed: ${e.message}`));
  }

  room.onPeerJoin = pid => { log(`room: peer JOINED ${short(pid)} (after ${ms()} ms)`); watchPeer(pid); onJoin(pid); };
  room.onPeerLeave = pid => { log(`room: peer LEFT ${short(pid)}`); onLeave(pid); };
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

// ---------- constants & helpers ----------
const LS_CAMPAIGNS = 'vttrpg:campaigns';       // DM side: all campaigns (localStorage for the skeleton)
const LS_NAME = 'vttrpg:playerName';           // player side: last used name
const SS_TOKEN = 'vttrpg:playerToken';         // player side: per-tab identity (sessionStorage => testable with several tabs)
const JOIN_TIMEOUT_MS = 25000;
const LS_TURN = 'vttrpg:turn';               // DM side: optional TURN relay settings

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
// Log box with toolbar: copy / clear / (optional) "log status now"
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

// TURN settings travel inside the join link (URL hash, never sent to a server) as base64url JSON
const b64e = o => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64d = s => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
const parseTurn = q => {
  try {
    const t = new URLSearchParams(q).get('t'); if (!t) return null;
    const o = b64d(t);
    const urls = [].concat(o.urls || []).map(String).filter(u => /^(turns?|stuns?):/.test(u));
    return urls.length ? { urls, username: String(o.username || ''), credential: String(o.credential || '') } : null;
  } catch { return null; }
};

// ---------- router ----------
const $app = document.getElementById('app');
let cleanup = null;

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  activeLog = null;
  $app.replaceChildren();
  const [hash, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  let m;
  if ((m = hash.match(/^\/join\/([a-z0-9]+)\.([a-z0-9]+)(?:\.([a-z]+))?$/))) return viewPlayer(m[1], m[2], STRATEGIES[m[3]] ? m[3] : DEFAULT_STRATEGY, parseTurn(query));
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
    h('section', { class: 'muted' }, 'Players: you do not need anything here. Just open the join link the DM sent you.')
  );
}

// ---------- DM ----------
function viewDM(cid) {
  const camp = loadAll()[cid];
  if (!camp) { location.hash = '#/'; return; }
  const save = () => saveCampaign(camp);
  const { el: logEl, log } = makeLog('DM', () => conn ? conn.status() : log('no active session'));
  log(`campaign "${camp.name}" (${cid}) loaded from localStorage: ${Object.keys(camp.players).length} known players, ${camp.chat.length} chat messages`);
  const chat = makeChat(text => postChat({ from: 'DM', text }));
  camp.chat.slice(-100).forEach(chat.add);

  let conn = null, session = null, opening = false;
  const peers = new Map(); // peerId -> {token, name, status:'pending'|'approved', num}

  const modeSel = h('select', { onchange: () => { if (session) { session.mode = modeSel.value; } log('join mode -> ' + modeSel.value); } },
    h('option', { value: 'approval' }, 'Approval required'),
    h('option', { value: 'open' }, 'Open (auto-approve)'),
    h('option', { value: 'locked' }, 'Locked (only known players)'));
  const stratSel = h('select', {}, ...Object.entries(STRATEGIES).map(([k, v]) => h('option', { value: k }, v.label)));
  stratSel.value = DEFAULT_STRATEGY;
  const toggleBtn = h('button', { onclick: () => session ? closeSession() : openSession() }, 'Open session');
  const linkIn = h('input', { readonly: '', placeholder: 'Open the session to get a link' });
  const copyBtn = h('button', { onclick: () => { linkIn.select(); navigator.clipboard?.writeText(linkIn.value); log('join link copied'); } }, 'Copy link');
  const lobbyEl = h('div'), playersEl = h('div');
  const savedTurn = (() => { try { return JSON.parse(localStorage.getItem(LS_TURN)) || {}; } catch { return {}; } })();
  const turnUrls = h('input', { placeholder: 'turn:host:3478, turns:host:443?transport=tcp', value: savedTurn.urls || '' });
  const turnUser = h('input', { placeholder: 'username', value: savedTurn.username || '' });
  const turnCred = h('input', { placeholder: 'credential', value: savedTurn.credential || '' });
  const readTurn = () => {
    localStorage.setItem(LS_TURN, JSON.stringify({ urls: turnUrls.value, username: turnUser.value, credential: turnCred.value }));
    const urls = turnUrls.value.split(',').map(s => s.trim()).filter(Boolean);
    return urls.length ? { urls, username: turnUser.value.trim(), credential: turnCred.value.trim() } : null;
  };
  chat.setEnabled(false);

  const sendTo = (data, pid) => conn?.send(data, pid);
  const approvedPids = () => [...peers].filter(([, p]) => p.status === 'approved').map(([pid]) => pid);
  const isOnline = tok => [...peers.values()].some(p => p.token === tok && p.status === 'approved');
  const roster = () => Object.values(camp.players).filter(p => !p.banned)
    .map(p => ({ num: p.num, name: p.name, online: [...peers.values()].some(x => x.num === p.num && x.status === 'approved') }));
  const broadcastRoster = () => approvedPids().forEach(pid => sendTo({ t: 'roster', roster: roster() }, pid));

  async function openSession() {
    if (opening) return;
    opening = true; toggleBtn.disabled = stratSel.disabled = true;
    const strategy = stratSel.value;
    const s = { id: rid(12), secret: rid(16), mode: modeSel.value, strategy };
    const turn = readTurn();
    log(`opening session: mode=${s.mode}, strategy=${strategy}, room=${short(s.id)}`);
    try {
      conn = await connect(strategy, s.id, s.secret, {
        log, turn,
        onJoin: pid => log('peer connected ' + short(pid) + ' – waiting for its join request'),
        onLeave: pid => {
          const p = peers.get(pid);
          if (p) { log(`${p.name} (${p.status}) left`); peers.delete(pid); if (p.status === 'approved') systemMsg(`${p.name} (Player ${p.num}) disconnected`); renderPeople(); broadcastRoster(); }
          else log(`peer ${short(pid)} left (had not sent a join request)`);
        },
        onMessage: (m, pid) => onMsg(m, pid),
      });
    } catch (e) {
      log('COULD NOT OPEN SESSION: ' + e.message); opening = false; toggleBtn.disabled = stratSel.disabled = false; return;
    }
    session = s; opening = false; toggleBtn.disabled = false;
    linkIn.value = `${location.origin}${location.pathname}#/join/${s.id}.${s.secret}.${strategy}${turn ? '?t=' + b64e(turn) : ''}`;
    if (turn) log('join link includes the TURN settings (anyone with the link can use that TURN account)');
    toggleBtn.textContent = 'Close session'; chat.setEnabled(true);
    log('SESSION OPEN – share the link; waiting for players. Room ' + short(s.id));
    renderPeople();
  }

  function closeSession() {
    if (!session) return;
    log(`closing session; notifying ${peers.size} connected peer(s)`);
    [...peers.keys()].forEach(pid => sendTo({ t: 'closed' }, pid));
    const c = conn; setTimeout(() => c?.leave(), 400); // let 'closed' go out first
    peers.clear(); session = null; conn = null; stratSel.disabled = false;
    linkIn.value = ''; toggleBtn.textContent = 'Open session'; chat.setEnabled(false);
    log('session closed (old link is now dead)'); renderPeople();
  }

  function onMsg(m, pid) {
    if (!m || typeof m !== 'object') { log(`ignored malformed message from ${short(pid)}`); return; }
    if (!session) { log(`ignored ${m.t} from ${short(pid)}: no open session`); return; }
    if (m.t === 'join') return handleJoin(m, pid);
    const p = peers.get(pid);
    if (!p || p.status !== 'approved') { log(`ignored ${m.t} from ${short(pid)}: not an approved player`); return; }
    if (m.t === 'chat') {
      const text = String(m.text || '').trim().slice(0, 500);
      if (text) { log(`chat from Player ${p.num}, relaying to ${approvedPids().length} peer(s)`); postChat({ from: `${p.name} (P${p.num})`, text }); }
    } else log(`ignored unknown message type "${m.t}" from Player ${p.num}`);
  }

  function handleJoin(m, pid) {
    const token = String(m.token || '').slice(0, 64);
    const name = String(m.name || '').trim().slice(0, 30) || 'Player';
    if (!token) { log(`join request from ${short(pid)} without token – ignored`); return; }
    const rec = camp.players[token];
    log(`JOIN REQUEST from ${short(pid)} "${name}" token ${token.slice(0, 6)}…${rec ? ` (known: Player ${rec.num}${rec.banned ? ', BANNED' : ''})` : ' (new)'} – mode ${session.mode}`);
    if (rec?.banned) { log('-> denied (banned)'); return sendTo({ t: 'denied', reason: 'You are banned.' }, pid); }
    for (const [oid, o] of peers) if (o.token === token && oid !== pid) { log(`dropping stale connection ${short(oid)} of the same player`); peers.delete(oid); }
    if (rec) {                                          // known player: re-admit, keep number
      rec.name = name; save();
      peers.set(pid, { token, name, status: 'approved', num: rec.num });
      log(`-> re-admitted as Player ${rec.num}`);
      sendAccepted(pid); systemMsg(`${name} (Player ${rec.num}) reconnected`); renderPeople(); broadcastRoster(); return;
    }
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
  function deny(pid) { log(`DENIED ${peers.get(pid)?.name}`); sendTo({ t: 'denied', reason: 'The DM declined your request.' }, pid); peers.delete(pid); renderPeople(); }
  function kick(token, ban) {
    const pid = [...peers].find(([, p]) => p.token === token)?.[0];
    if (pid) { sendTo({ t: 'kicked', ban }, pid); peers.delete(pid); }
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
      h('div', { class: 'row' }, 'Join mode:', modeSel, 'Signaling:', stratSel, toggleBtn), h('div', { class: 'row' }, linkIn, copyBtn),
      h('div', { class: 'muted' }, 'Keep this tab open and in the foreground while playing. Closing the session kills the link. The signaling choice is stored in the link.')),
    h('section', {}, h('h2', {}, 'TURN relay (optional, needed when players cannot connect directly)'),
      h('div', { class: 'row' }, turnUrls, turnUser, turnCred),
      h('div', { class: 'muted' }, 'Get these from a TURN provider (see README). Saved in this browser and added to the join link when you open a session. Only relays encrypted traffic.')),
    h('section', {}, h('h2', {}, 'Lobby (waiting for approval)'), lobbyEl),
    h('section', {}, h('h2', {}, 'Players of this campaign'), playersEl),
    h('section', {}, h('h2', {}, 'Chat (stored in this browser)'), chat.el),
    h('section', {}, h('h2', {}, 'Connection log'), logEl)
  );
  cleanup = () => { conn?.leave(); conn = null; };
}

// ---------- PLAYER ----------
function viewPlayer(sid, secret, strategy, turn) {
  let token = sessionStorage.getItem(SS_TOKEN);
  const newToken = !token;
  if (!token) { token = rid(24); sessionStorage.setItem(SS_TOKEN, token); }
  const { el: logEl, log } = makeLog('Player', () => conn ? conn.status() : log('not connected yet'));
  log(`link: room ${short(sid)}, strategy ${strategy}; identity token ${token.slice(0, 6)}… (${newToken ? 'new for this tab' : 'kept from earlier in this tab'})`);
  const statusEl = h('div', { class: 'status' }, 'Enter a name and join.');
  const rosterEl = h('div', { class: 'muted' });
  const nameIn = h('input', { value: localStorage.getItem(LS_NAME) || '', placeholder: 'Your name', maxlength: '30' });
  const joinBtn = h('button', { onclick: () => join() }, 'Join');
  let conn = null, dmPid = null, state = 'idle', timer = null, left = false, t0 = 0;
  const chat = makeChat(text => { if (state === 'accepted' && dmPid) conn.send({ t: 'chat', text }, dmPid); });
  chat.setEnabled(false);

  const setState = (s, text) => { if (s !== state) log(`state: ${state} -> ${s} | ${text}`); state = s; statusEl.textContent = text; chat.setEnabled(s === 'accepted'); };
  const sendJoin = pid => { log('sending join request to ' + short(pid)); conn.send({ t: 'join', token, name: nameIn.value.trim() || 'Player' }, pid); };
  const leave = () => { left = true; conn?.leave(); };

  async function join() {
    const name = nameIn.value.trim(); if (!name) { nameIn.focus(); return; }
    localStorage.setItem(LS_NAME, name); joinBtn.disabled = nameIn.disabled = true; t0 = performance.now();
    log(`Join clicked as "${name}"`);
    setState('connecting', 'Connecting to the DM… (can take 5–20 s)');
    try {
      const c = await connect(strategy, sid, secret, {
        log, turn,
        onJoin: pid => {
          log('peer connected ' + short(pid));
          if (!dmPid && state !== 'denied' && state !== 'kicked' && conn) sendJoin(pid);
          else log(`not sending join request to ${short(pid)} (dmPid=${dmPid ? short(dmPid) : 'none'}, state=${state})`);
        },
        onLeave: pid => {
          if (pid === dmPid && !left) { log('the DM peer disconnected'); dmPid = null; if (state === 'accepted' || state === 'pending') setState('connecting', 'DM disconnected. Waiting for the DM to come back…'); }
          else log(`peer ${short(pid)} left (not the DM)`);
        },
        onMessage: (m, pid) => onMsg(m, pid),
      });
      if (left) { c.leave(); return; }
      conn = c;
    } catch (e) { log('COULD NOT START NETWORKING: ' + e.message); setState('error', 'Could not start networking: ' + e.message); return; }
    timer = setTimeout(() => {
      if (state === 'connecting') { log(`no DM answered after ${Math.round((performance.now() - t0) / 1000)} s – check relay states above / "Log status now"`); setState('connecting', 'No DM found yet. Is the session open and the link current? (still trying… see the log below)'); }
    }, JOIN_TIMEOUT_MS);
  }

  function onMsg(m, pid) {
    if (!m || typeof m !== 'object') { log(`ignored malformed message from ${short(pid)}`); return; }
    const handshake = ['pending', 'accepted', 'denied'].includes(m.t);
    if (!handshake && pid !== dmPid) { log(`ignored "${m.t}" from ${short(pid)} (not the DM)`); return; }
    if (dmPid && pid !== dmPid) { log(`ignored "${m.t}" from ${short(pid)} (DM is ${short(dmPid)})`); return; }
    switch (m.t) {
      case 'pending': dmPid = pid; log(`DM identified: ${short(pid)}`); setState('pending', 'Waiting for the DM to approve you…'); break;
      case 'accepted':
        dmPid = pid; clearTimeout(timer); chat.clear(); (m.history || []).forEach(chat.add); renderRoster(m.roster);
        log(`ACCEPTED as Player ${m.num}; received ${(m.history || []).length} history message(s); ${Math.round((performance.now() - t0) / 1000)} s since Join`);
        setState('accepted', `Joined "${m.campaignName}" as Player ${m.num} (${m.name})`); break;
      case 'denied': dmPid = pid; setState('denied', 'Not admitted: ' + (m.reason || 'denied')); leave(); break;
      case 'kicked': setState('kicked', m.ban ? 'You were banned by the DM.' : 'You were kicked by the DM.'); leave(); break;
      case 'closed': setState('closed', 'The DM closed the session.'); leave(); break;
      case 'chat': chat.add(m.msg); break;
      case 'roster': renderRoster(m.roster); log(`roster update: ${(m.roster || []).length} player(s)`); break;
      default: log(`unknown message type "${m.t}"`);
    }
  }

  function renderRoster(r = []) {
    rosterEl.textContent = 'In session: ' + r.map(p => `P${p.num} ${p.name}${p.online ? '' : ' (offline)'}`).join(', ');
  }

  $app.append(
    h('section', {}, h('h2', {}, 'Join session'), h('div', { class: 'row' }, nameIn, joinBtn), statusEl, rosterEl),
    h('section', {}, h('h2', {}, 'Chat'), chat.el),
    h('section', {}, h('h2', {}, 'Connection log'), logEl)
  );
  cleanup = () => { clearTimeout(timer); leave(); };
}
