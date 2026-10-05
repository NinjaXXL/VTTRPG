// VTTRPG Skeleton v0.7.0
// DM-hosted browser-only VTT skeleton.
// WebRTC via PeerJS 1.5.5.
//
// v0.7.0 changes:
// - Do not use PeerJS' obsolete default TURN infrastructure.
// - Explicit STUN configuration.
// - Optional user-provided TURN configuration.
// - TURN relay-only test.
// - Better ICE/WebRTC diagnostics.
// - Better connection timeout handling.
// - Candidate-pair diagnostics.
// - More explicit separation between PeerJS signaling and WebRTC.
// - Stable DM peer id and reconnect handling.
//
// NOTE:
// STUN can establish direct WebRTC connections in many networks.
// A TURN server is still required for networks where direct connectivity
// is impossible.

const APP_VERSION = '0.7.0';
const PEERJS_VERSION = '1.5.5';

const PEER_PREFIX = 'vttrpg-';

const STALE_MS = 60000;
const STALE_CHECK_MS = 15000;
const HEARTBEAT_MS = 30000;

const CONNECT_TIMEOUT_MS = 15000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const MAX_CHAT = 500;
const MAX_LOG = 1000;

const LS_CAMPAIGN = 'vttrpg-campaign-v2';
const LS_SETTINGS = 'vttrpg-settings-v2';

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

let app;
let logLines = [];

let mode = null;
let peer = null;
let roomId = null;
let myPeerId = null;

let sessionOpen = false;
let sessionPin = '';

let reconnectTimer = null;
let reconnectAttempt = 0;

let heartbeatTimer = null;
let staleTimer = null;

let playerConnections = new Map();
let playerByConnection = new Map();

let playerName = '';
let playerId = null;

let currentConnection = null;
let playerConnectTimer = null;
let playerReconnectTimer = null;
let playerReconnectAttempt = 0;
let playerDestroyed = false;

let campaign = {
  name: 'Test',
  players: [],
  chat: [],
};

let settings = {
  turn: {
    urls: [],
    username: '',
    credential: '',
  },
  relayOnly: false,
};

function now() {
  return Date.now();
}

function timestamp() {
  return new Date().toLocaleTimeString('de-DE', {
    hour12: false,
    fractionalSecondDigits: 3,
  });
}

function log(message) {
  const line = `${timestamp()}  ${message}`;
  console.log(`[VTTRPG] ${line}`);

  logLines.push(line);

  if (logLines.length > MAX_LOG) {
    logLines.splice(0, logLines.length - MAX_LOG);
  }

  renderLog();
}

function renderLog() {
  const el = document.querySelector('#log');
  if (!el) return;

  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function randomId(length = 12) {
  const chars =
    'abcdefghijklmnopqrstuvwxyz0123456789';

  let out = '';

  if (crypto?.getRandomValues) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);

    for (let i = 0; i < length; i++) {
      out += chars[bytes[i] % chars.length];
    }

    return out;
  }

  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}

function randomPin(length = 4) {
  let out = '';

  for (let i = 0; i < length; i++) {
    out += Math.floor(Math.random() * 10);
  }

  return out;
}

function peerIdForRoom(room) {
  return `${PEER_PREFIX}${room}`;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);

    if (!raw) return;

    const parsed = JSON.parse(raw);

    settings = {
      ...settings,
      ...parsed,
      turn: {
        ...settings.turn,
        ...(parsed.turn || {}),
      },
    };
  } catch (error) {
    log(`settings load failed: ${error.message}`);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(
      LS_SETTINGS,
      JSON.stringify(settings),
    );
  } catch (error) {
    log(`settings save failed: ${error.message}`);
  }
}

function loadCampaign() {
  try {
    const raw = localStorage.getItem(LS_CAMPAIGN);

    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);

    campaign = {
      name: parsed.name || 'Test',
      players: Array.isArray(parsed.players)
        ? parsed.players
        : [],
      chat: Array.isArray(parsed.chat)
        ? parsed.chat.slice(-MAX_CHAT)
        : [],
    };

    log(
      `campaign "${campaign.name}" loaded from localStorage: ` +
      `${campaign.players.length} known players, ` +
      `${campaign.chat.length} chat messages`,
    );
  } catch (error) {
    log(`campaign load failed: ${error.message}`);
  }
}

function saveCampaign() {
  try {
    localStorage.setItem(
      LS_CAMPAIGN,
      JSON.stringify(campaign),
    );
  } catch (error) {
    log(`campaign save failed: ${error.message}`);
  }
}

function updateVersion() {
  const version = document.querySelector('#version');

  if (version) {
    version.textContent =
      `VTTRPG skeleton v${APP_VERSION} ` +
      `(PeerJS ${PEERJS_VERSION})`;
  }
}

function isPeerLoaded() {
  return typeof window.Peer === 'function';
}

function describeEnvironment() {
  log(
    `env: online=${navigator.onLine} ` +
    `secureContext=${window.isSecureContext} ` +
    `RTCPeerConnection=${typeof RTCPeerConnection !== 'undefined'} ` +
    `PeerJS=${isPeerLoaded() ? 'loaded' : 'missing'}`,
  );

  log(`browser: ${navigator.userAgent}`);
}

function getTurnConfig() {
  const turn = settings.turn || {};

  let urls = turn.urls;

  if (typeof urls === 'string') {
    urls = urls
      .split(/[\n,;]+/)
      .map(x => x.trim())
      .filter(Boolean);
  }

  if (!Array.isArray(urls)) {
    urls = [];
  }

  urls = urls.filter(Boolean);

  if (!urls.length) {
    return null;
  }

  if (!turn.username || !turn.credential) {
    return null;
  }

  return {
    urls,
    username: turn.username,
    credential: turn.credential,
  };
}

