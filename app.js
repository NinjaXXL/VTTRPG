// VTTRPG Skeleton
// Version 0.7.1
//
// Architecture:
//   DM:
//     stable PeerJS ID = "vttrpg-<roomId>"
//   Player:
//     temporary random PeerJS ID
//   Signaling:
//     PeerJS cloud
//   Game/chat data:
//     direct WebRTC data channel via PeerJS
//
// v0.7.1 fixes:
//   - DM PeerJS ID is explicitly passed to new Peer(...)
//   - PIN completely removed
//   - QR code restored
//   - Chat restored
//   - Player reconnects reuse the player PeerJS instance
//   - Explicit STUN configuration
//   - Optional user supplied TURN
//   - Better WebRTC diagnostics
//   - Stable player token per browser tab
//   - Approval/open/locked session modes

const APP_VERSION = '0.7.1';
const PEERJS_VERSION = '1.5.5';

const PEER_PREFIX = 'vttrpg-';

const LS_CAMPAIGNS = 'vttrpg:campaigns:v071';
const LS_NAME = 'vttrpg:playerName';
const LS_TURN = 'vttrpg:turn:v071';
const SS_TOKEN = 'vttrpg:playerToken:v071';

const CONNECT_TIMEOUT_MS = 15000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const HEARTBEAT_MS = 30000;
const STALE_CHECK_MS = 15000;
const STALE_MS = 60000;

const JOIN_REPLY_TIMEOUT_MS = 10000;

const MAX_CHAT = 1000;

const STUN_SERVERS = [
  {
    urls: 'stun:stun.l.google.com:19302',
  },
  {
    urls: 'stun:stun.cloudflare.com:3478',
  },
];

let activeLog = null;

// ---------------------------------------------------------------------------
// Global diagnostics
// ---------------------------------------------------------------------------

const safeStr = value => {
  try {
    if (typeof value === 'string') {
      return value;
    }

    return (
      value?.message ||
      JSON.stringify(value)
    );
  } catch {
    return String(value);
  }
};

for (const level of ['warn', 'error']) {
  const original = console[level].bind(console);

  console[level] = (...args) => {
    original(...args);

    try {
      activeLog?.(
        `console.${level}: ` +
        args.map(safeStr).join(' ').slice(0, 500)
      );
    } catch {
      // Ignore logger failures.
    }
  };
}

window.addEventListener('error', event => {
  activeLog?.(
    `window error: ${event.message}`
  );
});

window.addEventListener('unhandledrejection', event => {
  activeLog?.(
    `unhandled rejection: ${safeStr(event.reason)}`
  );
});

window.addEventListener('online', () => {
  activeLog?.('browser went ONLINE');
});

window.addEventListener('offline', () => {
  activeLog?.('browser went OFFLINE');
});

document.addEventListener(
  'visibilitychange',
  () => {
    activeLog?.(
      `tab is now ${
        document.visibilityState
      }`
    );
  }
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const short = id =>
  String(id || '').slice(0, 10);

const rid = (length = 12) => {
  const chars =
    'abcdefghijklmnopqrstuvwxyz0123456789';

  const bytes =
    new Uint8Array(length);

  crypto.getRandomValues(bytes);

  return [...bytes]
    .map(b => chars[b % chars.length])
    .join('');
};

const h = (
  tag,
  props = {},
  ...kids
) => {
  const element =
    document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) {
      element.addEventListener(
        key.slice(2),
        value
      );
    } else if (key === 'class') {
      element.className = value;
    } else if (key === 'checked') {
      element.checked = !!value;
    } else {
      element.setAttribute(
        key,
        value
      );
    }
  }

  for (const child of kids.flat()) {
    if (
      child === null ||
      child === undefined ||
      child === false
    ) {
      continue;
    }

    element.append(
      child instanceof Node
        ? child
        : String(child)
    );
  }

  return element;
};

// ---------------------------------------------------------------------------
// URL-safe base64 helpers for optional TURN settings in join links
// ---------------------------------------------------------------------------

