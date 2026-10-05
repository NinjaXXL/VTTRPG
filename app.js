// VTTRPG skeleton v0.9.0
//
// PeerJS architecture follows the small, working 5.5e-companion transport:
//   DM    -> stable peer id "vttrpg-<roomId>"
//   Player-> random PeerJS id
//   Player-> peer.connect("vttrpg-<roomId>")
//
// One intentional addition:
// PeerJS no longer provides its old free TURN relay, so this version gives
// WebRTC an explicit TURN fallback. Without TURN, an iPhone on cellular and
// a DM on another network may complete signaling but fail ICE.
//
// This file intentionally keeps the networking layer small.

const APP_VERSION = '0.9.0';
const PEERJS_VERSION = '1.5.5';

const PEER_PREFIX = 'vttrpg-';

const STALE_MS = 60000;
const STALE_CHECK_MS = 15000;
const HEARTBEAT_MS = 30000;

const CONNECT_TIMEOUT_MS = 10000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const JOIN_REPLY_TIMEOUT_MS = 8000;

const LS_CAMPAIGNS = 'vttrpg:campaigns';
const LS_NAME = 'vttrpg:playerName';
const SS_TOKEN = 'vttrpg:playerToken';

const DEFAULT_ICE_SERVERS = [
  {
    urls: 'stun:stun.l.google.com:19302',
  },

  {
    urls: 'stun:openrelay.metered.ca:80',
  },

  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },

  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },

  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

const PEER_SERVER_CONFIG = {
  config: {
    iceServers: DEFAULT_ICE_SERVERS,
    sdpSemantics: 'unified-plan',
  },

  debug: 2,
};

let activeLog = null;

const safeStr = value => {
  try {
    return typeof value === 'string'
      ? value
      : (
          value?.message ||
          JSON.stringify(value)
        );
  } catch {
    return String(value);
  }
};

for (const level of ['warn', 'error']) {
  const original =
    console[level].bind(console);

  console[level] = (...args) => {
    original(...args);

    try {
      activeLog?.(
        `console.${level}: ` +
        args
          .map(safeStr)
          .join(' ')
          .slice(0, 500)
      );
    } catch {
      // ignore logger failures
    }
  };
}

window.addEventListener(
  'error',
  event => {
    activeLog?.(
      `window error: ${event.message}`
    );
  }
);

window.addEventListener(
  'unhandledrejection',
  event => {
    activeLog?.(
      `unhandled rejection: ${safeStr(event.reason)}`
    );
  }
);

window.addEventListener(
  'online',
  () => {
    activeLog?.(
      'browser went ONLINE'
    );
  }
);

window.addEventListener(
  'offline',
  () => {
    activeLog?.(
      'browser went OFFLINE'
    );
  }
);

document.addEventListener(
  'visibilitychange',
  () => {
    activeLog?.(
      'tab is now ' +
      document.visibilityState
    );
  }
);

// -----------------------------------------------------------------------------
// WebRTC diagnostics
// -----------------------------------------------------------------------------