function peerOptions({ relayOnly = false } = {}) {
  const iceServers = [...STUN_SERVERS];

  const turn = getTurnConfig();

  if (turn) {
    iceServers.push(turn);
  }

  const config = {
    iceServers,
    iceCandidatePoolSize: 4,
    sdpSemantics: 'unified-plan',
  };

  if (relayOnly) {
    if (!turn) {
      log(
        'WARNING: relay-only requested, but no valid TURN ' +
        'configuration is available.',
      );
    } else {
      config.iceTransportPolicy = 'relay';
    }
  }

  log(
    `ICE config: STUN Google + Cloudflare` +
    (turn
      ? ` + TURN ${turn.urls.join(', ')}`
      : ' + no TURN') +
    (relayOnly ? ' | relay-only' : ''),
  );

  return {
    config,
  };
}

function getPeerConnection(connection) {
  return (
    connection?.peerConnection ||
    connection?._pc ||
    connection?.peerConnection?.peerConnection ||
    null
  );
}

async function getIceDiagnostics(connection) {
  const pc = getPeerConnection(connection);

  if (!pc) {
    return {
      available: false,
      reason: 'no underlying RTCPeerConnection',
    };
  }

  const result = {
    available: true,
    ice: pc.iceConnectionState,
    connection: pc.connectionState,
    gathering: pc.iceGatheringState,
    signaling: pc.signalingState,
    pairs: [],
  };

  if (typeof pc.getStats !== 'function') {
    return result;
  }

  try {
    const stats = await pc.getStats();

    stats.forEach(report => {
      if (report.type !== 'candidate-pair') {
        return;
      }

      const local = stats.get(report.localCandidateId);
      const remote = stats.get(report.remoteCandidateId);

      result.pairs.push({
        state: report.state,
        nominated: report.nominated,
        selected:
          report.selected ||
          report.nominated ||
          false,
        localType: local?.candidateType || '?',
        localProtocol: local?.protocol || '?',
        remoteType: remote?.candidateType || '?',
        remoteProtocol: remote?.protocol || '?',
        requestsSent: report.requestsSent,
        responsesReceived: report.responsesReceived,
        currentRoundTripTime:
          report.currentRoundTripTime,
      });
    });
  } catch (error) {
    result.statsError = error.message;
  }

  return result;
}

async function logIceDiagnostics(connection, prefix = '') {
  const data = await getIceDiagnostics(connection);

  log(
    `${prefix}ICE diagnostics: ` +
    JSON.stringify(data),
  );

  return data;
}

function installPeerDiagnostics(peerInstance, label) {
  if (!peerInstance) return;

  peerInstance.on('error', error => {
    log(
      `${label} PeerJS error: ` +
      `${error?.type || 'unknown'} ` +
      `${error?.message || error}`,
    );
  });

  peerInstance.on('disconnected', () => {
    log(`${label} PeerJS signaling disconnected`);
  });

  peerInstance.on('close', () => {
    log(`${label} PeerJS object closed`);
  });

  peerInstance.on('open', id => {
    log(`${label} PeerJS signaling connected as ${id}`);
  });
}

function connectionSummary(connection) {
  if (!connection) {
    return 'no connection';
  }

  const pc = getPeerConnection(connection);

  if (!pc) {
    return 'PeerJS connection exists; RTCPeerConnection unavailable';
  }

  return (
    `ICE=${pc.iceConnectionState} ` +
    `connection=${pc.connectionState} ` +
    `gathering=${pc.iceGatheringState} ` +
    `signaling=${pc.signalingState}`
  );
}

function attachConnectionDiagnostics(connection, label) {
  const pc = getPeerConnection(connection);

  if (!pc) {
    log(
      `${label}: underlying RTCPeerConnection ` +
      `not available yet`,
    );
    return;
  }

  const events = [
    'iceconnectionstatechange',
    'connectionstatechange',
    'icegatheringstatechange',
    'signalingstatechange',
  ];

  for (const eventName of events) {
    pc.addEventListener(eventName, () => {
      log(
        `${label}: ${eventName}: ` +
        `${connectionSummary(connection)}`,
      );
    });
  }

  pc.addEventListener('icecandidateerror', event => {
    log(
      `${label}: ICE candidate error ` +
      `${event.errorCode || ''} ` +
      `${event.url || ''} ` +
      `${event.errorText || ''}`,
    );
  });
}

function sendJson(connection, data) {
  if (!connection) {
    return false;
  }

  if (connection.open === false) {
    return false;
  }

  try {
    connection.send(data);
    return true;
  } catch (error) {
    log(`send failed: ${error.message}`);
    return false;
  }
}

function normalizePlayer(player) {
  return {
    id: player.id,
    name: player.name || 'Player',
    peerId: player.peerId || '',
    approved: !!player.approved,
    banned: !!player.banned,
    lastSeen: Number(player.lastSeen) || 0,
    connected: !!player.connected,
  };
}

function findPlayer(id) {
  return campaign.players.find(
    player => player.id === id,
  );
}

function findPlayerByPeerId(peerId) {
  return campaign.players.find(
    player => player.peerId === peerId,
  );
}

function ensurePlayerRecord(peerId, name = 'Player') {
  let player = findPlayerByPeerId(peerId);

  if (player) {
    player.name = name || player.name;
    player.lastSeen = now();
    return player;
  }

  player = normalizePlayer({
    id: randomId(10),
    name,
    peerId,
    approved: false,
    banned: false,
    lastSeen: now(),
    connected: true,
  });

  campaign.players.push(player);

  saveCampaign();

  return player;
}

function playerNumber(player) {
  const index = campaign.players.findIndex(
    p => p.id === player.id,
  );

  return index >= 0 ? index + 1 : '?';
}

function addChatMessage({
  from,
  text,
  system = false,
}) {
  const message = {
    id: randomId(12),
    ts: now(),
    from: from || 'System',
    text: String(text || '').slice(0, 2000),
    system: !!system,
  };

  campaign.chat.push(message);

  if (campaign.chat.length > MAX_CHAT) {
    campaign.chat.splice(
      0,
      campaign.chat.length - MAX_CHAT,
    );
  }

  saveCampaign();
  renderChat();

  return message;
}

