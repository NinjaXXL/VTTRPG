// VTTRPG skeleton: DM-hosted, browser-only, WebRTC via PeerJS.
// The DM's browser is the authority. Players only talk to the DM (chat is relayed by the DM).

const APP_VERSION = '0.5.1';
const PEERJS_VERSION = '1.5.5';

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
        if (this.iceConnectionState === 'checking') [3000, 8000, 12000].forEach(t => setTimeout(() => { if (this.iceConnectionState === 'checking') summarize(`in-flight @${t / 1000}s`); }, t));
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

const short = id => String(id).slice(0, 6);

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

// PeerJS transport. The public cloud only introduces the browsers; campaign traffic stays on WebRTC data channels.
async function connectPeer(roomId, { log, onJoin, onLeave, onMessage, host = false, turn = null, relayOnly = false }) {
  if (!window.Peer) throw new Error('PeerJS could not be loaded. Check the network connection and reload.');
  const connections = new Map(); let sent = 0, received = 0, leaving = false, lastIce = 'n/a';
  // Same defaults as PeerJS 1.5.5 (Google STUN + PeerJS shared TURN), plus Cloudflare STUN and an optional custom TURN from the DM.
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  ];
  if (turn) iceServers.push(turn);
  log(`ICE servers: Google/Cloudflare STUN, PeerJS shared TURN (eu-0, us-0)${turn ? ', custom TURN ' + turn.urls.join(',') : ''}${relayOnly ? ' | RELAY-ONLY test mode (direct paths disabled)' : ''}`);
  log(`browser: ${navigator.userAgent}`);
  const peer = new window.Peer(host ? roomId : undefined, { debug: 0, config: { iceServers, sdpSemantics: 'unified-plan', ...(relayOnly ? { iceTransportPolicy: 'relay' } : {}) } });
  const waitForPeer = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out while registering the browser connection.')), 20000);
    peer.once('open', id => { clearTimeout(timer); resolve(id); });
    peer.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const bind = connection => {
    const pid = connection.peer;
    connection.on('open', () => { connections.set(pid, connection); log(`WebRTC data channel open: ${short(pid)}`); onJoin(pid); });
    connection.on('data', data => { received++; log(`← ${short(pid)} ${data?.t ?? typeof data}`); onMessage(data, pid); });
    connection.on('close', () => { if (connections.delete(pid)) { log(`peer left: ${short(pid)}`); onLeave(pid); } });
    connection.on('error', error => log(`connection error ${short(pid)}: ${error?.type || ''} ${safeStr(error)}`));
    connection.on('iceStateChanged', s => { lastIce = s; log(`${short(pid)} PeerJS ICE state: ${s}`); });
  };
  peer.on('connection', bind);
  peer.on('error', error => { if (!leaving) log(`PeerJS error (${error?.type || 'unknown'}): ` + safeStr(error)); });
  peer.on('disconnected', () => { if (!leaving) log('lost the connection to the PeerJS signaling server'); });
  const ownId = await waitForPeer();
  log(`PeerJS ready as ${short(ownId)}${host ? ' (DM host)' : ' (Player)'}`);
  if (!host) {
    const connection = peer.connect(roomId, { reliable: true, serialization: 'json' });
    bind(connection);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The DM did not answer within 25 s (last ICE state: ${lastIce}). Is the session still open? If ICE failed, the networks cannot connect directly: try a TURN server.`)), 25000);
      connection.once('open', () => { clearTimeout(timer); resolve(); });
      connection.once('error', error => { clearTimeout(timer); reject(error); });
    });
  }
  return {
    send(data, target) {
      const targets = target ? [connections.get(target)] : [...connections.values()];
      for (const connection of targets) if (connection?.open) { sent++; log(`→ ${short(connection.peer)} ${data?.t ?? typeof data}`); connection.send(data); }
    },
    status() { log(`PeerJS host=${short(ownId)} | peers=${connections.size} | messages sent=${sent} received=${received}`); },
    leave() { leaving = true; connections.clear(); peer.destroy(); },
  };
}

// ---------- constants & helpers ----------
const LS_CAMPAIGNS = 'vttrpg:campaigns';       // DM side: all campaigns (localStorage for the skeleton)
const LS_NAME = 'vttrpg:playerName';           // player side: last used name
const LS_TOKEN = 'vttrpg:playerToken';         // player side: one small persistent secret ID
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

// ---------- router ----------
const $app = document.getElementById('app');
let cleanup = null;

function route() {
  if (cleanup) { cleanup(); cleanup = null; }
  activeLog = null;
  $app.replaceChildren();
  const [hash, query = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
  let m;
  if ((m = hash.match(/^\/join\/([a-z0-9]+)\.([a-z0-9]+)$/))) return viewPlayer(m[1], m[2], parseOpts(query));
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
  const toggleBtn = h('button', { onclick: () => session ? closeSession() : openSession() }, 'Open session');
  const linkIn = h('input', { readonly: '', placeholder: 'Open the session to get a link' });
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

  const sendTo = (data, pid) => conn?.send(data, pid);
  const approvedPids = () => [...peers].filter(([, p]) => p.status === 'approved').map(([pid]) => pid);
  const isOnline = tok => [...peers.values()].some(p => p.token === tok && p.status === 'approved');
  const roster = () => Object.values(camp.players).filter(p => !p.banned)
    .map(p => ({ num: p.num, name: p.name, online: [...peers.values()].some(x => x.num === p.num && x.status === 'approved') }));
  const broadcastRoster = () => approvedPids().forEach(pid => sendTo({ t: 'roster', roster: roster() }, pid));

  async function openSession() {
    if (opening) return;
    opening = true; toggleBtn.disabled = true;
    const s = { id: rid(20), secret: rid(24), mode: modeSel.value };
    const turn = readTurn(), relayOnly = relayChk.checked;
    log(`opening PeerJS session: mode=${s.mode}, host=${short(s.id)}`);
    try {
      conn = await connectPeer(s.id, {
        log, host: true, turn, relayOnly,
        onJoin: pid => log('peer connected ' + short(pid) + ' – waiting for its join request'),
        onLeave: pid => {
          const p = peers.get(pid);
          if (p) { log(`${p.name} (${p.status}) left`); peers.delete(pid); if (p.status === 'approved') systemMsg(`${p.name} (Player ${p.num}) disconnected`); renderPeople(); broadcastRoster(); }
          else log(`peer ${short(pid)} left (had not sent a join request)`);
        },
        onMessage: (m, pid) => onMsg(m, pid),
      });
    } catch (e) {
      log('COULD NOT OPEN SESSION: ' + e.message); opening = false; toggleBtn.disabled = false; return;
    }
    session = s; opening = false; toggleBtn.disabled = false;
    const qs = [turn ? 't=' + b64e(turn) : '', relayOnly ? 'r=1' : ''].filter(Boolean).join('&');
    linkIn.value = `${location.origin}${location.pathname}#/join/${s.id}.${s.secret}${qs ? '?' + qs : ''}`;
    if (turn) log('join link includes the custom TURN settings (anyone with the link can use that TURN account)');
    if (relayOnly) log('RELAY-ONLY test mode is on: both sides must connect through a TURN server');
    qrEl.replaceChildren();
    if (window.QRCode) new window.QRCode(qrEl, { text: linkIn.value, width: 220, height: 220 });
    else qrEl.append('QR code library could not be loaded. Use the link instead.');
    toggleBtn.textContent = 'Close session'; chat.setEnabled(true);
    log('SESSION OPEN – share the link; waiting for players. Room ' + short(s.id));
    renderPeople();
  }

  function closeSession() {
    if (!session) return;
    log(`closing session; notifying ${peers.size} connected peer(s)`);
    [...peers.keys()].forEach(pid => sendTo({ t: 'closed' }, pid));
    const c = conn; setTimeout(() => c?.leave(), 400); // let 'closed' go out first
    peers.clear(); session = null; conn = null;
    linkIn.value = ''; toggleBtn.textContent = 'Open session'; chat.setEnabled(false);
    qrEl.replaceChildren();
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
    if (m.secret !== session.secret) { log(`join request from ${short(pid)} with an invalid invite secret – ignored`); return; }
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
      h('div', { class: 'row' }, 'Join mode:', modeSel, toggleBtn), h('div', { class: 'row' }, linkIn, copyBtn), qrEl,
      h('div', { class: 'muted' }, 'Scan the QR code or open the link on a player device. Keep this tab open while playing. PeerJS only introduces the browsers; chat and game data use the direct WebRTC channel.')),
    h('section', {}, h('h2', {}, 'TURN relay (optional) and relay test'),
      h('div', { class: 'row' }, turnUrls, turnUser, turnCred),
      h('div', { class: 'row' }, relayChk, 'Relay-only test: force all traffic through TURN (if this connects, TURN works; if not, TURN is unreachable). Applies to the next session you open.'),
      h('div', { class: 'muted' }, 'PeerJS already uses its free shared TURN servers by default. Custom TURN settings are saved in this browser and added to the join link.')),
    h('section', {}, h('h2', {}, 'Lobby (waiting for approval)'), lobbyEl),
    h('section', {}, h('h2', {}, 'Players of this campaign'), playersEl),
    h('section', {}, h('h2', {}, 'Chat (stored in this browser)'), chat.el),
    h('section', {}, h('h2', {}, 'Connection log'), logEl)
  );
  cleanup = () => { conn?.leave(); conn = null; };
}