if (
  window.RTCPeerConnection &&
  !window.__vttrpgPcPatched
) {
  window.__vttrpgPcPatched = true;

  const NativePC =
    window.RTCPeerConnection;

  let pcCount = 0;

  window.RTCPeerConnection =
    class extends NativePC {
      constructor(config, ...rest) {
        super(config, ...rest);

        const id =
          ++pcCount;

        const logRtc =
          message =>
            activeLog?.(
              `rtc#${id}: ${message}`
            );

        const serverKinds = {};

        for (
          const server
          of config?.iceServers || []
        ) {
          const urls =
            []
              .concat(
                server.urls ||
                server.url ||
                []
              );

          for (
            const url
            of urls
          ) {
            const kind =
              String(url)
                .split(':')[0];

            serverKinds[kind] =
              (
                serverKinds[kind] ||
                0
              ) + 1;
          }
        }

        logRtc(
          `new connection; ICE servers: ` +
          JSON.stringify(
            serverKinds
          )
        );

        const localCandidates = {};
        const remoteCandidates = {};

        const candidateType =
          value =>
            /\btyp\s+(\w+)/.exec(
              value || ''
            )?.[1];

        const stats =
          async label => {
            try {
              const report =
                await this.getStats();

              const pairs = [];

              report.forEach(
                item => {
                  if (
                    item.type !==
                    'candidate-pair'
                  ) {
                    return;
                  }

                  const local =
                    report.get(
                      item.localCandidateId
                    );

                  const remote =
                    report.get(
                      item.remoteCandidateId
                    );

                  pairs.push({
                    state:
                      item.state,

                    nominated:
                      !!item.nominated,

                    selected:
                      !!item.selected,

                    local:
                      local?.candidateType ||
                      '?',

                    remote:
                      remote?.candidateType ||
                      '?',

                    requests:
                      item.requestsSent ||
                      0,

                    responses:
                      item.responsesReceived ||
                      0,
                  });
                }
              );

              logRtc(
                `${label}: ` +
                JSON.stringify({
                  ice:
                    this.iceConnectionState,

                  connection:
                    this.connectionState,

                  gathering:
                    this.iceGatheringState,

                  pairs,

                  localCandidates,

                  remoteCandidates,
                })
              );
            } catch (
              error
            ) {
              logRtc(
                `stats failed: ${error.message}`
              );
            }
          };

        this.addEventListener(
          'icecandidate',
          event => {
            if (
              event.candidate
            ) {
              const type =
                candidateType(
                  event.candidate
                    .candidate
                ) ||
                '?';

              const key =
                `${type}/${
                  event.candidate.protocol ||
                  '?'
                }`;

              localCandidates[key] =
                (
                  localCandidates[key] ||
                  0
                ) + 1;
            } else {
              logRtc(
                `ICE gathering finished: ` +
                JSON.stringify(
                  localCandidates
                )
              );
            }
          }
        );

        this.addEventListener(
          'icecandidateerror',
          event => {
            logRtc(
              `ICE candidate error ` +
              `${event.errorCode || ''} ` +
              `${event.url || ''} ` +
              `${event.errorText || ''}`
            );
          }
        );

        this.addEventListener(
          'iceconnectionstatechange',
          () => {
            logRtc(
              `ice=${this.iceConnectionState}`
            );

            if (
              this.iceConnectionState ===
              'checking'
            ) {
              setTimeout(
                () => {
                  if (
                    this.iceConnectionState ===
                    'checking'
                  ) {
                    stats(
                      'ICE still checking'
                    );
                  }
                },
                3000
              );

              setTimeout(
                () => {
                  if (
                    this.iceConnectionState ===
                    'checking'
                  ) {
                    stats(
                      'ICE still checking after 8s'
                    );
                  }
                },
                8000
              );
            }
          }
        );

        this.addEventListener(
          'connectionstatechange',
          () => {
            logRtc(
              `conn=${this.connectionState}`
            );

            if (
              this.connectionState ===
              'connected'
            ) {
              setTimeout(
                () =>
                  stats(
                    'CONNECTED'
                  ),
                500
              );
            }

            if (
              this.connectionState ===
              'failed'
            ) {
              stats(
                'FAILED'
              );
            }
          }
        );

        const originalSRD =
          this.setRemoteDescription.bind(
            this
          );

        this.setRemoteDescription =
          description => {
            (
              description?.sdp ||
              ''
            )
              .split('\n')
              .filter(
                line =>
                  line.startsWith(
                    'a=candidate'
                  )
              )
              .forEach(
                line => {
                  const type =
                    candidateType(
                      line
                    );

                  if (type) {
                    remoteCandidates[type] =
                      (
                        remoteCandidates[type] ||
                        0
                      ) + 1;
                  }
                }
              );

            logRtc(
              `remote ${description?.type} set; ` +
              `remote candidates=` +
              JSON.stringify(
                remoteCandidates
              )
            );

            return originalSRD(
              description
            );
          };
      }
    };
}

const footer =
  document.getElementById(
    'version'
  );

if (footer) {
  footer.textContent =
    `VTTRPG skeleton v${APP_VERSION} · ` +
    `PeerJS ${PEERJS_VERSION}`;
}

const short =
  id =>
    String(id || '')
      .slice(0, 8);

const rid =
  (length = 12) => {
    const chars =
      'abcdefghijklmnopqrstuvwxyz0123456789';

    const bytes =
      new Uint8Array(length);

    crypto.getRandomValues(
      bytes
    );

    return [...bytes]
      .map(
        byte =>
          chars[
            byte % chars.length
          ]
      )
      .join('');
  };