const b64e = object => {
  const bytes =
    new TextEncoder().encode(
      JSON.stringify(object)
    );

  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

const b64d = text => {
  const normalized =
    text
      .replace(/-/g, '+')
      .replace(/_/g, '/');

  const binary =
    atob(
      normalized +
      '='.repeat(
        (4 - (normalized.length % 4)) % 4
      )
    );

  const bytes =
    Uint8Array.from(
      binary,
      char => char.charCodeAt(0)
    );

  return JSON.parse(
    new TextDecoder().decode(bytes)
  );
};

function parseOpts(queryString) {
  const params =
    new URLSearchParams(
      queryString
    );

  let turn = null;

  try {
    const encoded =
      params.get('t');

    if (encoded) {
      const parsed =
        b64d(encoded);

      const urls =
        []
          .concat(parsed?.urls || [])
          .map(String)
          .filter(url =>
            /^(turns?|stuns?):/i.test(url)
          );

      if (urls.length) {
        turn = {
          urls,
          username:
            String(
              parsed.username || ''
            ),
          credential:
            String(
              parsed.credential || ''
            ),
        };
      }
    }
  } catch (error) {
    console.warn(
      'Could not parse TURN options:',
      error
    );
  }

  return {
    turn,
    relayOnly:
      params.get('r') === '1',
  };
}

// ---------------------------------------------------------------------------
// ICE / PeerJS configuration
// ---------------------------------------------------------------------------

function getIceConfig({
  turn = null,
  relayOnly = false,
  log = () => {},
} = {}) {
  const iceServers = [
    ...STUN_SERVERS,
  ];

  if (
    turn &&
    Array.isArray(turn.urls) &&
    turn.urls.length
  ) {
    iceServers.push({
      urls: turn.urls,
      username:
        turn.username || '',
      credential:
        turn.credential || '',
    });
  }

  const config = {
    iceServers,

    // Helps gathering start consistently.
    iceCandidatePoolSize: 4,

    // PeerJS works with unified-plan in modern browsers.
    sdpSemantics: 'unified-plan',
  };

  if (relayOnly) {
    config.iceTransportPolicy = 'relay';
  }

  log(
    `ICE config: ` +
    `STUN Google + Cloudflare` +
    (
      turn
        ? ` + TURN ${turn.urls.join(', ')}`
        : ' + no TURN'
    ) +
    (
      relayOnly
        ? ' | RELAY-ONLY'
        : ''
    )
  );

  if (
    relayOnly &&
    !turn
  ) {
    log(
      'WARNING: relay-only mode was requested ' +
      'without a TURN server.'
    );
  }

  return {
    config,
  };
}

function getTurnFromLocalStorage() {
  try {
    return (
      JSON.parse(
        localStorage.getItem(
          LS_TURN
        )
      ) || {}
    );
  } catch {
    return {};
  }
}

function saveTurnToLocalStorage(turn) {
  try {
    localStorage.setItem(
      LS_TURN,
      JSON.stringify(turn)
    );
  } catch (error) {
    console.error(
      'Could not save TURN settings:',
      error
    );
  }
}

// ---------------------------------------------------------------------------
// WebRTC diagnostics
// ---------------------------------------------------------------------------

function getUnderlyingPc(connection) {
  return (
    connection?.peerConnection ||
    connection?._pc ||
    null
  );
}

function candidateTypeFromLine(line) {
  return (
    /\btyp\s+(\w+)/i.exec(
      String(line || '')
    )?.[1] ||
    null
  );
}

async function logConnectionStats(
  connection,
  label = 'RTC'
) {
  const pc =
    getUnderlyingPc(connection);

  if (!pc) {
    activeLog?.(
      `${label}: no underlying RTCPeerConnection`
    );
    return;
  }

  const summary = {
    ice:
      pc.iceConnectionState,
    connection:
      pc.connectionState,
    gathering:
      pc.iceGatheringState,
    signaling:
      pc.signalingState,
    pairs: [],
  };

  try {
    const stats =
      await pc.getStats();

    stats.forEach(report => {
      if (
        report.type !==
        'candidate-pair'
      ) {
        return;
      }

      const local =
        stats.get(
          report.localCandidateId
        );

      const remote =
        stats.get(
          report.remoteCandidateId
        );

      summary.pairs.push({
        state:
          report.state,
        nominated:
          !!report.nominated,
        selected:
          !!report.selected,
        local:
          local?.candidateType ||
          '?',
        localProtocol:
          local?.protocol ||
          '?',
        remote:
          remote?.candidateType ||
          '?',
        remoteProtocol:
          remote?.protocol ||
          '?',
        requestsSent:
          report.requestsSent ||
          0,
        responsesReceived:
          report.responsesReceived ||
          0,
      });
    });
  } catch (error) {
    summary.statsError =
      error.message;
  }

  activeLog?.(
    `${label}: ICE diagnostics: ` +
    JSON.stringify(summary)
  );
}

function attachRtcDiagnostics(
  connection,
  label
) {
  const pc =
    getUnderlyingPc(connection);

  if (!pc) {
    activeLog?.(
      `${label}: RTCPeerConnection not ` +
      `available yet`
    );
    return;
  }

  pc.addEventListener(
    'icecandidateerror',
    event => {
      activeLog?.(
        `${label}: ICE candidate error ` +
        `${event.errorCode || ''} ` +
        `${event.url || ''} ` +
        `${event.errorText || ''}`
      );
    }
  );

  pc.addEventListener(
    'iceconnectionstatechange',
    () => {
      activeLog?.(
        `${label}: ice=${pc.iceConnectionState}`
      );

      if (
        pc.iceConnectionState ===
        'failed'
      ) {
        logConnectionStats(
          connection,
          `${label} FAILURE`
        );
      }
    }
  );

  pc.addEventListener(
    'connectionstatechange',
    () => {
      activeLog?.(
        `${label}: conn=${pc.connectionState}`
      );

      if (
        pc.connectionState ===
        'connected'
      ) {
        setTimeout(
          () =>
            logConnectionStats(
              connection,
              `${label} CONNECTED`
            ),
          500
        );
      }

      if (
        pc.connectionState ===
        'failed'
      ) {
        logConnectionStats(
          connection,
          `${label} FAILURE`
        );
      }
    }
  );

  pc.addEventListener(
    'icegatheringstatechange',
    () => {
      activeLog?.(
        `${label}: gathering=${pc.iceGatheringState}`
      );
    }
  );

  pc.addEventListener(
    'signalingstatechange',
    () => {
      activeLog?.(
        `${label}: signaling=${pc.signalingState}`
      );
    }
  );
}

// ---------------------------------------------------------------------------
// PeerJS DM transport
// ---------------------------------------------------------------------------

function createDMPeer(
  roomId,
  {
    log,
    turn = null,
    relayOnly = false,
    onPlayerConnect,
    onPlayerDisconnect,
    onMessage,
    onSignaling,
  }
) {
  const peerId =
    PEER_PREFIX + roomId;

  const connections =
    new Map();

  let peer = null;
  let destroyed = false;
  let opened = false;

  let staleTimer = null;
  let signalingReconnectTimer = null;

  let signalingAttempt = 0;

  const opts =
    getIceConfig({
      turn,
      relayOnly,
      log,
    });

  function init() {
    return new Promise(
      (resolve, reject) => {
        tryInit(
          resolve,
          reject,
          0
        );
      }
    );
  }

  function tryInit(
    resolve,
    reject,
    attempt
  ) {
    if (destroyed) {
      reject(
        new Error(
          'DM peer was destroyed'
        )
      );
      return;
    }

    opened = false;

    log(
      `registering ${peerId} at the ` +
      `PeerJS cloud (attempt ${attempt + 1})…`
    );

    // CRITICAL:
    // The DM MUST pass the stable room peer ID
    // as the first argument.
    peer =
      new window.Peer(
        peerId,
        {
          debug: 0,
          ...opts,
        }
      );

    peer.on(
      'open',
      id => {
        if (!opened) {
          opened = true;

          log(
            `PeerJS signaling connected ` +
            `as ${id}`
          );

          resolve(id);

          return;
        }

        signalingAttempt = 0;

        if (
          signalingReconnectTimer
        ) {
          clearTimeout(
            signalingReconnectTimer
          );

          signalingReconnectTimer =
            null;
        }

        log(
          `DM signaling re-established ` +
          `as ${id}`
        );

        onSignaling?.(
          'connected'
        );
      }
    );

    peer.on(
      'connection',
      connection => {
        handleIncoming(
          connection
        );
      }
    );

    peer.on(
      'disconnected',
      () => {
        if (
          destroyed ||
          !opened
        ) {
          return;
        }

        scheduleSignalingReconnect();
      }
    );

    peer.on(
      'error',
      error => {
        if (destroyed) {
          return;
        }

        log(
          `PeerJS error ` +
          `(${error?.type || 'unknown'}): ` +
          `${safeStr(error)}`
        );

        if (!opened) {
          if (
            error?.type ===
              'unavailable-id' &&
            attempt < 5
          ) {
            const delay =
              Math.min(
                10000,
                1500 *
                Math.pow(
                  2,
                  attempt
                )
              );

            log(
              `DM peer ID is still held by ` +
              `the signaling server; retrying ` +
              `in ${delay} ms…`
            );

            try {
              peer.destroy();
            } catch {}

            setTimeout(
              () => {
                if (!destroyed) {
                  tryInit(
                    resolve,
                    reject,
                    attempt + 1
                  );
                }
              },
              delay
            );

            return;
          }

          reject(
            new Error(
              error?.type ===
                'unavailable-id'
                ? 'The stable DM room ID is still in use. ' +
                  'Wait a moment and reopen the session.'
                : (
                  'PeerJS connection error: ' +
                  (
                    error?.type ||
                    safeStr(error)
                  )
                )
            )
          );

          return;
        }

        if (
          peer.disconnected
        ) {
          scheduleSignalingReconnect();
        }
      }
    );
  }

  function scheduleSignalingReconnect() {
    if (
      destroyed ||
      signalingReconnectTimer
    ) {
      return;
    }

    signalingAttempt++;

    const delay =
      Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS *
        Math.pow(
          2,
          signalingAttempt - 1
        )
      );

    log(
      `DM signaling lost; ` +
      `reconnecting in ${delay} ms ` +
      `(attempt ${signalingAttempt})`
    );

    onSignaling?.(
      'reconnecting'
    );

    signalingReconnectTimer =
      setTimeout(
        () => {
          signalingReconnectTimer =
            null;

          if (
            destroyed ||
            !peer ||
            peer.destroyed
          ) {
            return;
          }

          if (
            peer.disconnected
          ) {
            try {
              log(
                'calling peer.reconnect()'
              );

              peer.reconnect();
            } catch (error) {
              log(
                `peer.reconnect failed: ` +
                `${error.message}`
              );

              // Last resort:
              // create another Peer with the
              // SAME stable ID.
              tryRecreate();
            }
          }
        },
        delay
      );
  }

  function tryRecreate() {
    if (destroyed) {
      return;
    }

    try {
      peer?.destroy();
    } catch {}

    opened = false;

    tryInit(
      () => {
        signalingAttempt = 0;
        log(
          `DM stable PeerJS ID reclaimed: ${peerId}`
        );
      },
      error => {
        log(
          `DM PeerJS recreation failed: ` +
          `${error.message}`
        );

        scheduleSignalingReconnect();
      },
      0
    );
  }

  function handleIncoming(
    connection
  ) {
    const pid =
      connection.peer;

    log(
      `incoming connection from ` +
      `${short(pid)} (negotiating…)`
    );

    attachRtcDiagnostics(
      connection,
      `rtc ${short(pid)}`
    );

    let openedConnection =
      false;

    connection.on(
      'open',
      () => {
        openedConnection = true;

        const existing =
          connections.get(pid);

        if (
          existing &&
          existing !== connection
        ) {
          try {
            existing.close();
          } catch {}
        }

        connections.set(
          pid,
          {
            conn: connection,
            lastActivity:
              Date.now(),
          }
        );

        log(
          `data channel open: ` +
          `${short(pid)}`
        );

        ensureStaleCheck();

        onPlayerConnect?.(
          pid
        );
      }
    );

    connection.on(
      'data',
      data => {
        const entry =
          connections.get(pid);

        if (
          entry &&
          entry.conn === connection
        ) {
          entry.lastActivity =
            Date.now();
        }

        if (
          data &&
          data.t === 'ping'
        ) {
          try {
            connection.send({
              t: 'pong',
              ts: data.ts,
            });
          } catch {}

          return;
        }

        onMessage?.(
          data,
          pid
        );
      }
    );

    const drop = reason => {
      const entry =
        connections.get(pid);

      if (
        !entry ||
        entry.conn !== connection
      ) {
        return;
      }

      connections.delete(pid);

      log(
        `player ${short(pid)} gone ` +
        `(${reason})`
      );

      onPlayerDisconnect?.(
        pid
      );
    };

    connection.on(
      'close',
      () => {
        drop('closed');

        if (
          !openedConnection
        ) {
          log(
            `rtc ${short(pid)} closed ` +
            `before data channel opened`
          );
        }
      }
    );

    connection.on(
      'error',
      error => {
        log(
          `connection error ` +
          `${short(pid)}: ` +
          `${error?.type || ''} ` +
          `${safeStr(error)}`
        );

        drop('error');
      }
    );

    // Helpful diagnostic when a remote peer
    // never opens the connection.
    setTimeout(
      () => {
        if (
          !openedConnection &&
          !destroyed
        ) {
          logConnectionStats(
            connection,
            `rtc ${short(pid)} timeout`
          );
        }
      },
      CONNECT_TIMEOUT_MS
    );
  }

  function ensureStaleCheck() {
    if (staleTimer) {
      return;
    }

    staleTimer =
      setInterval(
        () => {
          if (destroyed) {
            clearInterval(
              staleTimer
            );

            staleTimer = null;

            return;
          }

          const now =
            Date.now();

          for (
            const [pid, entry]
            of connections
          ) {
            if (
              now -
              entry.lastActivity >
              STALE_MS
            ) {
              log(
                `stale connection ` +
                `${short(pid)} ` +
                `(silent for ` +
                `${Math.round(
                  (
                    now -
                    entry.lastActivity
                  ) / 1000
                )} s)`
              );

              connections.delete(
                pid
              );

              try {
                entry.conn.close();
              } catch {}

              onPlayerDisconnect?.(
                pid
              );
            }
          }

          if (
            !connections.size
          ) {
            clearInterval(
              staleTimer
            );

            staleTimer = null;
          }
        },
        STALE_CHECK_MS
      );
  }

  return {
    init,

    send(
      data,
      target = null
    ) {
      const list =
        target
          ? [
              [
                target,
                connections.get(target),
              ],
            ]
          : [
              ...connections.entries(),
            ];

      for (
        const [pid, entry]
        of list
      ) {
        const conn =
          entry?.conn;

        if (
          !conn ||
          !conn.open
        ) {
          continue;
        }

        try {
          conn.send(data);

          log(
            `→ ${short(pid)} ` +
            `${data?.t || 'message'}`
          );
        } catch (error) {
          log(
            `send failed to ` +
            `${short(pid)}: ` +
            `${error.message}`
          );
        }
      }
    },

    close(pid) {
      const entry =
        connections.get(pid);

      if (!entry) {
        return;
      }

      connections.delete(pid);

      try {
        entry.conn.close();
      } catch {}
    },

    isConnected() {
      return (
        !!peer &&
        !peer.disconnected &&
        !peer.destroyed
      );
    },

    status() {
      log(
        `DM peer ${peerId}: ` +
        `signaling=${
          peer?.disconnected
            ? 'DISCONNECTED'
            : peer?.destroyed
              ? 'destroyed'
              : 'connected'
        } | ` +
        `players=${connections.size}`
      );
    },

    destroy() {
      destroyed = true;

      if (staleTimer) {
        clearInterval(
          staleTimer
        );
      }

      if (
        signalingReconnectTimer
      ) {
        clearTimeout(
          signalingReconnectTimer
        );
      }

      staleTimer = null;
      signalingReconnectTimer = null;

      for (
        const entry
        of connections.values()
      ) {
        try {
          entry.conn.close();
        } catch {}
      }

      connections.clear();

      try {
        peer?.destroy();
      } catch {}

      peer = null;

      log(
        `DM peer destroyed ` +
        `(stable id was ${peerId})`
      );
    },
  };
}