function renderChat() {
  const chat = document.querySelector('#chat');

  if (!chat) return;

  chat.innerHTML = '';

  for (const message of campaign.chat) {
    const div = document.createElement('div');

    div.className =
      `msg${message.system ? ' sys' : ''}`;

    const time = new Date(message.ts)
      .toLocaleTimeString('de-DE', {
        hour12: false,
      });

    div.innerHTML =
      `<span class="ts">${escapeHtml(time)}</span> ` +
      `<strong>${escapeHtml(message.from)}</strong>: ` +
      `${escapeHtml(message.text)}`;

    chat.appendChild(div);
  }

  chat.scrollTop = chat.scrollHeight;
}

function renderPlayers() {
  const list = document.querySelector('#players');

  if (!list) return;

  if (!campaign.players.length) {
    list.innerHTML =
      '<div class="muted">No known players.</div>';
    return;
  }

  list.innerHTML = '';

  for (const player of campaign.players) {
    const row = document.createElement('div');

    row.className = 'player-row';

    const state =
      player.connected
        ? 'connected'
        : 'offline';

    const approval =
      player.approved
        ? 'approved'
        : 'waiting';

    row.innerHTML = `
      <div class="player-main">
        <strong>
          #${escapeHtml(playerNumber(player))}
          ${escapeHtml(player.name)}
        </strong>
        <span class="tag">${escapeHtml(state)}</span>
        <span class="tag">${escapeHtml(approval)}</span>
      </div>
      <div class="player-actions">
        ${
          !player.approved
            ? `<button data-action="approve"
                 data-player="${escapeHtml(player.id)}">
                 Approve
               </button>`
            : ''
        }
        ${
          player.connected
            ? `<button data-action="kick"
                 data-player="${escapeHtml(player.id)}">
                 Kick
               </button>`
            : ''
        }
        <button data-action="ban"
                data-player="${escapeHtml(player.id)}">
          ${player.banned ? 'Unban' : 'Ban'}
        </button>
      </div>
    `;

    list.appendChild(row);
  }
}

function renderStatus() {
  const status = document.querySelector('#status');

  if (!status) return;

  if (mode === 'dm') {
    status.textContent =
      sessionOpen
        ? `DM session open – ${campaign.players.filter(p => p.connected).length} connected`
        : 'DM session closed';

    return;
  }

  if (mode === 'player') {
    status.textContent =
      currentConnection?.open
        ? 'Connected to DM'
        : 'Connecting to DM…';

    return;
  }

  status.textContent = 'Ready';
}

function render() {
  if (!app) return;

  if (!mode) {
    renderStartScreen();
  } else if (mode === 'dm') {
    renderDm();
  } else {
    renderPlayer();
  }

  updateVersion();
  renderChat();
  renderPlayers();
  renderStatus();
  renderLog();
}

function renderStartScreen() {
  app.innerHTML = `
    <section>
      <h2>VTTRPG Skeleton v${APP_VERSION}</h2>

      <p class="muted">
        Browser-only VTTRPG concept test using PeerJS/WebRTC.
      </p>

      <div class="row">
        <button id="startDm">Start DM</button>
        <button id="joinPlayer">Join as Player</button>
      </div>
    </section>

    <section>
      <h2>WebRTC / TURN configuration</h2>

      <p class="muted">
        STUN is enabled automatically. TURN is optional but recommended
        for players behind restrictive NAT/firewalls.
      </p>

      <label>
        TURN URLs
        <input id="turnUrls"
               placeholder="turn:example.com:3478,turns:example.com:5349">
      </label>

      <label>
        TURN username
        <input id="turnUsername">
      </label>

      <label>
        TURN credential
        <input id="turnCredential"
               type="password">
      </label>

      <label>
        <input id="relayOnly"
               type="checkbox">
        Use TURN relay-only mode
      </label>

      <div class="row">
        <button id="saveTurn">
          Save TURN settings
        </button>

        <button id="testTurn">
          Test TURN credentials
        </button>
      </div>

      <div id="turnResult"
           class="muted"></div>
    </section>

    <section>
      <h2>Diagnostics</h2>
      <p>
        <span class="status"
              id="status">Ready</span>
      </p>
    </section>

    <section>
      <h2>Log</h2>
      <pre id="log" class="log"></pre>
    </section>
  `;

  populateTurnForm();

  document
    .querySelector('#startDm')
    ?.addEventListener('click', startDm);

  document
    .querySelector('#joinPlayer')
    ?.addEventListener('click', startPlayer);

  document
    .querySelector('#saveTurn')
    ?.addEventListener('click', saveTurnFromForm);

  document
    .querySelector('#testTurn')
    ?.addEventListener('click', testTurnFromForm);
}

function populateTurnForm() {
  const urls = document.querySelector('#turnUrls');
  const username = document.querySelector('#turnUsername');
  const credential = document.querySelector('#turnCredential');
  const relay = document.querySelector('#relayOnly');

  if (urls) {
    urls.value = Array.isArray(settings.turn.urls)
      ? settings.turn.urls.join('\n')
      : '';
  }

  if (username) {
    username.value =
      settings.turn.username || '';
  }

  if (credential) {
    credential.value =
      settings.turn.credential || '';
  }

  if (relay) {
    relay.checked =
      !!settings.relayOnly;
  }
}

