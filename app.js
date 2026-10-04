// VTTRPG skeleton: DM-hosted, browser-only, WebRTC via Trystero.
// The DM's browser is the authority. Players only talk to the DM (chat is relayed by the DM).

// ---------- networking layer (the only place that knows about Trystero) ----------
const APP_ID = 'vttrpg-skeleton-v2';              // namespace for the signaling relays (not secret)
const TRYSTERO_VERSION = '0.26.0';                // pinned: the API changed a lot between releases
const STRATEGIES = {                              // how peers find each other (signaling only, no game data)
  mqtt:    { pkg: '@trystero-p2p/mqtt',    label: 'MQTT brokers (default)' },
  torrent: { pkg: '@trystero-p2p/torrent', label: 'BitTorrent trackers' },
  nostr:   { pkg: '@trystero-p2p/nostr',   label: 'Nostr relays' },
};
const DEFAULT_STRATEGY = 'mqtt';
const CDNS = [pkgAtVer => `https://esm.run/${pkgAtVer}`, pkgAtVer => `https://esm.sh/${pkgAtVer}`];

async function loadStrategy(name, log) {
  const pkgAtVer = `${STRATEGIES[name].pkg}@${TRYSTERO_VERSION}`;
  for (const mk of CDNS) {
    const url = mk(pkgAtVer);
    try { const mod = await import(url); log(`library loaded: ${url}`); return mod; }
    catch (e) { log(`library load FAILED: ${url} (${e.message})`); }
  }
  throw new Error('Could not load the networking library for strategy ' + name);
}

// Returns { send(data, targetPeerId?), leave() }
async function connect(strategy, roomId, secret, { log, onJoin, onLeave, onMessage }) {
  const mod = await loadStrategy(strategy, log);
  log(`joining room via ${strategy}…`);
  const room = mod.joinRoom({ appId: APP_ID, password: secret }, roomId, {
    onJoinError: d => log('JOIN ERROR: ' + JSON.stringify(d)),
  });
  const action = room.makeAction('msg');
  room.onPeerJoin = onJoin;
  room.onPeerLeave = onLeave;
  action.onMessage = (data, meta) => onMessage(data, meta.peerId);

  const timers = [];
  const relayStates = () => {
    try {
      const socks = mod.getRelaySockets?.() || {};
      const names = ['connecting', 'open', 'closing', 'closed'];
      return Object.entries(socks).map(([u, s]) => {
        const st = s.readyState !== undefined ? names[s.readyState] : (s.connected ? 'open' : 'not connected');
        return `${u.replace(/^wss?:\/\//, '')}=${st}`;
      }).join('  ') || '(no relay sockets)';
    } catch (e) { return 'relay state unavailable: ' + e.message; }
  };
  [2000, 6000, 15000, 30000].forEach(ms => timers.push(setTimeout(() => log(`relays @${ms / 1000}s: ${relayStates()}`), ms)));

  return {
    send(data, target) {
      Promise.resolve(action.send(data, target ? { target } : {})).catch(e => log('send failed: ' + e.message));
    },
    leave() { timers.forEach(clearTimeout); try { room.leave(); } catch { } },
  };
}

// ---------- constants & helpers ----------
const LS_CAMPAIGNS = 'vttrpg:campaigns';       // DM side: all campaigns (localStorage for the skeleton)
const LS_NAME = 'vttrpg:playerName';           // player side: last used name
const SS_TOKEN = 'vttrpg:playerToken';         // player side: per-tab identity (sessionStorage => testable with several tabs)
const JOIN_TIMEOUT_MS = 25000;

const rid = (n = 12) => {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return [...a].map(b => (b % 36).toString(36)).join('');
};
const short = id => String(id).slice(0, 6);

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
function makeLog() {
  const el = h('pre', { class: 'log' });
  const log = s => { el.textContent += `${new Date().toLocaleTimeString()}  ${s}\n`; el.scrollTop = el.scrollHeight; console.log('[vttrpg]', s); };
  return { el, log };
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
  $app.replaceChildren();
  const hash = location.hash.replace(/^#/, '') || '/';
  let m;
  if ((m = hash.match(/^\/join\/([a-z0-9]+)\.([a-z0-9]+)(?:\.([a-z]+))?$/))) return viewPlayer(m[1], m[2], STRATEGIES[m[3]] ? m[3] : DEFAULT_STRATEGY);
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
    h('section', { class: 'muted' }, `Players: you do not need anything here. Just open the join link the DM sent you. (networking: Trystero ${TRYSTERO_VERSION})`)
  );
}

