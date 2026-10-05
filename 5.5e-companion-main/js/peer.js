// PeerJS communication layer for DnD Companion
// DM acts as host, players connect via WebRTC data channels

const DND_PEER_PREFIX = 'dnd-companion-';

// Use PeerJS public cloud server (no self-hosted signaling needed for static hosting)
const PEER_SERVER_CONFIG = {};

const STALE_CONNECTION_TIMEOUT = 60000; // 60s without ping = stale
const STALE_CHECK_INTERVAL = 15000;     // check every 15s

// --- DM (Host) Side ---

function createDMPeer(roomId) {
  const peerId = DND_PEER_PREFIX + roomId;
  const connections = new Map(); // peerId -> { conn, playerName, characterId, lastActivity }
  let peer = null;
  let _onPlayerConnect = null;
  let _onPlayerDisconnect = null;
  let _onPlayerMessage = null;
  let _onSignalingDisconnect = null;
  let _onSignalingReconnect = null;
  let _destroyed = false;
  let _staleCheckTimer = null;

  function init() {
    return new Promise((resolve, reject) => {
      _tryInit(resolve, reject, 0);
    });
  }

  function _tryInit(resolve, reject, attempt) {
    peer = new Peer(peerId, PEER_SERVER_CONFIG);
    peer.on('open', (id) => {
      console.log('[Peer] DM peer open:', id);
      _attachPeerEvents();
      resolve(id);
    });
    peer.on('error', (err) => {
      console.error('[Peer] DM error:', err);
      if (err.type === 'unavailable-id' && attempt < 3) {
        // Signaling server may still hold the old session after a page refresh.
        // Wait with increasing delay then retry.
        const delay = 2000 * (attempt + 1);
        console.log(`[Peer] Peer ID in use, retrying in ${delay}ms (attempt ${attempt + 1}/3)...`);
        peer.destroy();
        setTimeout(() => { if (!_destroyed) _tryInit(resolve, reject, attempt + 1); }, delay);
      } else {
        reject(new Error(
          err.type === 'unavailable-id'
            ? 'Session ID is still held by another connection. Wait a moment and try again.'
            : 'Connection error: ' + err.type
        ));
      }
    });
    peer.on('connection', _handleIncomingConnection);
  }

  function _attachPeerEvents() {
    peer.on('disconnected', () => {
      if (_destroyed) return;
      console.log('[Peer] DM lost signaling server connection, attempting to reclaim...');
      if (_onSignalingDisconnect) _onSignalingDisconnect();
      // Reconnect to signaling server to keep the peer ID alive.
      setTimeout(() => {
        if (!_destroyed && peer && !peer.destroyed) peer.reconnect();
      }, 1000);
    });
    peer.on('open', () => {
      // Fires again after a successful peer.reconnect()
      if (_onSignalingReconnect) _onSignalingReconnect();
    });
  }

  function _handleIncomingConnection(conn) {
    conn.on('open', () => {
      connections.set(conn.peer, { conn, playerName: null, characterId: null, lastActivity: Date.now() });
      if (_onPlayerConnect) _onPlayerConnect(conn.peer);
      _ensureStaleCheck();
    });
    conn.on('data', (data) => {
      // Update last activity timestamp on any incoming data.
      const entry = connections.get(conn.peer);
      if (entry) entry.lastActivity = Date.now();
      // Respond to keep-alive pings so players can verify the link is alive.
      if (data && data.type === 'ping') {
        try { conn.send({ type: 'pong', ts: data.ts }); } catch (e) {}
      }
      if (_onPlayerMessage) _onPlayerMessage(conn.peer, data);
    });
    conn.on('close', () => {
      const info = connections.get(conn.peer);
      connections.delete(conn.peer);
      if (_onPlayerDisconnect) _onPlayerDisconnect(conn.peer, info);
    });
    conn.on('error', () => {
      const info = connections.get(conn.peer);
      connections.delete(conn.peer);
      if (_onPlayerDisconnect) _onPlayerDisconnect(conn.peer, info);
    });
  }

  function _ensureStaleCheck() {
    if (_staleCheckTimer) return;
    _staleCheckTimer = setInterval(() => {
      if (_destroyed) { clearInterval(_staleCheckTimer); _staleCheckTimer = null; return; }
      const now = Date.now();
      for (const [id, entry] of connections) {
        if (now - entry.lastActivity > STALE_CONNECTION_TIMEOUT) {
          console.log('[Peer] Stale connection detected:', id);
          connections.delete(id);
          try { entry.conn.close(); } catch (e) {}
          if (_onPlayerDisconnect) _onPlayerDisconnect(id, entry);
        }
      }
      if (connections.size === 0) {
        clearInterval(_staleCheckTimer);
        _staleCheckTimer = null;
      }
    }, STALE_CHECK_INTERVAL);
  }

  function broadcastToAll(message) {
    for (const { conn } of connections.values()) {
      try { conn.send(message); } catch (e) {}
    }
  }

  function sendToPlayer(peerId, message) {
    const entry = connections.get(peerId);
    if (entry) {
      try { entry.conn.send(message); } catch (e) {}
    }
  }

  function setPlayerInfo(peerId, playerName, characterId) {
    const entry = connections.get(peerId);
    if (entry) {
      entry.playerName = playerName;
      entry.characterId = characterId;
    }
  }

  function getConnectedPlayers() {
    const players = [];
    for (const [id, entry] of connections) {
      players.push({
        peerId: id,
        playerName: entry.playerName,
        characterId: entry.characterId,
        alive: !!(entry.conn && entry.conn.open)
      });
    }
    return players;
  }

  function broadcastToCharacter(characterId, message) {
    for (const { conn, characterId: cid } of connections.values()) {
      if (cid === characterId) {
        try { conn.send(message); } catch (e) {}
      }
    }
  }

  function isConnected() {
    return peer && !peer.disconnected && !peer.destroyed;
  }

  function destroy() {
    _destroyed = true;
    if (_staleCheckTimer) { clearInterval(_staleCheckTimer); _staleCheckTimer = null; }
    if (peer) {
      peer.destroy();
      peer = null;
    }
    connections.clear();
  }

  return {
    init,
    broadcastToAll,
    sendToPlayer,
    setPlayerInfo,
    getConnectedPlayers,
    broadcastToCharacter,
    isConnected,
    destroy,
    onPlayerConnect(cb) { _onPlayerConnect = cb; },
    onPlayerDisconnect(cb) { _onPlayerDisconnect = cb; },
    onPlayerMessage(cb) { _onPlayerMessage = cb; },
    onSignalingDisconnect(cb) { _onSignalingDisconnect = cb; },
    onSignalingReconnect(cb) { _onSignalingReconnect = cb; }
  };
}