function h(
  tag,
  props = {},
  ...kids
) {
  const element =
    document.createElement(
      tag
    );

  for (
    const [
      key,
      value,
    ]
    of Object.entries(props)
  ) {
    if (
      key.startsWith('on')
    ) {
      element.addEventListener(
        key.slice(2),
        value
      );
    } else if (
      key === 'class'
    ) {
      element.className =
        value;
    } else {
      element.setAttribute(
        key,
        value
      );
    }
  }

  for (
    const child
    of kids.flat()
  ) {
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
}

// -----------------------------------------------------------------------------
// PeerJS transport
// -----------------------------------------------------------------------------

function createDMPeer(
  roomId,
  {
    log,
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
  let reconnectTimer = null;
  let reconnectAttempt = 0;

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
          'DM peer destroyed'
        )
      );

      return;
    }

    opened =
      false;

    log(
      `registering ${peerId} at the PeerJS cloud ` +
      `(attempt ${attempt + 1})…`
    );

    // Stable DM ID. This is the important reference-repo pattern.
    peer =
      new window.Peer(
        peerId,
        PEER_SERVER_CONFIG
      );

    peer.on(
      'open',
      id => {
        if (
          opened
        ) {
          reconnectAttempt =
            0;

          if (
            reconnectTimer
          ) {
            clearTimeout(
              reconnectTimer
            );

            reconnectTimer =
              null;
          }

          onSignaling?.(
            'connected'
          );

          log(
            `signaling re-established as ${id}`
          );

          return;
        }

        opened =
          true;

        reconnectAttempt =
          0;

        log(
          `PeerJS signaling connected as ${id}`
        );

        resolve(
          id
        );
      }
    );

    peer.on(
      'connection',
      conn => {
        handleIncoming(
          conn
        );
      }
    );

    peer.on(
      'disconnected',
      () => {
        if (
          destroyed
        ) {
          return;
        }

        log(
          'DM lost PeerJS signaling connection'
        );

        onSignaling?.(
          'reconnecting'
        );

        scheduleReconnect();
      }
    );

    peer.on(
      'error',
      error => {
        if (
          destroyed
        ) {
          return;
        }

        log(
          `PeerJS error ` +
          `(${error?.type || 'unknown'}): ` +
          `${safeStr(error)}`
        );

        if (
          !opened
        ) {
          if (
            error?.type ===
              'unavailable-id' &&
            attempt < 3
          ) {
            const delay =
              2000 *
              (attempt + 1);

            log(
              `stable ID still held; ` +
              `retrying in ${delay}ms`
            );

            try {
              peer.destroy();
            } catch {}

            setTimeout(
              () => {
                if (
                  !destroyed
                ) {
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
                ? 'Session ID is still held by another browser.'
                : (
                  'PeerJS error: ' +
                  (
                    error?.type ||
                    safeStr(error)
                  )
                )
            )
          );
        }
      }
    );
  }

  function scheduleReconnect() {
    if (
      destroyed ||
      reconnectTimer
    ) {
      return;
    }

    const delay =
      Math.min(
        RECONNECT_BASE_MS *
          (
            2 **
            reconnectAttempt
          ),
        RECONNECT_MAX_MS
      );

    reconnectAttempt++;

    log(
      `DM signaling reconnect in ${delay}ms ` +
      `(attempt ${reconnectAttempt})`
    );

    reconnectTimer =
      setTimeout(
        () => {
          reconnectTimer =
            null;

          if (
            destroyed ||
            !peer ||
            peer.destroyed
          ) {
            return;
          }

          try {
            peer.reconnect();
          } catch (
            error
          ) {
            log(
              `PeerJS reconnect failed: ` +
              `${error.message}`
            );
          }
        },
        delay
      );
  }

  function handleIncoming(
    conn
  ) {
    const pid =
      conn.peer;

    log(
      `incoming connection from ` +
      `${short(pid)} (negotiating…)`
    );

    conn.on(
      'open',
      () => {
        connections.set(
          pid,
          {
            conn,
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

    conn.on(
      'data',
      data => {
        const entry =
          connections.get(
            pid
          );

        if (
          entry &&
          entry.conn ===
            conn
        ) {
          entry.lastActivity =
            Date.now();
        }

        if (
          data?.t ===
          'ping'
        ) {
          try {
            conn.send({
              t:
                'pong',

              ts:
                data.ts,
            });
          } catch {}

          return;
        }

        log(
          `← ${short(pid)} ` +
          `${data?.t ?? typeof data}`
        );

        onMessage?.(
          data,
          pid
        );
      }
    );

    conn.on(
      'close',
      () => {
        const entry =
          connections.get(
            pid
          );

        if (
          !entry ||
          entry.conn !==
            conn
        ) {
          return;
        }

        connections.delete(
          pid
        );

        log(
          `player ${short(pid)} gone`
        );

        onPlayerDisconnect?.(
          pid
        );
      }
    );

    conn.on(
      'error',
      error => {
        log(
          `connection error ` +
          `${short(pid)}: ` +
          `${safeStr(error)}`
        );
      }
    );
  }

  function ensureStaleCheck() {
    if (
      staleTimer
    ) {
      return;
    }

    staleTimer =
      setInterval(
        () => {
          if (
            destroyed
          ) {
            clearInterval(
              staleTimer
            );

            staleTimer =
              null;

            return;
          }

          const time =
            Date.now();

          for (
            const [
              pid,
              entry,
            ]
            of connections
          ) {
            if (
              time -
                entry.lastActivity >
              STALE_MS
            ) {
              log(
                `stale player ${short(pid)}`
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

            staleTimer =
              null;
          }
        },
        STALE_CHECK_MS
      );
  }

  return {
    init,

    send(
      data,
      target
    ) {
      const list =
        target
          ? [
              [
                target,
                connections.get(
                  target
                ),
              ],
            ]
          : [
              ...connections.entries(),
            ];

      for (
        const [
          pid,
          entry,
        ]
        of list
      ) {
        if (
          !entry?.conn?.open
        ) {
          continue;
        }

        try {
          entry.conn.send(
            data
          );

          log(
            `→ ${short(pid)} ` +
            `${data?.t ?? typeof data}`
          );
        } catch (
          error
        ) {
          log(
            `send failed: ${error.message}`
          );
        }
      }
    },

    close(
      pid
    ) {
      const entry =
        connections.get(
          pid
        );

      if (!entry) {
        return;
      }

      connections.delete(
        pid
      );

      try {
        entry.conn.close();
      } catch {}
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
        } ` +
        `players=${connections.size}`
      );
    },

    destroy() {
      destroyed =
        true;

      if (
        staleTimer
      ) {
        clearInterval(
          staleTimer
        );

        staleTimer =
          null;
      }

      if (
        reconnectTimer
      ) {
        clearTimeout(
          reconnectTimer
        );

        reconnectTimer =
          null;
      }

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

      peer =
        null;
    },
  };
}

function createPlayerPeer(
  roomId,
  {
    log,
    onConnect,
    onDisconnect,
    onReconnecting,
    onMessage,
  }
) {
  const hostId =
    PEER_PREFIX + roomId;

  let peer = null;
  let conn = null;

  let destroyed = false;
  let reconnectTimer = null;
  let attemptTimer = null;
  let heartbeatTimer = null;
  let reconnectAttempt = 0;
  let connectAttempt = 0;

  function start() {
    destroyed =
      false;

    createPeer();
  }

  function createPeer() {
    if (
      peer &&
      !peer.destroyed
    ) {
      return;
    }

    log(
      'registering player at the PeerJS cloud…'
    );

    // Random player ID, exactly like the reference layer.
    peer =
      new window.Peer(
        undefined,
        PEER_SERVER_CONFIG
      );

    peer.on(
      'open',
      id => {
        reconnectAttempt =
          0;

        log(
          `PeerJS signaling connected as ${id}`
        );

        openConnection();
      }
    );

    peer.on(
      'disconnected',
      () => {
        if (
          destroyed
        ) {
          return;
        }

        log(
          'player lost PeerJS signaling; ' +
          'reconnecting…'
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
              } catch (
                error
              ) {
                log(
                  `peer.reconnect failed: ` +
                  `${error.message}`
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
          destroyed
        ) {
          return;
        }

        log(
          `PeerJS player error ` +
          `(${error?.type || 'unknown'}): ` +
          `${safeStr(error)}`
        );

        scheduleReconnect();
      }
    );
  }

  function openConnection() {
    if (
      destroyed ||
      !peer ||
      peer.destroyed
    ) {
      return;
    }

    if (
      conn
    ) {
      try {
        conn.close();
      } catch {}

      conn =
        null;
    }

    const attempt =
      ++connectAttempt;

    log(
      `connecting to DM ${hostId} ` +
      `(attempt ${attempt})…`
    );

    const c =
      peer.connect(
        hostId,
        {
          reliable:
            true,
        }
      );

    conn =
      c;

    let opened =
      false;

    clearTimeout(
      attemptTimer
    );

    attemptTimer =
      setTimeout(
        () => {
          if (
            opened ||
            destroyed ||
            conn !== c
          ) {
            return;
          }

          log(
            `attempt ${attempt} timed out`
          );

          try {
            c.close();
          } catch {}

          scheduleReconnect();
        },
        CONNECT_TIMEOUT_MS
      );

    c.on(
      'iceStateChanged',
      state => {
        log(
          `PeerJS ICE state: ${state}`
        );
      }
    );

    c.on(
      'open',
      () => {
        opened =
          true;

        clearTimeout(
          attemptTimer
        );

        reconnectAttempt =
          0;

        log(
          `data channel to DM OPEN ` +
          `(attempt ${attempt})`
        );

        startHeartbeat();

        onConnect?.();
      }
    );

    c.on(
      'data',
      data => {
        if (
          data?.t ===
          'pong'
        ) {
          return;
        }

        log(
          `← DM ${data?.t ?? typeof data}`
        );

        onMessage?.(
          data
        );
      }
    );

    c.on(
      'close',
      () => {
        clearTimeout(
          attemptTimer
        );

        if (
          conn !== c ||
          destroyed
        ) {
          return;
        }

        stopHeartbeat();

        conn =
          null;

        log(
          'data channel to DM closed'
        );

        if (
          opened
        ) {
          onDisconnect?.();
        }

        scheduleReconnect();
      }
    );

    c.on(
      'error',
      error => {
        clearTimeout(
          attemptTimer
        );

        if (
          conn !== c ||
          destroyed
        ) {
          return;
        }

        stopHeartbeat();

        log(
          `connection error: ` +
          `${error?.type || ''} ` +
          `${safeStr(error)}`
        );

        if (
          opened
        ) {
          onDisconnect?.();
        }

        scheduleReconnect();
      }
    );
  }

  function scheduleReconnect() {
    if (
      destroyed ||
      reconnectTimer
    ) {
      return;
    }

    const delay =
      Math.min(
        RECONNECT_BASE_MS *
          (
            2 **
            reconnectAttempt
          ),
        RECONNECT_MAX_MS
      );

    reconnectAttempt++;

    log(
      `player retry ${reconnectAttempt} ` +
      `in ${delay}ms`
    );

    onReconnecting?.(
      reconnectAttempt,
      delay
    );

    reconnectTimer =
      setTimeout(
        () => {
          reconnectTimer =
            null;

          if (
            destroyed
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
            } catch {}
          } else {
            openConnection();
          }
        },
        delay
      );
  }

  function cancelReconnect() {
    if (
      reconnectTimer
    ) {
      clearTimeout(
        reconnectTimer
      );

      reconnectTimer =
        null;
    }

    reconnectAttempt =
      0;
  }

  function reconnectNow(
    why = 'manual'
  ) {
    if (
      destroyed ||
      conn?.open
    ) {
      return;
    }

    log(
      `reconnect now: ${why}`
    );

    cancelReconnect();

    if (
      peer?.disconnected
    ) {
      try {
        peer.reconnect();
      } catch {}
    } else {
      openConnection();
    }
  }

  function startHeartbeat() {
    stopHeartbeat();

    heartbeatTimer =
      setInterval(
        () => {
          if (
            conn?.open
          ) {
            try {
              conn.send({
                t:
                  'ping',

                ts:
                  Date.now(),
              });
            } catch {}
          }
        },
        HEARTBEAT_MS
      );
  }

  function stopHeartbeat() {
    if (
      heartbeatTimer
    ) {
      clearInterval(
        heartbeatTimer
      );

      heartbeatTimer =
        null;
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
          conn.send(
            data
          );

          log(
            `→ DM ${data?.t ?? typeof data}`
          );
        } catch (
          error
        ) {
          log(
            `send failed: ${error.message}`
          );
        }
      } else {
        log(
          `not sent: no DM connection`
        );
      }
    },

    reconnectNow,

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
        } ` +
        `channel=${
          conn?.open
            ? 'open'
            : 'closed'
        } ` +
        `attempts=${connectAttempt}`
      );
    },

    destroy() {
      destroyed =
        true;

      cancelReconnect();
      clearTimeout(
        attemptTimer
      );

      stopHeartbeat();

      try {
        conn?.close();
      } catch {}

      try {
        peer?.destroy();
      } catch {}

      conn =
        null;

      peer =
        null;
    },
  };
}

// -----------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------------

const loadAll =
  () => {
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
  };

function saveCampaign(
  campaign
) {
  try {
    const all =
      loadAll();

    all[campaign.id] =
      campaign;

    localStorage.setItem(
      LS_CAMPAIGNS,
      JSON.stringify(all)
    );
  } catch (
    error
  ) {
    alert(
      'Could not save: ' +
      error.message
    );
  }
}

function deleteCampaign(
  id
) {
  const all =
    loadAll();

  delete all[id];

  localStorage.setItem(
    LS_CAMPAIGNS,
    JSON.stringify(all)
  );
}

// -----------------------------------------------------------------------------
// Log
// -----------------------------------------------------------------------------

function makeLog(
  role,
  onStatus
) {
  const pre =
    h(
      'pre',
      {
        class:
          'log',
      }
    );

  const log =
    text => {
      pre.textContent +=
        `${new Date().toISOString().slice(11, 23)}  ${text}\n`;

      pre.scrollTop =
        pre.scrollHeight;

      console.log(
        `[VTTRPG ${role}]`,
        text
      );
    };

  const toolbar =
    h(
      'div',
      {
        class:
          'row',
      },

      onStatus
        ? h(
            'button',
            {
              onclick:
                onStatus,
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
                  'log copied'
                );
              } catch (
                error
              ) {
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
              pre.textContent =
                '';
            },
        },
        'Clear'
      )
    );

  activeLog =
    log;

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

  log(
    `ICE fallback: OpenRelay TURN on 80/443`
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

// -----------------------------------------------------------------------------
// Chat
// -----------------------------------------------------------------------------

function makeChat(
  onSend
) {
  const box =
    h(
      'div',
      {
        class:
          'chat',
      }
    );

  const input =
    h(
      'input',
      {
        placeholder:
          'Message…',

        maxlength:
          '500',
      }
    );

  const button =
    h(
      'button',
      {},
      'Send'
    );

  const send =
    () => {
      const text =
        input.value.trim();

      if (!text) {
        return;
      }

      onSend(
        text
      );

      input.value =
        '';
    };

  input.addEventListener(
    'keydown',
    event => {
      if (
        event.key ===
        'Enter'
      ) {
        send();
      }
    }
  );

  button.addEventListener(
    'click',
    send
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
            class:
              'row',
          },

          input,
          button
        )
      ),

    add(
      message
    ) {
      box.append(
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
              class:
                'ts',
            },

            new Date(
              message.ts
            ).toLocaleTimeString() +
            ' '
          ),

          message.sys
            ? message.text
            : [
                h(
                  'b',
                  {},
                  message.from +
                    ': '
                ),

                message.text,
              ]
        )
      );

      box.scrollTop =
        box.scrollHeight;
    },

    clear() {
      box.replaceChildren();
    },

    setEnabled(
      enabled
    ) {
      input.disabled =
        !enabled;

      button.disabled =
        !enabled;
    },
  };
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