function saveTurnFromForm() {
  const urls =
    document.querySelector('#turnUrls')?.value || '';

  const username =
    document.querySelector('#turnUsername')?.value || '';

  const credential =
    document.querySelector('#turnCredential')?.value || '';

  const relayOnly =
    document.querySelector('#relayOnly')?.checked || false;

  settings.turn = {
    urls: urls
      .split(/[\n,;]+/)
      .map(x => x.trim())
      .filter(Boolean),
    username,
    credential,
  };

  settings.relayOnly = relayOnly;

  saveSettings();

  const result =
    document.querySelector('#turnResult');

  if (result) {
    result.textContent =
      `Saved ${settings.turn.urls.length} TURN URL(s).`;
  }

  log(
    `TURN settings saved: ` +
    `${settings.turn.urls.length} URL(s), ` +
    `relayOnly=${settings.relayOnly}`,
  );
}

async function testTurnFromForm() {
  saveTurnFromForm();

  const result =
    document.querySelector('#turnResult');

  const turn = getTurnConfig();

  if (!turn) {
    if (result) {
      result.textContent =
        'No complete TURN configuration found.';
    }

    log(
      'TURN test skipped: URL, username or credential missing.',
    );

    return;
  }

  if (typeof RTCPeerConnection === 'undefined') {
    if (result) {
      result.textContent =
        'RTCPeerConnection is not available.';
    }

    return;
  }

  if (result) {
    result.textContent =
      'Testing TURN relay…';
  }

  log(
    `testing TURN credentials against: ` +
    `${turn.urls.join(', ')}`,
  );

  const pc = new RTCPeerConnection({
    iceServers: [turn],
    iceTransportPolicy: 'relay',
  });

  let relayCandidate = false;
  let finished = false;

  const finish = message => {
    if (finished) return;

    finished = true;

    try {
      pc.close();
    } catch {}

    if (result) {
      result.textContent = message;
    }

    log(`TURN test: ${message}`);
  };

  pc.onicecandidate = event => {
    if (!event.candidate) {
      return;
    }

    const candidate = event.candidate.candidate || '';

    if (
      candidate.includes(' typ relay ') ||
      candidate.includes(' typ relay')
    ) {
      relayCandidate = true;
      finish('OK – TURN relay candidate received.');
    }
  };

  pc.onicecandidateerror = event => {
    log(
      `TURN test ICE error ` +
      `${event.errorCode || ''} ` +
      `${event.url || ''} ` +
      `${event.errorText || ''}`,
    );
  };

  pc.onicegatheringstatechange = () => {
    log(
      `TURN test gathering=${pc.iceGatheringState}`,
    );

    if (
      pc.iceGatheringState === 'complete' &&
      !relayCandidate
    ) {
      finish(
        'FAILED – no TURN relay candidate received.',
      );
    }
  };

  try {
    pc.createDataChannel('turn-test');

    const offer = await pc.createOffer();

    await pc.setLocalDescription(offer);

    setTimeout(() => {
      if (!finished) {
        finish(
          'TIMEOUT – no TURN relay candidate received.',
        );
      }
    }, 10000);
  } catch (error) {
    finish(`ERROR – ${error.message}`);
  }
}

function renderDm() {
  const host =
    `${window.location.origin}` +
    `${window.location.pathname}`;

  const joinUrl =
    `${host}?join=${encodeURIComponent(roomId)}`;

  app.innerHTML = `
    <h1>VTTRPG – DM</h1>

    <section>
      <h2>Session</h2>

      <p>
        <span id="status"
              class="status"></span>
      </p>

      <p>
        Room:
        <strong>${escapeHtml(roomId)}</strong>
      </p>

      <p>
        PIN:
        <strong>${escapeHtml(sessionPin)}</strong>
      </p>

      <label>
        Join link
        <input readonly
               value="${escapeHtml(joinUrl)}">
      </label>

      <div class="row">
        <button id="copyLink">
          Copy join link
        </button>

        <button id="closeSession">
          Close session
        </button>
      </div>
    </section>

    <section>
      <h2>Players</h2>
      <div id="players"></div>
    </section>

    <section>
      <h2>Chat</h2>

      <div id="chat" class="chat"></div>

      <div class="row">
        <input id="chatInput"
               placeholder="Message…">

        <button id="sendChat">
          Send
        </button>
      </div>
    </section>

    <section>
      <h2>Log</h2>
      <pre id="log" class="log"></pre>
    </section>
  `;

  document
    .querySelector('#copyLink')
    ?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(joinUrl);
        log('join link copied');
      } catch {
        log('clipboard access failed');
      }
    });

  document
    .querySelector('#closeSession')
    ?.addEventListener('click', closeDmSession);

  document
    .querySelector('#sendChat')
    ?.addEventListener('click', sendDmChat);

  document
    .querySelector('#chatInput')
    ?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        sendDmChat();
      }
    });

  document
    .querySelector('#players')
    ?.addEventListener('click', handlePlayerAction);

  renderPlayers();
  renderChat();
  renderStatus();
  renderLog();
}

function renderPlayer() {
  const joinRoom =
    new URLSearchParams(
      window.location.search,
    ).get('join') || '';

  app.innerHTML = `
    <h1>VTTRPG – Player</h1>

    <section>
      <h2>Join session</h2>

      <label>
        Room
        <input id="roomInput"
               value="${escapeHtml(joinRoom)}"
               placeholder="Room ID">
      </label>

      <label>
        PIN
        <input id="pinInput"
               maxlength="4"
               placeholder="PIN">
      </label>

      <label>
        Name
        <input id="nameInput"
               placeholder="Character / player name">
      </label>

      <div class="row">
        <button id="connectPlayer">
          Connect
        </button>

        <button id="disconnectPlayer">
          Disconnect
        </button>
      </div>

      <p>
        <span id="status"
              class="status"></span>
      </p>

      <div id="connectionInfo"
           class="muted"></div>
    </section>

    <section>
      <h2>Chat</h2>

      <div id="chat" class="chat"></div>

      <div class="row">
        <input id="chatInput"
               placeholder="Message…">

        <button id="sendChat">
          Send
        </button>
      </div>
    </section>

    <section>
      <h2>Log</h2>
      <pre id="log" class="log"></pre>
    </section>
  `;

  document
    .querySelector('#connectPlayer')
    ?.addEventListener('click', connectPlayerFromForm);

  document
    .querySelector('#disconnectPlayer')
    ?.addEventListener(
      'click',
      disconnectPlayer,
    );

  document
    .querySelector('#sendChat')
    ?.addEventListener(
      'click',
      sendPlayerChat,
    );

  document
    .querySelector('#chatInput')
    ?.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        sendPlayerChat();
      }
    });

  renderChat();
  renderStatus();
  renderLog();
}