// ---------------------------------------------------------------------------
// PeerJS player transport
// ---------------------------------------------------------------------------

function createPlayerPeer(
  roomId,
  {
    log,
    turn = null,
    relayOnly = false,
    onConnect,
    onDisconnect,
    onReconnecting,
    onMessage,
  }
) {
  const hostId =
    PEER_PREFIX + roomId;

  const opts =
    getIceConfig({
      turn,
      relayOnly,
      log,
    });

  let peer = null;
  let conn = null;

  let destroyed = false;

  let connectAttempt = 0;
  let reconnectAttempt = 0;

  let connectTimer = null;
  let reconnectTimer = null;
  let heartbeat = null;

  let explicitDisconnect = false;

  function start() {
    destroyed = false;
    explicitDisconnect = false;

    createPeer();
  }

  function createPeer() {
    if (destroyed) {
      return;
    }

    if (
      peer &&
      !peer.destroyed
    ) {
      return;
    }

    log(
      'creating temporary player PeerJS peer…'
    );

    // Player gets an automatically generated
    // PeerJS ID.
    peer =
      new window.Peer(
        undefined,
        {
          debug: 0,
          ...opts,
        }
      );

    peer.on(
      'open',
      id => {
        log(
          `Player PeerJS signaling connected ` +
          `as ${id}`
        );

        reconnectAttempt = 0;

        if (
          !conn ||
          !conn.open
        ) {
          connectToDm();
        }
      }
    );

    peer.on(
      'disconnected',
      () => {
        if (
          destroyed ||
          explicitDisconnect
        ) {
          return;
        }

        log(
          'Player PeerJS signaling disconnected'
        );

        setTimeout(
          () => {
            if (
              !destroyed &&
              peer &&
              !peer.destroyed &&
              peer.disconnected
            ) {
              try {
                peer.reconnect();
              } catch (error) {
                log(
                  `player signaling reconnect ` +
                  `failed: ${error.message}`
                );
              }
            }
          },
          1000
        );
      }
    );

    peer.on(
      'error',
      error => {
        if (
          destroyed ||
          explicitDisconnect
        ) {
          return;
        }

        log(
          `Player PeerJS error ` +
          `(${error?.type || 'unknown'}): ` +
          `${safeStr(error)}`
        );

        if (
          error?.type ===
          'peer-unavailable'
        ) {
          scheduleReconnect(
            'DM unavailable'
          );
        }
      }
    );

    peer.on(
      'connection',
      incoming => {
        log(
          `refusing unexpected incoming ` +
          `connection from ` +
          `${short(incoming.peer)}`
        );

        try {
          incoming.close();
        } catch {}
      }
    );

    // PeerJS may emit close after a fatal
    // signaling issue.
    peer.on(
      'close',
      () => {
        if (
          destroyed ||
          explicitDisconnect
        ) {
          return;
        }

        log(
          'Player PeerJS object closed'
        );

        peer = null;

        scheduleReconnect(
          'player peer closed'
        );
      }
    );
  }

  function connectToDm() {
    if (
      destroyed ||
      !peer ||
      peer.destroyed
    ) {
      return;
    }

    if (
      conn &&
      conn.open
    ) {
      return;
    }

    if (
      peer.disconnected
    ) {
      log(
        'Player signaling is disconnected; ' +
        'waiting for signaling reconnect'
      );

      return;
    }

    connectAttempt++;

    const attempt =
      connectAttempt;

    log(
      `connecting to DM ${hostId} ` +
      `(attempt ${attempt}, ` +
      `${CONNECT_TIMEOUT_MS / 1000}s timeout)…`
    );

    let connection;

    try {
      connection =
        peer.connect(
          hostId,
          {
            reliable: true,
            serialization: 'json',
          }
        );
    } catch (error) {
      log(
        `peer.connect failed: ` +
        `${error.message}`
      );

      scheduleReconnect(
        'peer.connect failed'
      );

      return;
    }

    conn = connection;

    attachRtcDiagnostics(
      connection,
      `player rtc`
    );

    let opened = false;
    let finished = false;

    if (connectTimer) {
      clearTimeout(
        connectTimer
      );
    }

    connectTimer =
      setTimeout(
        async () => {
          if (
            finished ||
            destroyed ||
            conn !== connection
          ) {
            return;
          }

          finished = true;

          log(
            `player connection attempt ` +
            `${attempt} timed out`
          );

          await logConnectionStats(
            connection,
            `player timeout`
          );

          try {
            connection.close();
          } catch {}

          scheduleReconnect(
            'WebRTC timeout'
          );
        },
        CONNECT_TIMEOUT_MS
      );

    connection.on(
      'open',
      () => {
        if (
          destroyed ||
          conn !== connection
        ) {
          return;
        }

        opened = true;
        finished = true;

        if (connectTimer) {
          clearTimeout(
            connectTimer
          );

          connectTimer = null;
        }

        reconnectAttempt = 0;

        log(
          `data channel to DM OPEN ` +
          `(attempt ${attempt})`
        );

        startHeartbeat();

        onConnect?.();
      }
    );

    connection.on(
      'data',
      data => {
        if (
          data &&
          data.t === 'pong'
        ) {
          return;
        }

        onMessage?.(
          data
        );
      }
    );

    connection.on(
      'close',
      async () => {
        if (conn !== connection) {
          return;
        }

        if (connectTimer) {
          clearTimeout(
            connectTimer
          );

          connectTimer = null;
        }

        stopHeartbeat();

        if (
          !opened &&
          !destroyed
        ) {
          await logConnectionStats(
            connection,
            `player closed before open`
          );
        }

        conn = null;

        if (
          !destroyed &&
          !explicitDisconnect
        ) {
          onDisconnect?.();
          scheduleReconnect(
            'data channel closed'
          );
        }
      }
    );

    connection.on(
      'error',
      error => {
        log(
          `player data connection error: ` +
          `${error?.type || ''} ` +
          `${safeStr(error)}`
        );
      }
    );
  }

  function scheduleReconnect(
    reason = 'unknown'
  ) {
    if (
      destroyed ||
      explicitDisconnect ||
      reconnectTimer
    ) {
      return;
    }

    reconnectAttempt++;

    const delay =
      Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS *
        Math.pow(
          2,
          reconnectAttempt - 1
        )
      );

    log(
      `player retry ${reconnectAttempt} ` +
      `in ${delay} ms: ${reason}`
    );

    onReconnecting?.(
      reconnectAttempt,
      delay
    );

    reconnectTimer =
      setTimeout(
        () => {
          reconnectTimer = null;

          if (
            destroyed ||
            explicitDisconnect
          ) {
            return;
          }

          if (
            !peer ||
            peer.destroyed
          ) {
            createPeer();
            return;
          }

          if (
            peer.disconnected
          ) {
            try {
              peer.reconnect();
            } catch (error) {
              log(
                `peer.reconnect failed: ` +
                `${error.message}`
              );

              peer = null;
              createPeer();
            }

            return;
          }

          connectToDm();
        },
        delay
      );
  }

  function startHeartbeat() {
    stopHeartbeat();

    heartbeat =
      setInterval(
        () => {
          if (
            conn?.open
          ) {
            try {
              conn.send({
                t: 'ping',
                ts: Date.now(),
              });
            } catch {}
          }
        },
        HEARTBEAT_MS
      );
  }

  function stopHeartbeat() {
    if (heartbeat) {
      clearInterval(
        heartbeat
      );

      heartbeat = null;
    }
  }

  return {
    start,

    isConnected() {
      return !!(
        conn &&
        conn.open
      );
    },

    send(data) {
      if (
        conn?.open
      ) {
        try {
          conn.send(data);

          log(
            `→ DM ${data?.t || 'message'}`
          );
        } catch (error) {
          log(
            `send to DM failed: ` +
            `${error.message}`
          );
        }
      } else {
        log(
          `not sent; player has no ` +
          `open DM connection`
        );
      }
    },

    reconnectNow(reason = 'manual') {
      if (
        destroyed ||
        explicitDisconnect ||
        (
          conn &&
          conn.open
        )
      ) {
        return;
      }

      if (reconnectTimer) {
        clearTimeout(
          reconnectTimer
        );

        reconnectTimer = null;
      }

      reconnectAttempt = 0;

      log(
        `reconnecting now: ${reason}`
      );

      if (
        !peer ||
        peer.destroyed
      ) {
        createPeer();
      } else {
        connectToDm();
      }
    },

    status() {
      log(
        `player peer: ` +
        `signaling=${
          peer?.disconnected
            ? 'DISCONNECTED'
            : peer?.destroyed
              ? 'destroyed'
              : peer
                ? 'connected'
                : 'none'
        } | ` +
        `DM channel=${
          conn?.open
            ? 'open'
            : 'closed'
        } | ` +
        `attempts=${connectAttempt}`
      );

      if (conn) {
        logConnectionStats(
          conn,
          'player status'
        );
      }
    },

    destroy() {
      destroyed = true;
      explicitDisconnect = true;

      if (connectTimer) {
        clearTimeout(
          connectTimer
        );
      }

      if (reconnectTimer) {
        clearTimeout(
          reconnectTimer
        );
      }

      stopHeartbeat();

      try {
        conn?.close();
      } catch {}

      try {
        peer?.destroy();
      } catch {}

      conn = null;
      peer = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function loadAllCampaigns() {
  try {
    return (
      JSON.parse(
        localStorage.getItem(
          LS_CAMPAIGNS
        )
      ) || {}
    );
  } catch {
    return {};
  }
}

function saveCampaign(campaign) {
  try {
    const all =
      loadAllCampaigns();

    all[campaign.id] =
      campaign;

    localStorage.setItem(
      LS_CAMPAIGNS,
      JSON.stringify(all)
    );
  } catch (error) {
    alert(
      `Could not save campaign: ${error.message}`
    );
  }
}

function deleteCampaign(id) {
  const all =
    loadAllCampaigns();

  delete all[id];

  localStorage.setItem(
    LS_CAMPAIGNS,
    JSON.stringify(all)
  );
}

// ---------------------------------------------------------------------------
// Log UI
// ---------------------------------------------------------------------------

function makeLog(
  role,
  onStatus
) {
  const pre =
    h(
      'pre',
      {
        class: 'log',
      }
    );

  const log =
    text => {
      pre.textContent +=
        `${new Date().toISOString().slice(11, 23)}  ${text}\n`;

      pre.scrollTop =
        pre.scrollHeight;

      console.log(
        `[vttrpg ${role}]`,
        text
      );
    };

  activeLog = log;

  const toolbar =
    h(
      'div',
      {
        class: 'row',
      },

      onStatus
        ? h(
            'button',
            {
              onclick:
                () =>
                  onStatus(),
            },
            'Log status now'
          )
        : null,

      h(
        'button',
        {
          onclick:
            async () => {
              try {
                await navigator.clipboard.writeText(
                  `VTTRPG v${APP_VERSION} (${role})\n` +
                  pre.textContent
                );

                log(
                  'log copied to clipboard'
                );
              } catch (error) {
                log(
                  `copy failed: ${error.message}`
                );
              }
            },
        },
        'Copy log'
      ),

      h(
        'button',
        {
          onclick:
            () => {
              pre.textContent = '';
            },
        },
        'Clear'
      )
    );

  log(
    `VTTRPG v${APP_VERSION} ${role} view started; ` +
    `page ${location.pathname}`
  );

  log(
    `env: online=${navigator.onLine} ` +
    `secureContext=${isSecureContext} ` +
    `RTCPeerConnection=${typeof RTCPeerConnection !== 'undefined'} ` +
    `PeerJS=${window.Peer ? 'loaded' : 'MISSING'}`
  );

  log(
    `browser: ${navigator.userAgent}`
  );

  return {
    el:
      h(
        'div',
        {},
        toolbar,
        pre
      ),
    log,
  };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function makeChat(
  onSend
) {
  const box =
    h(
      'div',
      {
        class: 'chat',
      }
    );

  const input =
    h(
      'input',
      {
        placeholder: 'Message…',
        maxlength: '500',
      }
    );

  const button =
    h(
      'button',
      {},
      'Send'
    );

  const submit =
    () => {
      const text =
        input.value.trim();

      if (!text) {
        return;
      }

      onSend(text);

      input.value = '';
      input.focus();
    };

  input.addEventListener(
    'keydown',
    event => {
      if (
        event.key === 'Enter'
      ) {
        submit();
      }
    }
  );

  button.addEventListener(
    'click',
    submit
  );

  return {
    el:
      h(
        'div',
        {},
        box,
        h(
          'div',
          {
            class: 'row',
          },
          input,
          button
        )
      ),

    add(message) {
      const time =
        new Date(
          message.ts
        ).toLocaleTimeString();

      const row =
        h(
          'div',
          {
            class:
              message.sys
                ? 'msg sys'
                : 'msg',
          },

          h(
            'span',
            {
              class: 'ts',
            },
            `${time} `
          ),

          message.sys
            ? message.text
            : [
                h(
                  'b',
                  {},
                  `${message.from}: `
                ),
                message.text,
              ]
        );

      box.append(row);

      box.scrollTop =
        box.scrollHeight;
    },

    clear() {
      box.replaceChildren();
    },

    setEnabled(enabled) {
      input.disabled =
        !enabled;

      button.disabled =
        !enabled;
    },
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const $app =
  document.getElementById(
    'app'
  );

let cleanup = null;

function route() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }

  activeLog = null;

  $app.replaceChildren();

  const [
    hash,
    query = '',
  ] =
    (
      location.hash.replace(
        /^#/,
        ''
      ) || '/'
    ).split('?');

  let match;

  if (
    (
      match =
        hash.match(
          /^\/join\/([a-z0-9]+)$/i
        )
    )
  ) {
    return viewPlayer(
      match[1],
      parseOpts(query)
    );
  }

  if (
    (
      match =
        hash.match(
          /^\/dm\/([a-z0-9]+)$/i
        )
    )
  ) {
    return viewDM(
      match[1]
    );
  }

  viewHome();
}

window.addEventListener(
  'hashchange',
  route
);

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function viewHome() {
  const nameInput =
    h(
      'input',
      {
        placeholder:
          'New campaign name',
      }
    );

  const campaignList =
    h('div');

  const fileInput =
    h(
      'input',
      {
        type: 'file',
        accept: 'application/json',
      }
    );

  const create =
    () => {
      const name =
        nameInput.value.trim();

      if (!name) {
        return;
      }

      const campaign = {
        id:
          rid(10),

        name,

        created:
          Date.now(),

        roomId:
          null,

        players:
          {},

        nextNum:
          1,

        chat:
          [],
      };

      saveCampaign(
        campaign
      );

      location.hash =
        '#/dm/' +
        campaign.id;
    };

  fileInput.addEventListener(
    'change',
    async event => {
      const file =
        event.target.files?.[0];

      if (!file) {
        return;
      }

      try {
        const imported =
          JSON.parse(
            await file.text()
          );

        if (
          !imported.id ||
          !imported.name ||
          typeof imported.players !== 'object' ||
          !Array.isArray(
            imported.chat
          )
        ) {
          throw new Error(
            'not a valid campaign file'
          );
        }

        if (
          loadAllCampaigns()[
            imported.id
          ] &&
          !confirm(
            'A campaign with this ID exists. Overwrite?'
          )
        ) {
          return;
        }

        saveCampaign(
          imported
        );

        renderList();
      } catch (error) {
        alert(
          `Import failed: ${error.message}`
        );
      }

      event.target.value = '';
    }
  );

  function renderList() {
    const all =
      Object.values(
        loadAllCampaigns()
      );

    if (!all.length) {
      campaignList.replaceChildren(
        h(
          'div',
          {
            class: 'muted',
          },
          'No campaigns in this browser yet.'
        )
      );

      return;
    }

    campaignList.replaceChildren(
      ...all.map(
        campaign =>
          h(
            'div',
            {
              class: 'row',
            },

            h(
              'b',
              {},
              campaign.name
            ),

            h(
              'span',
              {
                class:
                  'muted',
              },
              `${Object.keys(
                campaign.players || {}
              ).length} players, ` +
              `${(
                campaign.chat || []
              ).length} messages`
            ),

            h(
              'button',
              {
                onclick:
                  () =>
                    (
                      location.hash =
                        '#/dm/' +
                        campaign.id
                    ),
              },
              'Open as DM'
            ),

            h(
              'button',
              {
                onclick:
                  () => {
                    if (
                      confirm(
                        `Delete "${campaign.name}" from this browser?`
                      )
                    ) {
                      deleteCampaign(
                        campaign.id
                      );

                      renderList();
                    }
                  },
              },
              'Delete'
            )
          )
      )
    );
  }

  renderList();

  $app.append(
    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Create campaign'
      ),

      h(
        'div',
        {
          class: 'row',
        },

        nameInput,

        h(
          'button',
          {
            onclick:
              create,
          },
          'Create'
        )
      )
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Campaigns in this browser'
      ),

      campaignList,

      h(
        'div',
        {
          class: 'muted',
        },
        'Import campaign file:'
      ),

      fileInput
    ),

    h(
      'section',
      {
        class: 'muted',
      },

      'Players simply need the join link. ' +
      'There is no PIN in v0.7.1.'
    )
  );
}