const $app =
  document.getElementById(
    'app'
  );

let cleanup =
  null;

function route() {
  if (
    cleanup
  ) {
    cleanup();
    cleanup =
      null;
  }

  activeLog =
    null;

  $app.replaceChildren();

  const [
    hash,
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
    viewPlayer(
      match[1]
    );

    return;
  }

  if (
    (
      match =
        hash.match(
          /^\/dm\/([a-z0-9]+)$/i
        )
    )
  ) {
    viewDM(
      match[1]
    );

    return;
  }

  viewHome();
}

window.addEventListener(
  'hashchange',
  route
);

// -----------------------------------------------------------------------------
// HOME
// -----------------------------------------------------------------------------

function viewHome() {
  const nameInput =
    h(
      'input',
      {
        placeholder:
          'New campaign name',
      }
    );

  const list =
    h('div');

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

        nextNum:
          1,

        players:
          {},

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

  function renderList() {
    const campaigns =
      Object.values(
        loadAll()
      );

    list.replaceChildren(
      ...(
        campaigns.length
          ? campaigns.map(
              campaign =>
                h(
                  'div',
                  {
                    class:
                      'row',
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

                    `${
                      Object.keys(
                        campaign.players ||
                        {}
                      ).length
                    } players, ` +

                    `${
                      (
                        campaign.chat ||
                        []
                      ).length
                    } messages`
                  ),

                  h(
                    'button',
                    {
                      onclick:
                        () =>
                          location.hash =
                            '#/dm/' +
                            campaign.id,
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
                              `Delete "${campaign.name}"?`
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
          : [
              h(
                'div',
                {
                  class:
                    'muted',
                },
                'No campaigns yet.'
              ),
            ]
      )
    );
  }

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
          class:
            'row',
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
        'Campaigns'
      ),

      list
    ),

    h(
      'section',
      {
        class:
          'muted',
      },

      'Players join using the QR code or link.'
    )
  );

  renderList();
}

// -----------------------------------------------------------------------------
// DM
// -----------------------------------------------------------------------------

function viewDM(
  cid
) {
  const campaign =
    loadAll()[cid];

  if (!campaign) {
    location.hash =
      '#/';

    return;
  }

  if (
    !campaign.players ||
    typeof campaign.players !==
      'object'
  ) {
    campaign.players =
      {};
  }

  if (
    !Array.isArray(
      campaign.chat
    )
  ) {
    campaign.chat =
      [];
  }

  if (!campaign.nextNum) {
    campaign.nextNum =
      1;
  }

  const save =
    () =>
      saveCampaign(
        campaign
      );

  let dmPeer =
    null;

  let session =
    null;

  let opening =
    false;

  const peers =
    new Map();

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
    `(${cid}) loaded: ` +
    `${Object.keys(
      campaign.players
    ).length} known players, ` +
    `${campaign.chat.length} chat messages`
  );

  const modeSel =
    h(
      'select',
      {
        onchange:
          () => {
            if (
              session
            ) {
              session.mode =
                modeSel.value;
            }
          },
      },

      h(
        'option',
        {
          value:
            'approval',
        },
        'Approval required'
      ),

      h(
        'option',
        {
          value:
            'open',
        },
        'Open (auto-approve)'
      ),

      h(
        'option',
        {
          value:
            'locked',
        },
        'Locked'
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

  const signal =
    h(
      'span',
      {
        class:
          'tag',
      },
      'no session'
    );

  const linkInput =
    h(
      'input',
      {
        readonly:
          '',

        placeholder:
          'Session link',
      }
    );

  const lobby =
    h('div');

  const players =
    h('div');

  const qr =
    h(
      'div',
      {
        id:
          'qr',
      }
    );

  const chat =
    makeChat(
      text =>
        postChat(
          {
            from:
              'DM',

            text,
          }
        )
    );

  chat.setEnabled(
    false
  );

  campaign.chat
    .slice(-100)
    .forEach(
      chat.add
    );

  function sendTo(
    data,
    pid
  ) {
    dmPeer?.send(
      data,
      pid
    );
  }

  function approvedPeerIds() {
    return [
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
  }

  function isOnline(
    token
  ) {
    return [
      ...peers.values(),
    ].some(
      player =>
        player.token ===
          token &&
        player.status ===
          'approved'
    );
  }

  function roster() {
    return Object.values(
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
            isOnline(
              player.token
            ),
        })
      );
  }

  function renderLobby() {
    const waiting =
      [
        ...peers.entries(),
      ]
        .filter(
          ([, player]) =>
            player.status ===
            'pending'
        );

    lobby.replaceChildren(
      ...(
        waiting.length
          ? waiting.map(
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
            ]
      )
    );
  }

  function renderPlayers() {
    const known =
      Object.entries(
        campaign.players
      );

    players.replaceChildren(
      ...(
        known.length
          ? known.map(
              ([
                token,
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
                      : isOnline(
                          token
                        )
                        ? 'online'
                        : 'offline'
                  ),

                  player.banned
                    ? h(
                        'button',
                        {
                          onclick:
                            () => {
                              player.banned =
                                false;

                              save();

                              renderPlayers();
                            },
                        },
                        'Unban'
                      )
                    : [
                        isOnline(
                          token
                        )
                          ? h(
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
                            )
                          : null,

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
          : [
              h(
                'div',
                {
                  class:
                    'muted',
                },
                'No players yet.'
              ),
            ]
      )
    );
  }

  function systemMsg(
    text
  ) {
    postChat(
      {
        sys:
          true,

        text,
      }
    );
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
      1000
    ) {
      campaign.chat.splice(
        0,
        campaign.chat.length -
          1000
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

  function sendAccepted(
    pid,
    player
  ) {
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

        history:
          campaign.chat.slice(-50),

        roster:
          roster(),
      },
      pid
    );
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

    const existing =
      campaign.players[
        player.token
      ];

    if (existing) {
      player.status =
        'approved';

      player.num =
        existing.num;

      player.name =
        existing.name;

      sendAccepted(
        pid,
        existing
      );

      renderLobby();
      renderPlayers();

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
      pid,
      campaign.players[
        player.token
      ]
    );

    systemMsg(
      `${player.name} joined as Player ${num}`
    );

    renderLobby();
    renderPlayers();
  }

  function deny(
    pid
  ) {
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
      () =>
        dmPeer?.close(
          pid
        ),
      200
    );

    renderLobby();
  }

  function kick(
    token,
    ban
  ) {
    const pid =
      [
        ...peers,
      ]
        .find(
          ([, player]) =>
            player.token ===
            token
        )?.[0];

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
        () =>
          dmPeer?.close(
            pid
          ),
        200
      );
    }

    if (
      campaign.players[
        token
      ]
    ) {
      campaign.players[
        token
      ].banned =
        ban;

      save();
    }

    renderLobby();
    renderPlayers();
  }

  function handleJoin(
    message,
    pid
  ) {
    const token =
      String(
        message.token ||
        ''
      ).slice(
        0,
        64
      );

    const name =
      String(
        message.name ||
        'Player'
      )
        .trim()
        .slice(
          0,
          30
        );

    if (!token) {
      return;
    }

    const saved =
      campaign.players[
        token
      ];

    log(
      `JOIN REQUEST from ${short(pid)} ` +
      `"${name}" ` +
      `${
        saved
          ? `(known Player ${saved.num})`
          : '(new)'
      }`
    );

    if (
      saved?.banned
    ) {
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

    for (
      const [
        otherPid,
        other,
      ]
      of peers
    ) {
      if (
        other.token ===
          token &&
        otherPid !==
          pid
      ) {
        peers.delete(
          otherPid
        );

        dmPeer?.close(
          otherPid
        );
      }
    }

    if (saved) {
      saved.name =
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
            saved.num,
        }
      );

      sendAccepted(
        pid,
        saved
      );

      renderLobby();
      renderPlayers();

      return;
    }

    if (
      session.mode ===
      'locked'
    ) {
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

    sendTo(
      {
        t:
          'pending',
      },
      pid
    );

    renderLobby();
  }

  function onPeerMessage(
    message,
    pid
  ) {
    if (!message) {
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
      return;
    }

    if (
      message.t ===
      'chat'
    ) {
      const text =
        String(
          message.text ||
          ''
        )
          .trim()
          .slice(
            0,
            500
          );

      if (
        text
      ) {
        postChat(
          {
            from:
              `${player.name} (P${player.num})`,

            text,
          }
        );
      }
    }
  }

  async function openSession() {
    if (
      opening ||
      session
    ) {
      return;
    }

    opening =
      true;

    toggleButton.disabled =
      true;

    signal.textContent =
      'connecting…';

    if (!campaign.roomId) {
      campaign.roomId =
        rid(14);

      save();

      log(
        `created room id ${campaign.roomId}`
      );
    }

    log(
      `opening session: ` +
      `mode=${modeSel.value}, ` +
      `room=${campaign.roomId}`
    );

    const transport =
      createDMPeer(
        campaign.roomId,
        {
          log,

          onPlayerConnect:
            pid =>
              log(
                `player connected ${short(pid)}`
              ),

          onPlayerDisconnect:
            pid => {
              const player =
                peers.get(
                  pid
                );

              if (player) {
                log(
                  `${player.name} disconnected`
                );

                peers.delete(
                  pid
                );
              }

              renderLobby();
              renderPlayers();
            },

          onMessage:
            onPeerMessage,

          onSignaling:
            state => {
              signal.textContent =
                state ===
                  'connected'
                  ? 'signaling OK'
                  : 'signaling reconnecting…';
            },
        }
      );

    try {
      await transport.init();
    } catch (
      error
    ) {
      log(
        `COULD NOT OPEN SESSION: ` +
        `${error.message}`
      );

      transport.destroy();

      opening =
        false;

      toggleButton.disabled =
        false;

      signal.textContent =
        'failed';

      return;
    }

    dmPeer =
      transport;

    session = {
      mode:
        modeSel.value,
    };

    opening =
      false;

    toggleButton.disabled =
      false;

    toggleButton.textContent =
      'Close session';

    modeSel.disabled =
      true;

    chat.setEnabled(
      true
    );

    const link =
      `${location.origin}` +
      `${location.pathname}` +
      `#/join/${campaign.roomId}`;

    linkInput.value =
      link;

    qr.replaceChildren();

    if (
      window.QRCode
    ) {
      new window.QRCode(
        qr,
        {
          text:
            link,

          width:
            220,

          height:
            220,
        }
      );

      log(
        'QR code generated'
      );
    } else {
      qr.textContent =
        'QR library could not be loaded.';
    }

    signal.textContent =
      'signaling OK';

    log(
      `SESSION OPEN – DM peer id is ` +
      `"${PEER_PREFIX}${campaign.roomId}"`
    );

    log(
      'TURN fallback is enabled'
    );

    renderLobby();
    renderPlayers();
  }

  function closeSession() {
    if (!session) {
      return;
    }

    for (
      const pid of
      peers.keys()
    ) {
      sendTo(
        {
          t:
            'closed',
        },
        pid
      );
    }

    peers.clear();

    const oldPeer =
      dmPeer;

    dmPeer =
      null;

    session =
      null;

    modeSel.disabled =
      false;

    toggleButton.textContent =
      'Open session';

    signal.textContent =
      'no session';

    linkInput.value =
      '';

    qr.replaceChildren();

    chat.setEnabled(
      false
    );

    oldPeer?.destroy();

    renderLobby();
    renderPlayers();

    log(
      'session closed'
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

        modeSel,

        toggleButton,

        signal
      ),

      h(
        'div',
        {
          class:
            'muted',
        },

        'No PIN. Share the QR code or link. ' +
        'The public TURN fallback is enabled automatically.'
      ),

      h(
        'div',
        {
          class:
            'row',
        },

        linkInput,

        h(
          'button',
          {
            onclick:
              async () => {
                try {
                  await navigator.clipboard.writeText(
                    linkInput.value
                  );

                  log(
                    'join link copied'
                  );
                } catch (
                  error
                ) {
                  log(
                    `copy failed: ${error.message}`
                  );
                }
              },
          },
          'Copy link'
        )
      ),

      qr
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Lobby'
      ),

      lobby
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Players'
      ),

      players
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

  renderLobby();
  renderPlayers();

  cleanup =
    () => {
      dmPeer?.destroy();

      dmPeer =
        null;
    };
}