// ---------- DM ----------
function viewDM(cid) {
  const camp = loadAll()[cid];
  if (!camp) { location.hash = '#/'; return; }
  const save = () => saveCampaign(camp);
  const { el: logEl, log } = makeLog();
  const chat = makeChat(text => postChat({ from: 'DM', text }));
  camp.chat.slice(-100).forEach(chat.add);

  let conn = null, session = null, opening = false;
  const peers = new Map(); // peerId -> {token, name, status:'pending'|'approved', num}

  const modeSel = h('select', { onchange: () => { if (session) { session.mode = modeSel.value; log('join mode -> ' + session.mode); } } },
    h('option', { value: 'approval' }, 'Approval required'),
    h('option', { value: 'open' }, 'Open (auto-approve)'),
    h('option', { value: 'locked' }, 'Locked (only known players)'));
  const stratSel = h('select', {}, ...Object.entries(STRATEGIES).map(([k, v]) => h('option', { value: k }, v.label)));
  stratSel.value = DEFAULT_STRATEGY;
  const toggleBtn = h('button', { onclick: () => session ? closeSession() : openSession() }, 'Open session');
  const linkIn = h('input', { readonly: '', placeholder: 'Open the session to get a link' });
  const copyBtn = h('button', { onclick: () => { linkIn.select(); navigator.clipboard?.writeText(linkIn.value); } }, 'Copy link');
  const lobbyEl = h('div'), playersEl = h('div');
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
    try {
      log(`opening session (strategy ${strategy}, Trystero ${TRYSTERO_VERSION})…`);
      conn = await connect(strategy, s.id, s.secret, {
        log,
        onJoin: pid => log('peer connected ' + short(pid) + ' (waiting for its join request)'),
        onLeave: pid => {
          const p = peers.get(pid); log('peer left ' + short(pid) + (p ? ` (${p.name})` : ''));
          if (p) { peers.delete(pid); if (p.status === 'approved') systemMsg(`${p.name} (Player ${p.num}) disconnected`); renderPeople(); broadcastRoster(); }
        },
        onMessage: (m, pid) => onMsg(m, pid),
      });
    } catch (e) {
      log('could not open session: ' + e.message); opening = false; toggleBtn.disabled = stratSel.disabled = false; return;
    }
    session = s; opening = false; toggleBtn.disabled = false;
    linkIn.value = `${location.origin}${location.pathname}#/join/${s.id}.${s.secret}.${strategy}`;
    toggleBtn.textContent = 'Close session'; chat.setEnabled(true);
    log('session open, room ' + s.id);
    renderPeople();
  }

  function closeSession() {
    if (!session) return;
    [...peers.keys()].forEach(pid => sendTo({ t: 'closed' }, pid));
    const c = conn; setTimeout(() => c?.leave(), 400); // let 'closed' go out first
    peers.clear(); session = null; conn = null; stratSel.disabled = false;
    linkIn.value = ''; toggleBtn.textContent = 'Open session'; chat.setEnabled(false);
    log('session closed (old link is now dead)'); renderPeople();
  }

  function onMsg(m, pid) {
    if (!m || typeof m !== 'object' || !session) return;
    if (m.t === 'join') return handleJoin(m, pid);
    const p = peers.get(pid);
    if (!p || p.status !== 'approved') return;          // ignore anything from non-approved peers
    if (m.t === 'chat') {
      const text = String(m.text || '').trim().slice(0, 500);
      if (text) postChat({ from: `${p.name} (P${p.num})`, text });
    }
  }

  function handleJoin(m, pid) {
    const token = String(m.token || '').slice(0, 64);
    const name = String(m.name || '').trim().slice(0, 30) || 'Player';
    if (!token) return;
    const rec = camp.players[token];
    log(`join request from ${short(pid)} "${name}"${rec ? ' (known as Player ' + rec.num + ')' : ''}`);
    if (rec?.banned) return sendTo({ t: 'denied', reason: 'You are banned.' }, pid);
    for (const [oid, o] of peers) if (o.token === token && oid !== pid) peers.delete(oid); // reconnect: drop stale entry
    if (rec) {                                          // known player: re-admit, keep number
      rec.name = name; save();
      peers.set(pid, { token, name, status: 'approved', num: rec.num });
      sendAccepted(pid); systemMsg(`${name} (Player ${rec.num}) reconnected`); renderPeople(); broadcastRoster(); return;
    }
    if (session.mode === 'locked') return sendTo({ t: 'denied', reason: 'Session is locked.' }, pid);
    peers.set(pid, { token, name, status: 'pending' });
    if (session.mode === 'open') return approve(pid);
    sendTo({ t: 'pending' }, pid); renderPeople();
  }

  function approve(pid) {
    const p = peers.get(pid); if (!p) return;
    const num = camp.nextNum++;
    camp.players[p.token] = { num, name: p.name, banned: false };
    p.status = 'approved'; p.num = num; save();
    sendAccepted(pid); systemMsg(`${p.name} joined as Player ${num}`); renderPeople(); broadcastRoster();
  }
  const sendAccepted = pid => {
    const p = peers.get(pid);
    sendTo({ t: 'accepted', num: p.num, name: p.name, campaignName: camp.name, history: camp.chat.slice(-50), roster: roster() }, pid);
  };
  function deny(pid) { sendTo({ t: 'denied', reason: 'The DM declined your request.' }, pid); peers.delete(pid); renderPeople(); }
  function kick(token, ban) {
    const pid = [...peers].find(([, p]) => p.token === token)?.[0];
    if (pid) { sendTo({ t: 'kicked', ban }, pid); peers.delete(pid); }
    if (ban && camp.players[token]) { camp.players[token].banned = true; save(); }
    log((ban ? 'banned ' : 'kicked ') + token.slice(0, 6)); renderPeople(); broadcastRoster();
  }
  function unban(token) { camp.players[token].banned = false; save(); renderPeople(); }

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
  }

  renderPeople();
  $app.append(
    h('div', { class: 'row' }, h('a', { href: '#/' }, '← Campaigns'), h('b', {}, `DM view: ${camp.name}`),
      h('button', { onclick: exportCampaign }, 'Export to file')),
    h('section', {}, h('h2', {}, 'Session'),
      h('div', { class: 'row' }, 'Join mode:', modeSel, 'Signaling:', stratSel, toggleBtn), h('div', { class: 'row' }, linkIn, copyBtn),
      h('div', { class: 'muted' }, 'Keep this tab open and in the foreground while playing. Closing the session kills the link. The signaling choice is stored in the link.')),
    h('section', {}, h('h2', {}, 'Lobby (waiting for approval)'), lobbyEl),
    h('section', {}, h('h2', {}, 'Players of this campaign'), playersEl),
    h('section', {}, h('h2', {}, 'Chat (stored in this browser)'), chat.el),
    h('section', {}, h('h2', {}, 'Connection log'), logEl)
  );
  cleanup = () => { conn?.leave(); conn = null; };
}