function connectPlayerFromForm() {
  const room =
    document.querySelector('#roomInput')?.value.trim();

  const pin =
    document.querySelector('#pinInput')?.value.trim();

  const name =
    document.querySelector('#nameInput')?.value.trim();

  if (!room) {
    alert('Room ID is required.');
    return;
  }

  if (!pin) {
    alert('PIN is required.');
    return;
  }

  playerName =
    name || `Player ${randomId(4)}`;

  roomId = room;
  sessionPin = pin;

  connectAsPlayer();
}

function createPeer(peerId, options = {}) {
  if (!isPeerLoaded()) {
    throw new Error(
      'PeerJS is not loaded.',
    );
  }

  const opts = peerOptions(options);

  const instance = new window.Peer(
    peerId,
    {
      debug: 0,
      config: opts.config,
    },
  );

  installPeerDiagnostics(
    instance,
    mode === 'dm'
      ? 'DM'
      : 'Player',
  );

  return instance;
}

async function startDm() {
  if (peer) {
    return;
  }

  mode = 'dm';

  roomId = randomId(14);
  myPeerId = peerIdForRoom(roomId);

  sessionPin = randomPin(4);

  render();

  log(
    `VTTRPG v${APP_VERSION} (DM) view started; ` +
    `page ${window.location.pathname}`,
  );

  log(
    `opening session: mode=approval, ` +
    `room=${roomId}, PIN set`,
  );

  try {
    peer = createPeer({
      relayOnly: false,
    });

    myPeerId = peerIdForRoom(roomId);

    peer.on('open', id => {
      myPeerId = id;

      sessionOpen = true;

      reconnectAttempt = 0;

      log(
        `SESSION OPEN – players need the link and ` +
        `the PIN "${sessionPin}". Waiting for players.`,
      );

      render();
      startDmHeartbeat();
    });

    peer.on('connection', connection => {
      handleIncomingConnection(connection);
    });

    peer.on('disconnected', () => {
      if (!sessionOpen) return;

      log(
        'DM PeerJS signaling disconnected; ' +
        'attempting to reclaim peer id…',
      );

      reclaimDmPeer();
    });

    peer.on('close', () => {
      log('DM PeerJS object closed');
    });

    peer.on('error', error => {
      log(
        `DM PeerJS error: ` +
        `${error?.type || 'unknown'} ` +
        `${error?.message || error}`,
      );
    });
  } catch (error) {
    log(`failed to start DM: ${error.message}`);

    mode = null;
    peer = null;

    render();
  }
}

function reclaimDmPeer() {
  if (!sessionOpen || reconnectTimer) {
    return;
  }

  reconnectAttempt++;

  const delay =
    Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS *
      Math.pow(2, reconnectAttempt - 1),
    );

  log(
    `DM signaling reconnect attempt ` +
    `${reconnectAttempt} in ${delay}ms…`,
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    try {
      if (peer) {
        try {
          peer.destroy();
        } catch {}

        peer = null;
      }

      peer = createPeer({
        relayOnly: false,
      });

      peer.on('open', id => {
        myPeerId = id;
        reconnectAttempt = 0;

        log(
          `DM signaling reconnected as ${id}`,
        );

        render();
      });

      peer.on('connection', connection => {
        handleIncomingConnection(connection);
      });

      peer.on('disconnected', () => {
        reclaimDmPeer();
      });
    } catch (error) {
      log(
        `DM signaling reconnect failed: ` +
        `${error.message}`,
      );

      reclaimDmPeer();
    }
  }, delay);
}

function handleIncomingConnection(connection) {
  const connectionId =
    connection.connectionId ||
    randomId(10);

  const peerId =
    connection.peer;

  log(
    `incoming connection from ${peerId} ` +
    `(negotiating…)`,
  );

  attachConnectionDiagnostics(
    connection,
    `rtc ${connectionId}`,
  );

  playerConnections.set(
    connectionId,
    connection,
  );

  playerByConnection.set(
    connectionId,
    peerId,
  );

  let opened = false;

  connection.on('open', () => {
    opened = true;

    log(
      `rtc ${connectionId}: data channel open ` +
      `from ${peerId}`,
    );

    const player =
      findPlayerByPeerId(peerId);

    if (player) {
      player.connected = true;
      player.lastSeen = now();
      saveCampaign();
    }

    renderPlayers();
    renderStatus();

    sendJson(connection, {
      type: 'hello',
      version: APP_VERSION,
      pinRequired: true,
      serverTime: now(),
    });
  });

  connection.on('data', data => {
    handleDmData(connection, data);
  });

  connection.on('close', () => {
    log(
      `rtc ${connectionId}: connection closed ` +
      `from ${peerId}`,
    );

    const player =
      findPlayerByPeerId(peerId);

    if (player) {
      player.connected = false;
      saveCampaign();
    }

    playerConnections.delete(connectionId);
    playerByConnection.delete(connectionId);

    renderPlayers();
    renderStatus();
  });

  connection.on('error', error => {
    log(
      `rtc ${connectionId}: connection error ` +
      `${error?.message || error}`,
    );
  });

  setTimeout(async () => {
    if (!opened) {
      await logIceDiagnostics(
        connection,
        `rtc ${connectionId}: `,
      );
    }
  }, CONNECT_TIMEOUT_MS);
}