// ---------- PLAYER ----------
function viewPlayer(sid, secret, opts = {}) {
  let token = localStorage.getItem(LS_TOKEN);
  const newToken = !token;
  if (!token) { token = rid(24); localStorage.setItem(LS_TOKEN, token); }
  const { el: logEl, log } = makeLog('Player', () => conn ? conn.status() : log('not connected yet'));
  log(`link: DM host ${short(sid)}; identity token ${token.slice(0, 6)}… (${newToken ? 'new' : 'kept on this device'})`);
  const statusEl = h('div', { class: 'status' }, 'Enter a name and join.');
  const rosterEl = h('div', { class: 'muted' });
  const nameIn = h('input', { value: localStorage.getItem(LS_NAME) || '', placeholder: 'Your name', maxlength: '30' });
  const joinBtn = h('button', { onclick: () => join() }, 'Join');
  let conn = null, dmPid = null, state = 'idle', timer = null, left = false, t0 = 0;
  const chat = makeChat(text => { if (state === 'accepted' && dmPid) conn.send({ t: 'chat', text }, dmPid); });
  chat.setEnabled(false);

  const setState = (s, text) => { if (s !== state) log(`state: ${state} -> ${s} | ${text}`); state = s; statusEl.textContent = text; chat.setEnabled(s === 'accepted'); };
  const sendJoin = pid => { log('sending join request to ' + short(pid)); conn.send({ t: 'join', secret, token, name: nameIn.value.trim() || 'Player' }, pid); };
  const leave = () => { left = true; conn?.leave(); };

  async function join() {
    const name = nameIn.value.trim(); if (!name) { nameIn.focus(); return; }
    localStorage.setItem(LS_NAME, name); joinBtn.disabled = nameIn.disabled = true; t0 = performance.now();
    log(`Join clicked as "${name}"`);
    setState('connecting', 'Connecting to the DM… (can take 5–20 s)');
    try {
      const c = await connectPeer(sid, {
        log, turn: opts.turn, relayOnly: opts.relayOnly,
        onJoin: pid => log('peer connected ' + short(pid)),
        onLeave: pid => {
          if (pid === dmPid && !left) { log('the DM peer disconnected'); dmPid = null; if (state === 'accepted' || state === 'pending') setState('connecting', 'DM disconnected. Waiting for the DM to come back…'); }
          else log(`peer ${short(pid)} left (not the DM)`);
        },
        onMessage: (m, pid) => onMsg(m, pid),
      });
      if (left) { c.leave(); return; }
      conn = c;
      sendJoin(sid);
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