// -----------------------------------------------------------------------------
// PLAYER
// -----------------------------------------------------------------------------

function viewPlayer(
  roomId
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

  let startedAt =
    0;

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
    `link: room ${roomId}; ` +
    `identity token ${token.slice(0, 6)}… ` +
    `(${newToken ? 'new for this tab' : 'existing tab token'})`
  );

  const status =
    h(
      'div',
      {
        class:
          'status',
      },
      'Enter your name, then join.'
    );

  const roster =
    h(
      'div',
      {
        class:
          'muted',
      }
    );

  const name =
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

  const join =
    h(
      'button',
      {
        onclick:
          () =>
            joinSession(),
      },
      'Join'
    );

  const disconnect =
    h(
      'button',
      {
        onclick:
          () =>
            disconnectPlayer(),
      },
      'Disconnect'
    );

  const chat =
    makeChat(
      text => {
        if (
          state ===
            'accepted' &&
          peer
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

    status.textContent =
      text;

    chat.setEnabled(
      state ===
        'accepted'
    );
  }

  function sendJoin() {
    if (
      !peer?.isConnected()
    ) {
      return;
    }

    peer.send(
      {
        t:
          'join',

        token,

        name:
          name.value.trim() ||
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
            log(
              `no reply from the DM ` +
              `after ${JOIN_REPLY_TIMEOUT_MS / 1000}s`
            );

            setState(
              'joining',
              'Waiting for the DM…'
            );
          }
        },
        JOIN_REPLY_TIMEOUT_MS
      );
  }

  function joinSession() {
    const playerName =
      name.value.trim();

    if (!playerName) {
      name.focus();
      return;
    }

    localStorage.setItem(
      LS_NAME,
      playerName
    );

    startedAt =
      performance.now();

    wantJoin =
      true;

    name.disabled =
      true;

    join.disabled =
      true;

    log(
      `Join clicked as "${playerName}"`
    );

    if (
      peer?.isConnected()
    ) {
      setState(
        'joining',
        'Connected. Asking the DM…'
      );

      sendJoin();

      return;
    }

    if (
      peer
    ) {
      return;
    }

    setState(
      'connecting',
      'Connecting to DM…'
    );

    peer =
      createPlayerPeer(
        roomId,
        {
          log,

          onConnect:
            () => {
              if (
                wantJoin
              ) {
                setState(
                  'joining',
                  'Connected. Asking the DM…'
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
                  'Connection lost. Reconnecting…'
                );
              }
            },

          onReconnecting:
            (
              attempt,
              delay
            ) => {
              if (
                state ===
                  'connecting' ||
                state ===
                  'joining'
              ) {
                setState(
                  'connecting',
                  `Retry ${attempt} in ` +
                  `${Math.round(
                    delay / 1000
                  )}s…`
                );
              }
            },

          onMessage:
            message =>
              onMessage(
                message
              ),
        }
      );

    peer.start();
  }

  function onMessage(
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
          'Waiting for DM approval…'
        );

        break;

      case 'accepted':
        clearTimeout(
          joinTimer
        );

        chat.clear();

        (
          message.history ||
          []
        ).forEach(
          chat.add
        );

        renderRoster(
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
              startedAt
            ) / 1000
          )}s`
        );

        setState(
          'accepted',
          `Joined "${message.campaignName}" ` +
          `as Player ${message.num} (${message.name})`
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

        unlockForm();

        break;

      case 'kicked':
        setState(
          'kicked',
          'You were kicked by the DM.'
        );

        disconnectPlayer();

        break;

      case 'banned':
        setState(
          'banned',
          'You were banned by the DM.'
        );

        disconnectPlayer();

        break;

      case 'closed':
        clearTimeout(
          joinTimer
        );

        setState(
          'closed',
          'The DM closed the session.'
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
        renderRoster(
          message.roster
        );

        break;

      default:
        log(
          `unknown message type "${message.t}"`
        );
    }
  }

  function renderRoster(
    players = []
  ) {
    roster.textContent =
      'In session: ' +
      players
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
    name.disabled =
      false;

    join.disabled =
      false;
  }

  function disconnectPlayer() {
    wantJoin =
      false;

    clearTimeout(
      joinTimer
    );

    peer?.destroy();

    peer =
      null;

    unlockForm();

    setState(
      'idle',
      'Disconnected.'
    );
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

        name,

        join,

        disconnect
      ),

      status,

      roster,

      h(
        'div',
        {
          class:
            'muted',
        },
        'No PIN required.'
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

      clearTimeout(
        joinTimer
      );

      peer?.destroy();

      peer =
        null;

      activeLog =
        null;
    };
}

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

route();