function handleDmData(connection, data) {
  if (!data || typeof data !== 'object') {
    return;
  }

  const peerId = connection.peer;

  if (data.type === 'hello') {
    handlePlayerHello(connection, data);
    return;
  }

  if (data.type === 'heartbeat') {
    const player =
      findPlayerByPeerId(peerId);

    if (player) {
      player.lastSeen = now();
      player.connected = true;
      saveCampaign();
    }

    sendJson(connection, {
      type: 'heartbeatAck',
      ts: now(),
    });

    return;
  }

  if (data.type === 'chat') {
    const player =
      findPlayerByPeerId(peerId);

    if (!player || !player.approved) {
      return;
    }

    const message =
      addChatMessage({
        from: player.name,
        text: data.text,
      });

    broadcast({
      type: 'chat',
      message,
    });

    return;
  }

  if (data.type === 'ping') {
    sendJson(connection, {
      type: 'pong',
      ts: now(),
    });

    return;
  }
}

function handlePlayerHello(connection, data) {
  const peerId = connection.peer;

  const requestedName =
    String(data.name || 'Player')
      .trim()
      .slice(0, 80);

  const requestedPin =
    String(data.pin || '');

  if (requestedPin !== sessionPin) {
    log(
      `rejecting ${peerId}: wrong PIN`,
    );

    sendJson(connection, {
      type: 'joinRejected',
      reason: 'wrong_pin',
    });

    setTimeout(() => {
      try {
        connection.close();
      } catch {}
    }, 300);

    return;
  }

  let player =
    findPlayerByPeerId(peerId);

  if (!player) {
    player =
      ensurePlayerRecord(
        peerId,
        requestedName,
      );
  } else {
    player.name = requestedName || player.name;
    player.lastSeen = now();
    player.connected = true;
  }

  if (player.banned) {
    log(
      `rejecting banned player ${player.name}`,
    );

    sendJson(connection, {
      type: 'joinRejected',
      reason: 'banned',
    });

    setTimeout(() => {
      try {
        connection.close();
      } catch {}
    }, 300);

    return;
  }

  player.connected = true;
  player.lastSeen = now();

  saveCampaign();
  renderPlayers();

  if (!player.approved) {
    log(
      `player ${player.name} is waiting for approval`,
    );

    sendJson(connection, {
      type: 'approvalRequired',
      playerId: player.id,
      number: playerNumber(player),
    });

    return;
  }

  approveConnection(connection, player);
}

function approveConnection(connection, player) {
  sendJson(connection, {
    type: 'joinAccepted',
    player: {
      id: player.id,
      name: player.name,
      number: playerNumber(player),
    },
    campaign: {
      name: campaign.name,
    },
    chat: campaign.chat,
  });

  log(
    `approved player ${player.name} ` +
    `(#${playerNumber(player)})`,
  );
}

function broadcast(data, exceptConnection = null) {
  for (const connection of playerConnections.values()) {
    if (
      connection === exceptConnection ||
      connection.open === false
    ) {
      continue;
    }

    sendJson(connection, data);
  }
}

function sendDmChat() {
  const input =
    document.querySelector('#chatInput');

  const text =
    input?.value.trim();

  if (!text) return;

  const message =
    addChatMessage({
      from: 'DM',
      text,
    });

  broadcast({
    type: 'chat',
    message,
  });

  if (input) {
    input.value = '';
    input.focus();
  }
}

function sendPlayerChat() {
  const input =
    document.querySelector('#chatInput');

  const text =
    input?.value.trim();

  if (!text || !currentConnection?.open) {
    return;
  }

  sendJson(currentConnection, {
    type: 'chat',
    text,
  });

  if (input) {
    input.value = '';
    input.focus();
  }
}

function handlePlayerAction(event) {
  const button =
    event.target.closest('button');

  if (!button) return;

  const playerId =
    button.dataset.player;

  const action =
    button.dataset.action;

  const player =
    findPlayer(playerId);

  if (!player) return;

  if (action === 'approve') {
    player.approved = true;
    player.banned = false;

    saveCampaign();

    const connection =
      [...playerConnections.entries()]
        .map(([id, connection]) => ({
          id,
          connection,
        }))
        .find(item =>
          item.connection.peer === player.peerId,
        )?.connection;

    if (connection) {
      approveConnection(
        connection,
        player,
      );
    }

    addChatMessage({
      from: 'System',
      text: `${player.name} approved.`,
      system: true,
    });

    broadcast({
      type: 'system',
      text: `${player.name} was approved.`,
    });

    render();

    return;
  }

  if (action === 'kick') {
    kickPlayer(player);
    return;
  }

  if (action === 'ban') {
    if (player.banned) {
      player.banned = false;

      saveCampaign();

      addChatMessage({
        from: 'System',
        text: `${player.name} unbanned.`,
        system: true,
      });

      render();

      return;
    }

    banPlayer(player);
  }
}

function kickPlayer(player) {
  for (const connection of playerConnections.values()) {
    if (connection.peer === player.peerId) {
      sendJson(connection, {
        type: 'kicked',
      });

      setTimeout(() => {
        try {
          connection.close();
        } catch {}
      }, 200);
    }
  }

  player.connected = false;

  saveCampaign();

  addChatMessage({
    from: 'System',
    text: `${player.name} was kicked.`,
    system: true,
  });

  render();
}

function banPlayer(player) {
  player.banned = true;
  player.approved = false;
  player.connected = false;

  for (const connection of playerConnections.values()) {
    if (connection.peer === player.peerId) {
      sendJson(connection, {
        type: 'banned',
      });

      setTimeout(() => {
        try {
          connection.close();
        } catch {}
      }, 200);
    }
  }

  saveCampaign();

  addChatMessage({
    from: 'System',
    text: `${player.name} was banned.`,
    system: true,
  });

  render();
}