// ---------------------------------------------------------------------------
// DM
// ---------------------------------------------------------------------------

function viewDM(cid) {
  const all =
    loadAllCampaigns();

  const campaign =
    all[cid];

  if (!campaign) {
    location.hash = '#/';
    return;
  }

  if (
    !campaign.players ||
    typeof campaign.players !==
      'object'
  ) {
    campaign.players = {};
  }

  if (
    !Array.isArray(
      campaign.chat
    )
  ) {
    campaign.chat = [];
  }

  if (!campaign.nextNum) {
    campaign.nextNum = 1;
  }

  const save =
    () =>
      saveCampaign(
        campaign
      );

  const turnSaved =
    getTurnFromLocalStorage();

  const {
    el: logEl,
    log,
  } =
    makeLog(
      'DM',
      () =>
        dmPeer
          ? dmPeer.status()
          : log(
              'no active session'
            )
    );

  log(
    `campaign "${campaign.name}" ` +
    `(${cid}) loaded from localStorage: ` +
    `${Object.keys(
      campaign.players
    ).length} known players, ` +
    `${campaign.chat.length} chat messages`
  );

  const chat =
    makeChat(
      text =>
        postChat({
          from: 'DM',
          text,
        })
    );

  campaign.chat
    .slice(-100)
    .forEach(
      chat.add
    );

  let dmPeer = null;
  let session = null;
  let opening = false;

  const peers =
    new Map();

  const badRequests =
    new Map();

  const modeSelect =
    h(
      'select',
      {
        onchange:
          () => {
            if (session) {
              session.mode =
                modeSelect.value;
            }

            log(
              `join mode -> ${modeSelect.value}`
            );
          },
      },

      h(
        'option',
        {
          value: 'approval',
        },
        'Approval required'
      ),

      h(
        'option',
        {
          value: 'open',
        },
        'Open (auto-approve)'
      ),

      h(
        'option',
        {
          value: 'locked',
        },
        'Locked (known players only)'
      )
    );

  const toggleButton =
    h(
      'button',
      {
        onclick:
          () =>
            session
              ? closeSession()
              : openSession(),
      },
      'Open session'
    );

  const signalingStatus =
    h(
      'span',
      {
        class: 'tag',
      },
      'no session'
    );

  const joinLinkInput =
    h(
      'input',
      {
        readonly: '',
        placeholder:
          'Open the session to generate the join link',
      }
    );

  const copyButton =
    h(
      'button',
      {
        onclick:
          async () => {
            try {
              await navigator.clipboard.writeText(
                joinLinkInput.value
              );

              log(
                'join link copied'
              );
            } catch {
              log(
                'clipboard write failed'
              );
            }
          },
      },
      'Copy link'
    );

  const qrEl =
    h(
      'div',
      {
        class: 'qr',
      }
    );

  const lobbyEl =
    h('div');

  const playersEl =
    h('div');

  const turnUrls =
    h(
      'input',
      {
        placeholder:
          'turn:host:3478, turns:host:443?transport=tcp',

        value:
          turnSaved.urls || '',
      }
    );

  const turnUser =
    h(
      'input',
      {
        placeholder:
          'TURN username',

        value:
          turnSaved.username || '',
      }
    );

  const turnCred =
    h(
      'input',
      {
        type: 'password',

        placeholder:
          'TURN credential',

        value:
          turnSaved.credential || '',
      }
    );

  const relayCheck =
    h(
      'input',
      {
        type: 'checkbox',

        checked:
          false,
      }
    );

  const turnTestStatus =
    h(
      'span',
      {
        class:
          'muted',
      }
    );

  chat.setEnabled(
    false
  );

  const readTurn =
    () => {
      const urls =
        turnUrls.value
          .split(',')
          .map(
            x =>
              x.trim()
          )
          .filter(Boolean);

      const turn =
        urls.length
          ? {
              urls,
              username:
                turnUser.value.trim(),
              credential:
                turnCred.value.trim(),
            }
          : null;

      saveTurnToLocalStorage({
        urls:
          turnUrls.value,

        username:
          turnUser.value.trim(),

        credential:
          turnCred.value.trim(),
      });

      return turn;
    };

  const approvedPeerIds =
    () =>
      [
        ...peers,
      ]
        .filter(
          ([, player]) =>
            player.status ===
            'approved'
        )
        .map(
          ([pid]) =>
            pid
        );

  const findPeerForToken =
    token =>
      [
        ...peers,
      ].find(
        ([, player]) =>
          player.token ===
          token
      )?.[0] ||
      null;

  const roster =
    () =>
      Object.values(
        campaign.players
      )
        .filter(
          player =>
            !player.banned
        )
        .map(
          player => ({
            num:
              player.num,

            name:
              player.name,

            online:
              [
                ...peers.values(),
              ].some(
                live =>
                  live.token ===
                    player.token &&
                  live.status ===
                    'approved'
              ),
          })
        );

  const broadcastRoster =
    () => {
      for (
        const pid of
        approvedPeerIds()
      ) {
        dmPeer?.send(
          {
            t:
              'roster',

            roster:
              roster(),
          },
          pid
        );
      }
    };

  function sendTo(
    data,
    pid
  ) {
    dmPeer?.send(
      data,
      pid
    );
  }

  async function testTurn() {
    const turn =
      readTurn();

    if (!turn) {
      turnTestStatus.textContent =
        'Enter TURN URL, username and credential first.';

      return;
    }

    turnTestStatus.textContent =
      'testing…';

    log(
      `TURN test: asking ${turn.urls.join(', ')} for a relay address…`
    );

    const pc =
      new RTCPeerConnection({
        iceServers: [
          {
            urls:
              turn.urls,

            username:
              turn.username,

            credential:
              turn.credential,
          },
        ],

        iceTransportPolicy:
          'relay',

        iceCandidatePoolSize:
          2,
      });

    pc.createDataChannel(
      'turn-test'
    );

    let finished =
      false;

    const finish =
      (
        ok,
        message
      ) => {
        if (finished) {
          return;
        }

        finished = true;

        try {
          pc.close();
        } catch {}

        turnTestStatus.textContent =
          `${ok ? 'OK' : 'FAILED'}: ${message}`;

        log(
          `TURN test ${ok ? 'OK' : 'FAILED'}: ${message}`
        );
      };

    const timeout =
      setTimeout(
        () =>
          finish(
            false,
            'no relay candidate received'
          ),
        10000
      );

    pc.addEventListener(
      'icecandidate',
      event => {
        if (!event.candidate) {
          return;
        }

        const candidate =
          event.candidate
            .candidate || '';

        if (
          candidateTypeFromLine(
            candidate
          ) === 'relay'
        ) {
          clearTimeout(
            timeout
          );

          finish(
            true,
            'TURN relay candidate received'
          );
        }
      }
    );

    pc.addEventListener(
      'icecandidateerror',
      event => {
        log(
          `TURN test ICE error: ` +
          `${event.errorCode || ''} ` +
          `${event.url || ''} ` +
          `${event.errorText || ''}`
        );
      }
    );

    try {
      const offer =
        await pc.createOffer();

      await pc.setLocalDescription(
        offer
      );
    } catch (error) {
      clearTimeout(
        timeout
      );

      finish(
        false,
        error.message
      );
    }
  }

  async function openSession() {
    if (
      opening ||
      session
    ) {
      return;
    }

    opening = true;

    toggleButton.disabled =
      true;

    signalingStatus.textContent =
      'connecting…';

    if (!campaign.roomId) {
      campaign.roomId =
        rid(14);

      save();

      log(
        `created stable room id ${campaign.roomId}`
      );
    }

    const room =
      campaign.roomId;

    const turn =
      readTurn();

    const relayOnly =
      relayCheck.checked;

    log(
      `opening session: ` +
      `mode=${modeSelect.value}, ` +
      `room=${room}`
    );

    const peerTransport =
      createDMPeer(
        room,
        {
          log,

          turn,

          relayOnly,

          onPlayerConnect:
            pid => {
              log(
                `player connected ${short(pid)} ` +
                `– waiting for join request`
              );
            },

          onPlayerDisconnect:
            pid => {
              badRequests.delete(
                pid
              );

              const player =
                peers.get(
                  pid
                );

              if (player) {
                log(
                  `${player.name} ` +
                  `(${player.status}) left`
                );

                if (
                  player.status ===
                  'approved'
                ) {
                  systemMsg(
                    `${player.name} ` +
                    `(Player ${player.num}) disconnected`
                  );
                }

                peers.delete(
                  pid
                );

                renderPeople();
                broadcastRoster();
              }
            },

          onMessage:
            (message, pid) =>
              onMsg(
                message,
                pid
              ),

          onSignaling:
            state => {
              signalingStatus.textContent =
                state ===
                  'connected'
                  ? 'signaling OK'
                  : 'signaling reconnecting…';
            },
        }
      );

    try {
      await peerTransport.init();
    } catch (error) {
      log(
        `COULD NOT OPEN SESSION: ` +
        `${error.message}`
      );

      peerTransport.destroy();

      opening = false;

      toggleButton.disabled =
        false;

      signalingStatus.textContent =
        'failed';

      return;
    }

    dmPeer =
      peerTransport;

    session = {
      mode:
        modeSelect.value,

      room:
        campaign.roomId,
    };

    opening = false;

    toggleButton.disabled =
      false;

    toggleButton.textContent =
      'Close session';

    modeSelect.disabled =
      true;

    chat.setEnabled(
      true
    );

    const query =
      [
        turn
          ? `t=${encodeURIComponent(
              b64e(turn)
            )}`
          : '',

        relayOnly
          ? 'r=1'
          : '',
      ]
        .filter(Boolean)
        .join('&');

    const link =
      `${location.origin}${location.pathname}` +
      `#/join/${campaign.roomId}` +
      `${query ? '?' + query : ''}`;

    joinLinkInput.value =
      link;

    qrEl.replaceChildren();

    if (
      window.QRCode
    ) {
      new window.QRCode(
        qrEl,
        {
          text:
            link,

          width:
            220,

          height:
            220,

          correctLevel:
            window.QRCode.CorrectLevel
              ?.M ||
            0,
        }
      );

      log(
        'QR code generated'
      );
    } else {
      qrEl.append(
        h(
          'div',
          {
            class: 'muted',
          },
          'QR library not loaded.'
        )
      );
    }

    signalingStatus.textContent =
      'signaling OK';

    log(
      `SESSION OPEN – stable DM peer ID is ` +
      `"${PEER_PREFIX}${campaign.roomId}".`
    );

    if (turn) {
      log(
        'WARNING: TURN credentials are embedded ' +
        'in the join link.'
      );
    }

    if (relayOnly) {
      log(
        'RELAY-ONLY test mode enabled.'
      );
    }

    renderPeople();
  }

  function closeSession() {
    if (!session) {
      return;
    }

    log(
      `closing session; notifying ` +
      `${peers.size} player connection(s)`
    );

    for (
      const pid of
      approvedPeerIds()
    ) {
      sendTo(
        {
          t:
            'closed',
        },
        pid
      );
    }

    const transport =
      dmPeer;

    peers.clear();
    badRequests.clear();

    dmPeer = null;
    session = null;

    modeSelect.disabled =
      false;

    toggleButton.textContent =
      'Open session';

    signalingStatus.textContent =
      'no session';

    joinLinkInput.value =
      '';

    qrEl.replaceChildren();

    chat.setEnabled(
      false
    );

    setTimeout(
      () => {
        transport?.destroy();
      },
      300
    );

    log(
      'session closed'
    );

    renderPeople();
  }

  function onMsg(
    message,
    pid
  ) {
    if (
      !message ||
      typeof message !==
        'object'
    ) {
      return;
    }

    if (!session) {
      log(
        `ignored ${message.t} from ` +
        `${short(pid)}: no open session`
      );

      return;
    }

    if (
      message.t ===
      'join'
    ) {
      handleJoin(
        message,
        pid
      );

      return;
    }

    const player =
      peers.get(
        pid
      );

    if (
      !player ||
      player.status !==
        'approved'
    ) {
      log(
        `ignored ${message.t} from ` +
        `${short(pid)}: not approved`
      );

      return;
    }

    if (
      message.t ===
      'chat'
    ) {
      const text =
        String(
          message.text || ''
        )
          .trim()
          .slice(
            0,
            500
          );

      if (!text) {
        return;
      }

      postChat({
        from:
          `${player.name} (P${player.num})`,

        text,
      });

      return;
    }

    if (
      message.t ===
      'ping'
    ) {
      return;
    }

    log(
      `unknown player message ` +
      `"${message.t}"`
    );
  }

  function handleJoin(
    message,
    pid
  ) {
    const token =
      String(
        message.token || ''
      )
        .slice(
          0,
          64
        );

    const name =
      String(
        message.name || ''
      )
        .trim()
        .slice(
          0,
          30
        ) ||
      'Player';

    if (!token) {
      log(
        `join request from ${short(pid)} ` +
        `without identity token`
      );

      return;
    }

    const known =
      campaign.players[
        token
      ];

    log(
      `JOIN REQUEST from ${short(pid)} ` +
      `"${name}" ` +
      `token ${token.slice(0, 6)}… ` +
      (
        known
          ? `(known: Player ${known.num}` +
            `${
              known.banned
                ? ', BANNED'
                : ''
            })`
          : '(new player)'
      ) +
      ` – mode ${session.mode}`
    );

    if (
      known?.banned
    ) {
      log(
        `-> denied: player is banned`
      );

      sendTo(
        {
          t:
            'denied',

          reason:
            'You are banned.',
        },
        pid
      );

      return;
    }

    // Disconnect another live connection
    // belonging to the same identity token.
    for (
      const [
        otherPid,
        other
      ] of peers
    ) {
      if (
        other.token ===
          token &&
        otherPid !== pid
      ) {
        log(
          `dropping older connection ` +
          `${short(otherPid)} ` +
          `for the same player token`
        );

        peers.delete(
          otherPid
        );

        dmPeer?.close(
          otherPid
        );
      }
    }

    if (known) {
      known.name =
        name;

      save();

      peers.set(
        pid,
        {
          token,
          name,
          status:
            'approved',
          num:
            known.num,
        }
      );

      sendAccepted(
        pid
      );

      systemMsg(
        `${name} ` +
        `(Player ${known.num}) reconnected`
      );

      renderPeople();
      broadcastRoster();

      return;
    }

    if (
      session.mode ===
      'locked'
    ) {
      log(
        '-> denied: session is locked'
      );

      sendTo(
        {
          t:
            'denied',

          reason:
            'Session is locked.',
        },
        pid
      );

      return;
    }

    peers.set(
      pid,
      {
        token,
        name,
        status:
          'pending',
        num:
          null,
      }
    );

    if (
      session.mode ===
      'open'
    ) {
      approve(
        pid
      );

      return;
    }

    log(
      '-> waiting for DM approval'
    );

    sendTo(
      {
        t:
          'pending',
      },
      pid
    );

    renderPeople();
  }

  function approve(
    pid
  ) {
    const player =
      peers.get(
        pid
      );

    if (!player) {
      return;
    }

    if (
      player.status ===
      'approved'
    ) {
      return;
    }

    const num =
      campaign.nextNum++;

    campaign.players[
      player.token
    ] = {
      token:
        player.token,

      num,

      name:
        player.name,

      banned:
        false,
    };

    player.status =
      'approved';

    player.num =
      num;

    save();

    log(
      `APPROVED ${player.name} ` +
      `as Player ${num}`
    );

    sendAccepted(
      pid
    );

    systemMsg(
      `${player.name} joined as Player ${num}`
    );

    renderPeople();
    broadcastRoster();
  }

  function sendAccepted(
    pid
  ) {
    const player =
      peers.get(
        pid
      );

    if (!player) {
      return;
    }

    const history =
      campaign.chat
        .slice(-100);

    log(
      `sending accepted + ` +
      `${history.length} history message(s) ` +
      `to Player ${player.num}`
    );

    sendTo(
      {
        t:
          'accepted',

        num:
          player.num,

        name:
          player.name,

        campaignName:
          campaign.name,

        history,

        roster:
          roster(),
      },
      pid
    );
  }

  function deny(
    pid
  ) {
    const player =
      peers.get(
        pid
      );

    if (!player) {
      return;
    }

    sendTo(
      {
        t:
          'denied',

        reason:
          'The DM declined your request.',
      },
      pid
    );

    peers.delete(
      pid
    );

    setTimeout(
      () => {
        dmPeer?.close(
          pid
        );
      },
      200
    );

    renderPeople();
  }

  function kick(
    token,
    ban
  ) {
    const pid =
      findPeerForToken(
        token
      );

    if (pid) {
      sendTo(
        {
          t:
            ban
              ? 'banned'
              : 'kicked',
        },
        pid
      );

      peers.delete(
        pid
      );

      setTimeout(
        () => {
          dmPeer?.close(
            pid
          );
        },
        200
      );
    }

    if (
      ban &&
      campaign.players[
        token
      ]
    ) {
      campaign.players[
        token
      ].banned =
        true;

      save();
    }

    log(
      `${ban ? 'BANNED' : 'KICKED'} ` +
      `token ${token.slice(0, 6)}…`
    );

    renderPeople();
    broadcastRoster();
  }

  function unban(
    token
  ) {
    if (
      !campaign.players[
        token
      ]
    ) {
      return;
    }

    campaign.players[
      token
    ].banned =
      false;

    save();

    log(
      `unbanned token ${token.slice(0, 6)}…`
    );

    renderPeople();
  }

  function systemMsg(
    text
  ) {
    postChat({
      sys:
        true,

      text,
    });
  }

  function postChat(
    partial
  ) {
    const message = {
      id:
        rid(8),

      ts:
        Date.now(),

      ...partial,
    };

    campaign.chat.push(
      message
    );

    if (
      campaign.chat.length >
      MAX_CHAT
    ) {
      campaign.chat.splice(
        0,
        campaign.chat.length -
          MAX_CHAT
      );
    }

    save();

    chat.add(
      message
    );

    for (
      const pid of
      approvedPeerIds()
    ) {
      sendTo(
        {
          t:
            'chat',

          msg:
            message,
        },
        pid
      );
    }
  }

  function renderPeople() {
    const pending =
      [
        ...peers.entries(),
      ]
        .filter(
          ([, player]) =>
            player.status ===
            'pending'
        );

    lobbyEl.replaceChildren(
      ...(pending.length
        ? pending.map(
            ([
              pid,
              player,
            ]) =>
              h(
                'div',
                {
                  class:
                    'row',
                },

                h(
                  'b',
                  {},
                  player.name
                ),

                h(
                  'span',
                  {
                    class:
                      'muted',
                  },
                  'wants to join'
                ),

                h(
                  'button',
                  {
                    onclick:
                      () =>
                        approve(
                          pid
                        ),
                  },
                  'Approve'
                ),

                h(
                  'button',
                  {
                    onclick:
                      () =>
                        deny(
                          pid
                        ),
                  },
                  'Deny'
                )
              )
          )
        : [
            h(
              'div',
              {
                class:
                  'muted',
              },
              'Nobody waiting.'
            ),
          ])
    );

    const known =
      Object.entries(
        campaign.players
      );

    playersEl.replaceChildren(
      ...(known.length
        ? known.map(
            ([
              token,
              player,
            ]) =>
              h(
                'div',
                {
                  class:
                    'player-row',
                },

                h(
                  'div',
                  {
                    class:
                      'player-main',
                  },

                  h(
                    'b',
                    {},
                    `Player ${player.num}: ${player.name}`
                  ),

                  h(
                    'span',
                    {
                      class:
                        'tag',
                    },
                    player.banned
                      ? 'banned'
                      : (
                        [
                          ...peers.values(),
                        ].some(
                          live =>
                            live.token ===
                              token &&
                            live.status ===
                              'approved'
                        )
                          ? 'online'
                          : 'offline'
                      )
                  )
                ),

                h(
                  'div',
                  {
                    class:
                      'player-actions',
                  },

                  player.banned
                    ? h(
                        'button',
                        {
                          onclick:
                            () =>
                              unban(
                                token
                              ),
                        },
                        'Unban'
                      )
                    : [
                        h(
                          'button',
                          {
                            onclick:
                              () =>
                                kick(
                                  token,
                                  false
                                ),
                          },
                          'Kick'
                        ),

                        h(
                          'button',
                          {
                            onclick:
                              () =>
                                kick(
                                  token,
                                  true
                                ),
                          },
                          'Ban'
                        ),
                      ]
                )
              )
          )
        : [
            h(
              'div',
              {
                class:
                  'muted',
              },
              'No players yet.'
            ),
          ])
    );
  }

  function exportCampaign() {
    const blob =
      new Blob(
        [
          JSON.stringify(
            campaign,
            null,
            2
          ),
        ],
        {
          type:
            'application/json',
        }
      );

    const url =
      URL.createObjectURL(
        blob
      );

    const link =
      h(
        'a',
        {
          href:
            url,

          download:
            `${campaign.name.replace(
              /[^\w-]+/g,
              '_'
            )}.vttrpg.json`,
        }
      );

    document.body.append(
      link
    );

    link.click();
    link.remove();

    URL.revokeObjectURL(
      url
    );

    log(
      'campaign exported'
    );
  }

  renderPeople();

  $app.append(
    h(
      'div',
      {
        class:
          'row',
      },

      h(
        'a',
        {
          href:
            '#/',
        },
        '← Campaigns'
      ),

      h(
        'b',
        {},
        `DM view: ${campaign.name}`
      ),

      h(
        'button',
        {
          onclick:
            exportCampaign,
        },
        'Export'
      )
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Session'
      ),

      h(
        'div',
        {
          class:
            'row',
        },

        'Join mode:',

        modeSelect,

        toggleButton,

        signalingStatus
      ),

      h(
        'div',
        {
          class:
            'notice muted',
        },
        'No PIN is required in v0.7.1. ' +
        'Approval mode controls whether new players ' +
        'need DM approval.'
      ),

      h(
        'div',
        {
          class:
            'row',
        },

        joinLinkInput,

        copyButton
      ),

      qrEl,

      h(
        'div',
        {
          class:
            'muted',
        },
        'The room link stays stable for this campaign. ' +
        'The DM browser must keep the session open.'
      )
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'TURN relay (optional)'
      ),

      h(
        'div',
        {
          class:
            'two-col',
        },

        h(
          'label',
          {},
          'TURN URLs',
          turnUrls
        ),

        h(
          'label',
          {},
          'Username',
          turnUser
        ),

        h(
          'label',
          {},
          'Credential',
          turnCred
        )
      ),

      h(
        'div',
        {
          class:
            'row',
        },

        h(
          'button',
          {
            onclick:
              testTurn,
          },
          'Test TURN credentials'
        ),

        turnTestStatus
      ),

      h(
        'label',
        {},

        h(
          'input',
          {
            type:
              'checkbox',

            onchange:
              () => {
                // Stored for next session.
              },
          }
        ),

        // Replace the generated checkbox child
        // below with the actual reusable element.
      ),

      h(
        'div',
        {
          class:
            'muted',
        },
        'Without TURN, WebRTC can still connect directly. ' +
        'TURN is required on networks that cannot establish ' +
        'a direct path.'
      ),

      h(
        'div',
        {
          class:
            'muted',
        },
        'Warning: when TURN is configured, its credentials ' +
        'are embedded in the join link so players can use it.'
      )
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Lobby'
      ),

      lobbyEl
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Players'
      ),

      playersEl
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Chat'
      ),

      chat.el
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Connection log'
      ),

      logEl
    )
  );

  // Replace the placeholder checkbox in the rendered
  // section with a proper relay-only control.
  //
  // This is intentionally done after rendering so
  // that the same DOM object is used by openSession().
  const relayContainer =
    document.querySelector(
      '.notice'
    )?.parentElement;

  if (relayContainer) {
    const checkbox =
      h(
        'input',
        {
          type:
            'checkbox',
        }
      );

    checkbox.checked =
      false;

    checkbox.addEventListener(
      'change',
      () => {
        if (
          session
        ) {
          log(
            'relay-only setting will apply to the next session'
          );
        }
      }
    );

    // Keep relayCheck synchronized with the visible checkbox.
    checkbox.addEventListener(
      'change',
      () => {
        relayCheck.checked =
          checkbox.checked;
      }
    );

    const label =
      h(
        'label',
        {},
        checkbox,
        ' Relay-only test: force WebRTC through TURN'
      );

    relayContainer.insertBefore(
      label,
      relayContainer.children[
        relayContainer.children.length - 1
      ]
    );
  }

  cleanup =
    () => {
      dmPeer?.destroy();

      dmPeer =
        null;
    };
}