// --- Player Side ---

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const CONNECT_TIMEOUT_MS = 10000;

function createPlayerPeer(roomId) {
  const hostPeerId = DND_PEER_PREFIX + roomId;
  let peer = null;
  let conn = null;
  let _onMessage = null;
  let _onDisconnect = null;
  let _onConnect = null;
  let _onReconnecting = null;
  let _destroyed = false;
  let _reconnectAttempt = 0;
  let _reconnectTimer = null;
  let _heartbeatInterval = null;

  function connect() {
    return new Promise((resolve, reject) => {
      _destroyed = false;
      _createPeer(resolve, reject);
    });
  }

  function _createPeer(resolve, reject) {
    if (peer && !peer.destroyed) peer.destroy();
    peer = new Peer(undefined, PEER_SERVER_CONFIG);

    peer.on('open', () => {
      _openConnection(resolve, reject);
    });

    peer.on('disconnected', () => {
      if (_destroyed) return;
      console.log('[Peer] Player lost signaling server connection, reconnecting...');
      setTimeout(() => {
        if (!_destroyed && peer && !peer.destroyed) peer.reconnect();
      }, 1000);
    });

    peer.on('error', (err) => {
      console.error('[Peer] Player peer error:', err);
      if (reject) { const r = reject; reject = null; r(err); }
      else _scheduleReconnect();
    });
  }

  function _openConnection(resolve, reject) {
    conn = peer.connect(hostPeerId, { reliable: true });
    let opened = false;

    const timeout = setTimeout(() => {
      if (!opened) {
        console.warn('[Peer] Connection to DM timed out');
        conn.close();
        if (reject) { const r = reject; reject = null; r(new Error('Connection timed out')); }
        else _scheduleReconnect();
      }
    }, CONNECT_TIMEOUT_MS);

    conn.on('open', () => {
      opened = true;
      clearTimeout(timeout);
      _reconnectAttempt = 0;
      console.log('[Peer] Connected to DM');
      _startHeartbeat();
      if (resolve) { const r = resolve; resolve = null; r(); }
      if (_onConnect) _onConnect();
    });

    conn.on('data', (data) => {
      if (_onMessage) _onMessage(data);
    });

    conn.on('close', () => {
      clearTimeout(timeout);
      _stopHeartbeat();
      console.log('[Peer] Disconnected from DM (close)');
      if (_onDisconnect) _onDisconnect();
      _scheduleReconnect();
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      _stopHeartbeat();
      console.error('[Peer] Connection error:', err);
      if (_onDisconnect) _onDisconnect();
      _scheduleReconnect();
    });
  }

  function _scheduleReconnect() {
    if (_destroyed || _reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, _reconnectAttempt), RECONNECT_MAX_DELAY);
    _reconnectAttempt++;
    console.log(`[Peer] Reconnecting in ${delay}ms (attempt ${_reconnectAttempt})`);
    if (_onReconnecting) _onReconnecting(_reconnectAttempt, delay);
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      if (!_destroyed) _doReconnect();
    }, delay);
  }

  function _doReconnect() {
    if (_destroyed) return;
    console.log('[Peer] Attempting reconnect...');
    if (peer && !peer.destroyed) {
      _openConnection(null, null);
    } else {
      _createPeer(null, null);
    }
  }

  function reconnectNow() {
    if (_destroyed || isConnected()) return;
    cancelReconnect();
    _doReconnect();
  }

  function cancelReconnect() {
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    _reconnectAttempt = 0;
  }

  function _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatInterval = setInterval(() => {
      if (isConnected()) {
        try { conn.send({ type: 'ping', ts: Date.now() }); } catch (e) {}
      }
    }, 30000);
  }

  function _stopHeartbeat() {
    if (_heartbeatInterval) {
      clearInterval(_heartbeatInterval);
      _heartbeatInterval = null;
    }
  }

  function sendToDM(message) {
    if (conn && conn.open) {
      conn.send(message);
    }
  }

  function isConnected() {
    return !!(conn && conn.open);
  }

  function destroy() {
    _destroyed = true;
    cancelReconnect();
    _stopHeartbeat();
    if (peer) {
      peer.destroy();
      peer = null;
    }
    conn = null;
  }

  return {
    connect,
    sendToDM,
    isConnected,
    reconnectNow,
    cancelReconnect,
    destroy,
    onMessage(cb) { _onMessage = cb; },
    onDisconnect(cb) { _onDisconnect = cb; },
    onConnect(cb) { _onConnect = cb; },
    onReconnecting(cb) { _onReconnecting = cb; }
  };
}

window.peerManager = { createDMPeer, createPlayerPeer };