function startDmHeartbeat() {
  stopDmHeartbeat();

  heartbeatTimer = setInterval(() => {
    const cutoff = now() - STALE_MS;

    for (const player of campaign.players) {
      if (
        player.connected &&
        player.lastSeen < cutoff
      ) {
        player.connected = false;

        log(
          `player ${player.name} considered stale`,
        );
      }
    }

    for (const connection of playerConnections.values()) {
      sendJson(connection, {
        type: 'heartbeat',
        ts: now(),
      });
    }

    saveCampaign();
    renderPlayers();
    renderStatus();
  }, HEARTBEAT_MS);

  staleTimer = setInterval(() => {
    const cutoff = now() - STALE_MS;

    for (const [id, connection] of playerConnections) {
      const player =
        findPlayerByPeerId(connection.peer);

      if (
        player &&
        player.lastSeen < cutoff
      ) {
        log(
          `closing stale connection ` +
          `${connection.peer}`,
        );

        try {
          connection.close();
        } catch {}

        playerConnections.delete(id);
        playerByConnection.delete(id);
      }
    }

    renderPlayers();
  }, STALE_CHECK_MS);
}

function stopDmHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (staleTimer) {
    clearInterval(staleTimer);
    staleTimer = null;
  }
}

function closeDmSession() {
  sessionOpen = false;

  stopDmHeartbeat();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  for (const connection of playerConnections.values()) {
    try {
      connection.close();
    } catch {}
  }

  playerConnections.clear();
  playerByConnection.clear();

  if (peer) {
    try {
      peer.destroy();
    } catch {}

    peer = null;
  }

  mode = null;
  roomId = null;
  myPeerId = null;
  sessionPin = '';

  log('DM session closed');

  render();
}

function startPlayer() {
  mode = 'player';
  playerDestroyed = false;

  render();

  log(
    `VTTRPG v${APP_VERSION} Player view started`,
  );

  const params =
    new URLSearchParams(
      window.location.search,
    );

  const room =
    params.get('join');

  if (room) {
    const input =
      document.querySelector('#roomInput');

    if (input) {
      input.value = room;
    }
  }
}

function connectAsPlayer() {
  if (!roomId) {
    log('player connect aborted: no room id');
    return;
  }

  if (currentConnection) {
    try {
      currentConnection.close();
    } catch {}

    currentConnection = null;
  }

  if (peer) {
    try {
      peer.destroy();
    } catch {}

    peer = null;
  }

  if (playerConnectTimer) {
    clearTimeout(playerConnectTimer);
    playerConnectTimer = null;
  }

  if (playerReconnectTimer) {
    clearTimeout(playerReconnectTimer);
    playerReconnectTimer = null;
  }

  playerDestroyed = false;

  const hostId =
    peerIdForRoom(roomId);

  const temporaryPeerId =
    `vttrpg-player-${randomId(16)}`;

  log(
    `creating temporary player peer ${temporaryPeerId}`,
  );

  try {
    peer = createPeer({
      relayOnly: !!settings.relayOnly,
    });

    peer.on('open', id => {
      log(
        `player PeerJS signaling connected as ${id}`,
      );

      playerReconnectAttempt = 0;

      connectPlayerToDm(hostId);
    });

    peer.on('disconnected', () => {
      if (playerDestroyed) return;

      log(
        'player PeerJS signaling disconnected',
      );
    });

    peer.on('close', () => {
      log('player PeerJS object closed');
    });
  } catch (error) {
    log(
      `player PeerJS creation failed: ` +
      `${error.message}`,
    );

    schedulePlayerReconnect();
  }
}

function connectPlayerToDm(hostId) {
  if (
    playerDestroyed ||
    !peer ||
    peer.destroyed
  ) {
    return;
  }

  log(
    `connecting to DM ${hostId} ` +
    `(attempt ${playerReconnectAttempt + 1})…`,
  );

  let connection;

  try {
    connection = peer.connect(
      hostId,
      {
        reliable: true,
        serialization: 'json',
      },
    );
  } catch (error) {
    log(
      `peer.connect failed: ${error.message}`,
    );

    schedulePlayerReconnect();
    return;
  }

  currentConnection = connection;

  attachConnectionDiagnostics(
    connection,
    'player rtc',
  );

  let opened = false;
  let settled = false;

  playerConnectTimer =
    setTimeout(async () => {
      if (
        settled ||
        playerDestroyed ||
        currentConnection !== connection
      ) {
        return;
      }

      log(
        `player connection timed out after ` +
        `${CONNECT_TIMEOUT_MS}ms; ` +
        `${connectionSummary(connection)}`,
      );

      await logIceDiagnostics(
        connection,
        'player timeout: ',
      );

      settled = true;

      try {
        connection.close();
      } catch {}

      schedulePlayerReconnect();
    }, CONNECT_TIMEOUT_MS);

  connection.on('open', () => {
    opened = true;
    settled = true;

    if (playerConnectTimer) {
      clearTimeout(playerConnectTimer);
      playerConnectTimer = null;
    }

    log(
      `player data channel open; ` +
      `${connectionSummary(connection)}`,
    );

    sendJson(connection, {
      type: 'hello',
      name: playerName,
      pin: sessionPin,
      version: APP_VERSION,
      clientTime: now(),
    });

    renderStatus();
  });

  connection.on('data', data => {
    handlePlayerData(data);
  });

  connection.on('close', async () => {
    log(
      `player connection closed; ` +
      `opened=${opened}`,
    );

    if (playerConnectTimer) {
      clearTimeout(playerConnectTimer);
      playerConnectTimer = null;
    }

    if (
      !playerDestroyed &&
      currentConnection === connection
    ) {
      currentConnection = null;

      if (!opened) {
        await logIceDiagnostics(
          connection,
          'player close before open: ',
        );
      }

      schedulePlayerReconnect();
    }

    renderStatus();
  });

  connection.on('error', error => {
    log(
      `player connection error: ` +
      `${error?.message || error}`,
    );
  });
}