// ---------- PLAYER ----------
function viewPlayer(sid, secret, strategy) {
  let token = sessionStorage.getItem(SS_TOKEN);
  if (!token) { token = rid(24); sessionStorage.setItem(SS_TOKEN, token); }
  const { el: logEl, log } = makeLog();
  const statusEl = h('div', { class: 'status' }, 'Enter a name and join.');
  const rosterEl = h('div', { class: 'muted' });
  const nameIn = h('input', { value: localStorage.getItem(LS_NAME) || '', placeholder: 'Your name', maxlength: '30' });
  const joinBtn = h('button', { onclick: () => join() }, 'Join');
  let conn = null, dmPid = null, state = 'idle', timer = null, left = false;
  const chat = makeChat(text => { if (state === 'accepted' && dmPid) conn.send({ t: 'chat', text }, dmPid); });
  chat.setEnabled(false);

  const setState = (s, text) => { state = s; statusEl.textContent = text; chat.setEnabled(s === 'accepted'); };
  const sendJoin = pid => { log('sending join request to ' + short(pid)); conn.send({ t: 'join', token, name: nameIn.value.trim() || 'Player' }, pid); };
  const leave = () => { left = true; conn?.leave(); };

  async function join() {
    const name = nameIn.value.trim(); if (!name) { nameIn.focus(); return; }
    localStorage.setItem(LS_NAME, name); joinBtn.disabled = nameIn.disabled = true;
    setState('connecting', 'Connecting to the DM… (can take 5–20 s)');
    log(`strategy ${strategy}, Trystero ${TRYSTERO_VERSION}`);
    try {
      const c = await connect(strategy, sid, secret, {
        log,
        onJoin: pid => { log('peer connected ' + short(pid)); if (!dmPid && state !== 'denied' && state !== 'kicked' && conn) sendJoin(pid); },
        onLeave: pid => {
          log('peer left ' + short(pid));
          if (pid === dmPid && !left) { dmPid = null; if (state === 'accepted' || state === 'pending') setState('connecting', 'DM disconnected. Waiting for the DM to come back…'); }
        },
        onMessage: (m, pid) => onMsg(m, pid),
      });
      if (left) { c.leave(); return; }
      conn = c;
    } catch (e) { setState('error', 'Could not start networking: ' + e.message); return; }
    timer = setTimeout(() => { if (state === 'connecting') setState('connecting', 'No DM found yet. Is the session open and the link current? (still trying… see the log below)'); }, JOIN_TIMEOUT_MS);
  }

  function onMsg(m, pid) {
    if (!m || typeof m !== 'object') return;
    const handshake = ['pending', 'accepted', 'denied'].includes(m.t);
    if (!handshake && pid !== dmPid) return;          // only trust the peer that answered our join request
    if (dmPid && pid !== dmPid) return;
    switch (m.t) {
      case 'pending': dmPid = pid; setState('pending', 'Waiting for the DM to approve you…'); break;
      case 'accepted':
        dmPid = pid; clearTimeout(timer); chat.clear(); (m.history || []).forEach(chat.add); renderRoster(m.roster);
        setState('accepted', `Joined "${m.campaignName}" as Player ${m.num} (${m.name})`); break;
      case 'denied': dmPid = pid; setState('denied', 'Not admitted: ' + (m.reason || 'denied')); leave(); break;
      case 'kicked': setState('kicked', m.ban ? 'You were banned by the DM.' : 'You were kicked by the DM.'); leave(); break;
      case 'closed': setState('closed', 'The DM closed the session.'); leave(); break;
      case 'chat': chat.add(m.msg); break;
      case 'roster': renderRoster(m.roster); break;
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