// ---------------------------------------------------------------------------
// PLAYER
// ---------------------------------------------------------------------------

function viewPlayer(
  room,
  opts = {}
) {
  let token =
    sessionStorage.getItem(
      SS_TOKEN
    );

  const newToken =
    !token;

  if (!token) {
    token =
      rid(24);

    sessionStorage.setItem(
      SS_TOKEN,
      token
    );
  }

  let peer =
    null;

  let state =
    'idle';

  let joinTimer =
    null;

  let wantJoin =
    false;

  let t0 =
    0;

  let turn =
    opts.turn ||
    null;

  const relayOnly =
    !!opts.relayOnly;

  const {
    el: logEl,
    log,
  } =
    makeLog(
      'Player',
      () =>
        peer
          ? peer.status()
          : log(
              'not connected yet'
            )
    );

  log(
    `link: room ${room}; ` +
    `identity token ${token.slice(0, 6)}… ` +
    `(${
      newToken
        ? 'new for this tab'
        : 'kept from earlier in this tab'
    })`
  );

  if (turn) {
    log(
      `link provides TURN: ` +
      `${turn.urls.join(', ')}`
    );
  }

  if (relayOnly) {
    log(
      'link requests RELAY-ONLY mode'
    );
  }

  const statusEl =
    h(
      'div',
      {
        class:
          'status',
      },
      'Enter your name and join.'
    );

  const infoEl =
    h(
      'div',
      {
        class:
          'muted',
      }
    );

  const nameInput =
    h(
      'input',
      {
        value:
          localStorage.getItem(
            LS_NAME
          ) || '',

        placeholder:
          'Your name',

        maxlength:
          '30',
      }
    );

  const joinButton =
    h(
      'button',
      {
        onclick:
          () =>
            join(),
      },
      'Join'
    );

  const disconnectButton =
    h(
      'button',
      {
        onclick:
          () => {
            peer?.destroy();

            peer =
              null;

            wantJoin =
              false;

            setState(
              'idle',
              'Disconnected.'
            );
          },
      },
      'Disconnect'
    );

  const chat =
    makeChat(
      text => {
        if (
          state ===
          'accepted'
        ) {
          peer.send(
            {
              t:
                'chat',

              text,
            }
          );
        }
      }
    );

  chat.setEnabled(
    false
  );

  function setState(
    next,
    text
  ) {
    if (
      next !==
      state
    ) {
      log(
        `state: ${state} -> ${next} | ${text}`
      );
    }

    state =
      next;

    statusEl.textContent =
      text;

    chat.setEnabled(
      state ===
        'accepted'
    );
  }

  function sendJoin() {
    if (
      !peer ||
      !peer.isConnected()
    ) {
      return;
    }

    peer.send(
      {
        t:
          'join',

        token,

        name:
          nameInput.value.trim() ||
          'Player',
      }
    );

    clearTimeout(
      joinTimer
    );

    joinTimer =
      setTimeout(
        () => {
          if (
            state ===
            'joining'
          ) {
            setState(
              'joining',
              'Connected to the DM transport, waiting for a reply…'
            );
          }
        },
        JOIN_REPLY_TIMEOUT_MS
      );
  }

  function join() {
    const name =
      nameInput.value.trim();

    if (!name) {
      nameInput.focus();
      return;
    }

    localStorage.setItem(
      LS_NAME,
      name
    );

    nameInput.disabled =
      true;

    joinButton.disabled =
      true;

    wantJoin =
      true;

    t0 =
      performance.now();

    log(
      `Join clicked as "${name}"`
    );

    if (
      peer?.isConnected()
    ) {
      setState(
        'joining',
        'Connected. Asking the DM to let you in…'
      );

      sendJoin();

      return;
    }

    if (peer) {
      return;
    }

    setState(
      'connecting',
      'Connecting to the DM…'
    );

    peer =
      createPlayerPeer(
        room,
        {
          log,

          turn,

          relayOnly,

          onConnect:
            () => {
              if (
                wantJoin
              ) {
                setState(
                  'joining',
                  'Connected. Asking the DM to let you in…'
                );

                sendJoin();
              }
            },

          onDisconnect:
            () => {
              if (
                state ===
                  'accepted' ||
                state ===
                  'pending'
              ) {
                setState(
                  'connecting',
                  'Connection to the DM lost. Reconnecting…'
                );
              }
            },

          onReconnecting:
            (
              attempt,
              delay
            ) => {
              setState(
                'connecting',
                `DM not reachable yet ` +
                `(retry ${attempt}, ` +
                `next in ${Math.round(
                  delay / 1000
                )}s)…`
              );
            },

          onMessage:
            message =>
              onPlayerMessage(
                message
              ),
        }
      );

    peer.start();
  }

  function onPlayerMessage(
    message
  ) {
    if (
      !message ||
      typeof message !==
        'object'
    ) {
      return;
    }

    switch (
      message.t
    ) {
      case 'pending':
        clearTimeout(
          joinTimer
        );

        setState(
          'pending',
          'Waiting for the DM to approve you…'
        );

        infoEl.textContent =
          'The DM has received your request.';

        break;

      case 'accepted':
        clearTimeout(
          joinTimer
        );

        chat.clear();

        (
          message.history ||
          []
        )
          .forEach(
            chat.add
          );

        renderPlayerRoster(
          message.roster
        );

        log(
          `ACCEPTED as Player ${message.num}; ` +
          `received ${
            (
              message.history ||
              []
            ).length
          } history message(s); ` +
          `${Math.round(
            (
              performance.now() -
              t0
            ) / 1000
          )} s since Join`
        );

        setState(
          'accepted',
          `Joined "${message.campaignName}" ` +
          `as Player ${message.num} ` +
          `(${message.name})`
        );

        infoEl.textContent =
          'WebRTC data channel is active.';

        break;

      case 'badpin':
        // Kept only for compatibility with
        // older DM versions.
        setState(
          'denied',
          'This DM is using an older PIN-based protocol.'
        );

        break;

      case 'denied':
        setState(
          'denied',
          `Not admitted: ${
            message.reason ||
            'denied'
          }`
        );

        stopPeer();
        unlockForm();

        break;

      case 'kicked':
        setState(
          'kicked',
          'You were kicked by the DM.'
        );

        stopPeer();
        unlockForm();

        break;

      case 'banned':
        setState(
          'kicked',
          'You were banned by the DM.'
        );

        stopPeer();
        unlockForm();

        break;

      case 'closed':
        clearTimeout(
          joinTimer
        );

        setState(
          'closed',
          'The DM closed the session. Reconnecting automatically when it is reopened…'
        );

        break;

      case 'chat':
        if (
          message.msg
        ) {
          chat.add(
            message.msg
          );
        }

        break;

      case 'roster':
        renderPlayerRoster(
          message.roster
        );

        break;

      case 'pong':
        break;

      default:
        log(
          `unknown message type "${message.t}"`
        );
    }
  }

  function renderPlayerRoster(
    roster = []
  ) {
    infoEl.textContent =
      'In session: ' +
      roster
        .map(
          player =>
            `P${player.num} ${player.name}` +
            (
              player.online
                ? ''
                : ' (offline)'
            )
        )
        .join(', ');
  }

  function unlockForm() {
    nameInput.disabled =
      false;

    joinButton.disabled =
      false;
  }

  function stopPeer() {
    clearTimeout(
      joinTimer
    );

    try {
      peer?.destroy();
    } catch {}

    peer =
      null;

    wantJoin =
      false;
  }

  const onVisible =
    () => {
      if (
        document.visibilityState ===
          'visible' &&
        peer &&
        wantJoin
      ) {
        peer.reconnectNow(
          'tab visible'
        );
      }
    };

  const onOnline =
    () => {
      if (
        peer &&
        wantJoin
      ) {
        peer.reconnectNow(
          'network online'
        );
      }
    };

  document.addEventListener(
    'visibilitychange',
    onVisible
  );

  window.addEventListener(
    'online',
    onOnline
  );

  $app.append(
    h(
      'div',
      {
        class:
          'row',
      },

      h(
        'a',
        {
          href:
            '#/',
        },
        '← Home'
      ),

      h(
        'b',
        {},
        `Room: ${room}`
      )
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Join session'
      ),

      h(
        'div',
        {
          class:
            'row',
        },

        nameInput,

        joinButton,

        disconnectButton
      ),

      statusEl,

      infoEl,

      h(
        'div',
        {
          class:
            'muted',
        },
        'No PIN is required.'
      )
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Chat'
      ),

      chat.el
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Connection log'
      ),

      logEl
    )
  );

  setState(
    'idle',
    'Enter your name and join.'
  );

  cleanup =
    () => {
      document.removeEventListener(
        'visibilitychange',
        onVisible
      );

      window.removeEventListener(
        'online',
        onOnline
      );

      stopPeer();

      activeLog =
        null;
    };
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const versionFooter =
  document.getElementById(
    'version'
  );

if (versionFooter) {
  versionFooter.textContent =
    `VTTRPG skeleton v${APP_VERSION} · ` +
    `PeerJS ${PEERJS_VERSION}`;
}

route();