function schedulePlayerReconnect() {
  if (playerDestroyed) {
    return;
  }

  if (playerReconnectTimer) {
    return;
  }

  playerReconnectAttempt++;

  const delay =
    Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS *
      Math.pow(
        2,
        playerReconnectAttempt - 1,
      ),
    );

  log(
    `player reconnect attempt ` +
    `${playerReconnectAttempt} in ${delay}ms…`,
  );

  playerReconnectTimer =
    setTimeout(() => {
      playerReconnectTimer = null;

      if (playerDestroyed) {
        return;
      }

      connectAsPlayer();
    }, delay);

  renderStatus();
}

function handlePlayerData(data) {
  if (!data || typeof data !== 'object') {
    return;
  }

  if (data.type === 'hello') {
    return;
  }

  if (data.type === 'approvalRequired') {
    log(
      'DM received join request; waiting for approval.',
    );

    updateConnectionInfo(
      'Waiting for DM approval…',
    );

    return;
  }

  if (data.type === 'joinAccepted') {
    playerId =
      data.player?.id || null;

    log(
      `join accepted as ` +
      `${data.player?.name || playerName} ` +
      `(#${data.player?.number || '?'})`,
    );

    updateConnectionInfo(
      `Approved as ${data.player?.name || playerName}` +
      ` (#${data.player?.number || '?'})`,
    );

    if (Array.isArray(data.chat)) {
      campaign.chat = data.chat.slice(-MAX_CHAT);
      renderChat();
    }

    return;
  }

  if (data.type === 'chat') {
    if (data.message) {
      campaign.chat.push(data.message);

      if (campaign.chat.length > MAX_CHAT) {
        campaign.chat.splice(
          0,
          campaign.chat.length - MAX_CHAT,
        );
      }

      renderChat();
    }

    return;
  }

  if (data.type === 'heartbeat') {
    sendJson(currentConnection, {
      type: 'heartbeat',
      ts: now(),
    });

    return;
  }

  if (data.type === 'heartbeatAck') {
    return;
  }

  if (data.type === 'pong') {
    return;
  }

  if (data.type === 'system') {
    addLocalSystemMessage(data.text);
    return;
  }

  if (data.type === 'kicked') {
    addLocalSystemMessage(
      'You were kicked by the DM.',
    );

    disconnectPlayer();

    return;
  }

  if (data.type === 'banned') {
    addLocalSystemMessage(
      'You were banned by the DM.',
    );

    disconnectPlayer();

    return;
  }

  if (data.type === 'joinRejected') {
    let message =
      'Join rejected.';

    if (data.reason === 'wrong_pin') {
      message =
        'Wrong PIN.';
    }

    if (data.reason === 'banned') {
      message =
        'You are banned from this campaign.';
    }

    addLocalSystemMessage(message);

    log(`join rejected: ${data.reason}`);

    return;
  }
}

function addLocalSystemMessage(text) {
  campaign.chat.push({
    id: randomId(12),
    ts: now(),
    from: 'System',
    text: String(text || ''),
    system: true,
  });

  if (campaign.chat.length > MAX_CHAT) {
    campaign.chat.splice(
      0,
      campaign.chat.length - MAX_CHAT,
    );
  }

  renderChat();
}

function updateConnectionInfo(text) {
  const el =
    document.querySelector('#connectionInfo');

  if (el) {
    el.textContent = text;
  }
}

function disconnectPlayer() {
  playerDestroyed = true;

  if (playerConnectTimer) {
    clearTimeout(playerConnectTimer);
    playerConnectTimer = null;
  }

  if (playerReconnectTimer) {
    clearTimeout(playerReconnectTimer);
    playerReconnectTimer = null;
  }

  if (currentConnection) {
    try {
      currentConnection.close();
    } catch {}

    currentConnection = null;
  }

  if (peer) {
    try {
      peer.destroy();
    } catch {}

    peer = null;
  }

  log('player disconnected');

  updateConnectionInfo(
    'Disconnected.',
  );

  renderStatus();
}

function installGlobalEvents() {
  window.addEventListener(
    'online',
    () => {
      log('network is online');

      if (
        mode === 'player' &&
        !currentConnection &&
        !playerReconnectTimer &&
        !playerDestroyed
      ) {
        schedulePlayerReconnect();
      }
    },
  );

  window.addEventListener(
    'offline',
    () => {
      log('network is offline');
    },
  );

  document.addEventListener(
    'visibilitychange',
    () => {
      log(
        `tab is now ${
          document.hidden
            ? 'hidden'
            : 'visible'
        }`,
      );

      if (
        !document.hidden &&
        mode === 'player' &&
        !currentConnection &&
        !playerReconnectTimer &&
        !playerDestroyed
      ) {
        schedulePlayerReconnect();
      }
    },
  );

  window.addEventListener(
    'beforeunload',
    () => {
      playerDestroyed = true;

      if (peer) {
        try {
          peer.destroy();
        } catch {}
      }
    },
  );
}

function bootstrap() {
  app =
    document.querySelector('#app');

  loadSettings();
  loadCampaign();

  log(
    `VTTRPG v${APP_VERSION} bootstrap`,
  );

  describeEnvironment();

  if (!isPeerLoaded()) {
    log(
      'ERROR: PeerJS is not available. ' +
      'Check the PeerJS script in index.html.',
    );
  }

  installGlobalEvents();

  const params =
    new URLSearchParams(
      window.location.search,
    );

  const joinRoom =
    params.get('join');

  render();

  if (joinRoom) {
    mode = 'player';

    render();

    const roomInput =
      document.querySelector('#roomInput');

    if (roomInput) {
      roomInput.value = joinRoom;
    }

    log(
      `join link detected for room ${joinRoom}`,
    );
  }
}

if (
  document.readyState === 'loading'
) {
  document.addEventListener(
    'DOMContentLoaded',
    bootstrap,
  );
} else {
  bootstrap();
}