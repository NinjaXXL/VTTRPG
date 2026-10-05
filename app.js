// VTTRPG Skeleton v0.10.0
//
// Networking intentionally follows 5.5e-companion/js/peer.js:
//
//   DM:
//     new Peer("vttrpg-" + roomId, config)
//
//   Player:
//     new Peer(undefined, config)
//
//   Player:
//     peer.connect("vttrpg-" + roomId, { reliable: true })
//
// No custom signaling server.
// No custom WebRTC negotiation.
// No custom SDP.
// No custom ICE handling.
//
// TURN is optional. Enter working TURN credentials on the DM.
// The credentials are copied into the join link for the player.

const APP_VERSION = '0.10.0';
const PEERJS_VERSION = '1.5.5';

const PEER_PREFIX = 'vttrpg-';

const LS_CAMPAIGNS = 'vttrpg:campaigns';
const LS_NAME = 'vttrpg:playerName';
const LS_TURN = 'vttrpg:turn';

const CONNECT_TIMEOUT_MS = 10000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const HEARTBEAT_MS = 30000;

const app = document.getElementById('app');
const version = document.getElementById('version');

version.textContent =
  `VTTRPG skeleton v${APP_VERSION} · PeerJS ${PEERJS_VERSION}`;

let cleanup = null;
let activeLog = null;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function rid(length = 12) {
  const chars =
    'abcdefghijklmnopqrstuvwxyz0123456789';

  const bytes =
    new Uint8Array(length);

  crypto.getRandomValues(bytes);

  return [...bytes]
    .map(x => chars[x % chars.length])
    .join('');
}

function short(id) {
  return String(id || '').slice(0, 8);
}

function h(tag, props = {}, ...children) {
  const el =
    document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) {
      el.addEventListener(
        key.slice(2),
        value
      );
    } else if (key === 'class') {
      el.className = value;
    } else {
      el.setAttribute(
        key,
        value
      );
    }
  }

  for (const child of children.flat()) {
    if (
      child === null ||
      child === undefined ||
      child === false
    ) {
      continue;
    }

    el.append(
      child instanceof Node
        ? child
        : String(child)
    );
  }

  return el;
}

function safe(value) {
  try {
    return typeof value === 'string'
      ? value
      : value?.message ||
          JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

function makeLog(role, onStatus) {
  const pre =
    h('pre', {
      class: 'log',
    });

  const log = text => {
    const line =
      `${new Date().toISOString().slice(11, 23)}  ${text}\n`;

    pre.textContent += line;
    pre.scrollTop = pre.scrollHeight;

    console.log(
      `[VTTRPG ${role}]`,
      text
    );
  };

  activeLog = log;

  log(
    `VTTRPG v${APP_VERSION} ${role} view started; page ${location.pathname}`
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

  const toolbar =
    h(
      'div',
      { class: 'row' },

      onStatus
        ? h(
            'button',
            {
              onclick: onStatus,
            },
            'Log status now'
          )
        : null,

      h(
        'button',
        {
          onclick: async () => {
            try {
              await navigator.clipboard.writeText(
                pre.textContent
              );

              log(
                'log copied'
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
          onclick: () => {
            pre.textContent = '';
          },
        },
        'Clear'
      )
    );

  return {
    el: h(
      'div',
      {},
      toolbar,
      pre
    ),
    log,
  };
}

// -----------------------------------------------------------------------------
// Base64 for TURN data in join URL
// -----------------------------------------------------------------------------

function encode(data) {
  const bytes =
    new TextEncoder().encode(
      JSON.stringify(data)
    );

  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decode(text) {
  const normalized =
    text
      .replace(/-/g, '+')
      .replace(/_/g, '/');

  const binary =
    atob(
      normalized +
      '='.repeat(
        (4 - normalized.length % 4) % 4
      )
    );

  const bytes =
    Uint8Array.from(
      binary,
      x => x.charCodeAt(0)
    );

  return JSON.parse(
    new TextDecoder().decode(bytes)
  );
}

function parseTurnFromQuery(query) {
  const params =
    new URLSearchParams(query);

  const value =
    params.get('turn');

  if (!value) {
    return null;
  }

  try {
    const turn =
      decode(value);

    if (
      !Array.isArray(turn.urls) ||
      !turn.urls.length ||
      !turn.username ||
      !turn.credential
    ) {
      return null;
    }

    return turn;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// TURN
// -----------------------------------------------------------------------------

function loadTurn() {
  try {
    return (
      JSON.parse(
        localStorage.getItem(
          LS_TURN
        )
      ) || {
        urls: '',
        username: '',
        credential: '',
      }
    );
  } catch {
    return {
      urls: '',
      username: '',
      credential: '',
    };
  }
}

function saveTurn(turn) {
  localStorage.setItem(
    LS_TURN,
    JSON.stringify(turn)
  );
}

function turnConfig(turn) {
  if (!turn) {
    return null;
  }

  const urls =
    Array.isArray(turn.urls)
      ? turn.urls
      : String(turn.urls || '')
          .split(',')
          .map(x => x.trim())
          .filter(Boolean);

  if (
    !urls.length ||
    !turn.username ||
    !turn.credential
  ) {
    return null;
  }

  return {
    urls,
    username:
      turn.username,
    credential:
      turn.credential,
  };
}

function peerConfig(turn) {
  const config = {};

  const validTurn =
    turnConfig(turn);

  if (validTurn) {
    config.config = {
      iceServers: [
        {
          urls:
            'stun:stun.l.google.com:19302',
        },

        validTurn,
      ],

      sdpSemantics:
        'unified-plan',
    };
  }

  return config;
}

// -----------------------------------------------------------------------------
// Peer layer
// -----------------------------------------------------------------------------

function createDMPeer(roomId, options) {
  const peerId =
    PEER_PREFIX + roomId;

  const connections =
    new Map();

  let peer = null;
  let destroyed = false;
  let staleTimer = null;

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
    peer =
      new window.Peer(
        peerId,
        peerConfig(options.turn)
      );

    options.log(
      `registering ${peerId} at PeerJS…`
    );

    peer.on(
      'open',
      id => {
        options.log(
          `PeerJS signaling connected as ${id}`
        );

        attachPeerEvents();
        resolve(id);
      }
    );

    peer.on(
      'connection',
      connection => {
        handleConnection(
          connection
        );
      }
    );

    peer.on(
      'disconnected',
      () => {
        if (destroyed) {
          return;
        }

        options.log(
          'DM signaling disconnected; reconnecting…'
        );

        options.onSignaling?.(
          'reconnecting'
        );

        setTimeout(
          () => {
            if (
              !destroyed &&
              peer &&
              !peer.destroyed
            ) {
              try {
                peer.reconnect();
              } catch (error) {
                options.log(
                  `reconnect failed: ${error.message}`
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
        if (destroyed) {
          return;
        }

        options.log(
          `PeerJS error (${error?.type || 'unknown'}): ${safe(error)}`
        );

        if (
          error?.type === 'unavailable-id' &&
          attempt < 3
        ) {
          const delay =
            2000 *
            (attempt + 1);

          options.log(
            `stable ID still held; retrying in ${delay}ms`
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
        } else if (
          !peer.open
        ) {
          reject(
            new Error(
              error?.type ||
              error?.message ||
              String(error)
            )
          );
        }
      }
    );
  }

  function attachPeerEvents() {
    peer.on(
      'open',
      () => {
        options.onSignaling?.(
          'connected'
        );
      }
    );
  }

  function handleConnection(connection) {
    const pid =
      connection.peer;

    options.log(
      `incoming connection from ${short(pid)}…`
    );

    connection.on(
      'open',
      () => {
        connections.set(
          pid,
          {
            connection,
            lastActivity:
              Date.now(),
          }
        );

        options.log(
          `data channel open from ${short(pid)}`
        );

        options.onPlayerConnect?.(
          pid
        );

        startStaleCheck();
      }
    );

    connection.on(
      'data',
      data => {
        const entry =
          connections.get(
            pid
          );

        if (entry) {
          entry.lastActivity =
            Date.now();
        }

        if (
          data?.type === 'ping'
        ) {
          try {
            connection.send({
              type:
                'pong',
              ts:
                data.ts,
            });
          } catch {}
        }

        options.onMessage?.(
          pid,
          data
        );
      }
    );

    connection.on(
      'close',
      () => {
        connections.delete(
          pid
        );

        options.log(
          `player ${short(pid)} disconnected`
        );

        options.onPlayerDisconnect?.(
          pid
        );
      }
    );

    connection.on(
      'error',
      error => {
        options.log(
          `connection error ${short(pid)}: ${safe(error)}`
        );
      }
    );
  }

  function startStaleCheck() {
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
              STALE_CONNECTION_TIMEOUT
            ) {
              try {
                entry.connection.close();
              } catch {}

              connections.delete(
                pid
              );

              options.onPlayerDisconnect?.(
                pid
              );
            }
          }

          if (
            connections.size === 0
          ) {
            clearInterval(
              staleTimer
            );

            staleTimer = null;
          }
        },
        STALE_CHECK_INTERVAL
      );
  }

  function send(
    data,
    target
  ) {
    if (target) {
      const entry =
        connections.get(
          target
        );

      if (
        entry?.connection?.open
      ) {
        entry.connection.send(
          data
        );
      }

      return;
    }

    for (
      const entry
      of connections.values()
    ) {
      if (
        entry.connection?.open
      ) {
        try {
          entry.connection.send(
            data
          );
        } catch {}
      }
    }
  }

  return {
    init,

    send,

    close(peerId) {
      const entry =
        connections.get(
          peerId
        );

      if (!entry) {
        return;
      }

      try {
        entry.connection.close();
      } catch {}

      connections.delete(
        peerId
      );
    },

    status() {
      options.log(
        `DM peer ${peerId}: ` +
        `signaling=${
          peer?.disconnected
            ? 'DISCONNECTED'
            : 'connected'
        }, ` +
        `players=${connections.size}`
      );
    },

    destroy() {
      destroyed = true;

      if (staleTimer) {
        clearInterval(
          staleTimer
        );

        staleTimer = null;
      }

      for (
        const entry
        of connections.values()
      ) {
        try {
          entry.connection.close();
        } catch {}
      }

      connections.clear();

      try {
        peer?.destroy();
      } catch {}

      peer = null;
    },
  };
}

function createPlayerPeer(
  roomId,
  turn,
  options
) {
  const hostId =
    PEER_PREFIX + roomId;

  let peer = null;
  let connection = null;

  let destroyed = false;
  let reconnectTimer = null;
  let attemptTimer = null;
  let reconnectAttempt = 0;
  let heartbeatTimer = null;

  function start() {
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

    peer =
      new window.Peer(
        undefined,
        peerConfig(turn)
      );

    options.log(
      'registering player at PeerJS…'
    );

    peer.on(
      'open',
      id => {
        options.log(
          `Player PeerJS signaling connected as ${id}`
        );

        reconnectAttempt = 0;
        connect();
      }
    );

    peer.on(
      'disconnected',
      () => {
        if (destroyed) {
          return;
        }

        options.log(
          'Player signaling disconnected'
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
              } catch {}
            }
          },
          1000
        );
      }
    );

    peer.on(
      'error',
      error => {
        options.log(
          `Player PeerJS error (${error?.type || 'unknown'}): ${safe(error)}`
        );

        scheduleReconnect();
      }
    );
  }

  function connect() {
    if (
      destroyed ||
      !peer ||
      peer.destroyed
    ) {
      return;
    }

    if (connection) {
      try {
        connection.close();
      } catch {}

      connection = null;
    }

    options.log(
      `connecting to DM ${hostId}…`
    );

    connection =
      peer.connect(
        hostId,
        {
          reliable: true,
        }
      );

    let opened = false;

    clearTimeout(
      attemptTimer
    );

    attemptTimer =
      setTimeout(
        () => {
          if (
            opened ||
            destroyed
          ) {
            return;
          }

          options.log(
            'connection to DM timed out'
          );

          try {
            connection.close();
          } catch {}

          scheduleReconnect();
        },
        CONNECT_TIMEOUT_MS
      );

    connection.on(
      'open',
      () => {
        opened = true;

        clearTimeout(
          attemptTimer
        );

        reconnectAttempt = 0;

        options.log(
          'data channel to DM OPEN'
        );

        startHeartbeat();

        options.onConnect?.();
      }
    );

    connection.on(
      'data',
      data => {
        if (
          data?.type === 'pong'
        ) {
          return;
        }

        options.onMessage?.(
          data
        );
      }
    );

    connection.on(
      'close',
      () => {
        clearTimeout(
          attemptTimer
        );

        stopHeartbeat();

        if (
          !destroyed
        ) {
          options.log(
            'data channel closed'
          );

          options.onDisconnect?.();

          scheduleReconnect();
        }
      }
    );

    connection.on(
      'error',
      error => {
        clearTimeout(
          attemptTimer
        );

        stopHeartbeat();

        if (
          !destroyed
        ) {
          options.log(
            `connection error: ${safe(error)}`
          );

          options.onDisconnect?.();

          scheduleReconnect();
        }
      }
    );

    connection.on(
      'iceStateChanged',
      state => {
        options.log(
          `ICE state: ${state}`
        );
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
          2 ** reconnectAttempt,
        RECONNECT_MAX_MS
      );

    reconnectAttempt++;

    options.log(
      `reconnect ${reconnectAttempt} in ${delay}ms`
    );

    options.onReconnecting?.(
      reconnectAttempt,
      delay
    );

    reconnectTimer =
      setTimeout(
        () => {
          reconnectTimer = null;

          if (
            destroyed
          ) {
            return;
          }

          if (
            peer?.destroyed ||
            !peer
          ) {
            createPeer();
          } else {
            connect();
          }
        },
        delay
      );
  }

  function startHeartbeat() {
    stopHeartbeat();

    heartbeatTimer =
      setInterval(
        () => {
          if (
            connection?.open
          ) {
            try {
              connection.send({
                type:
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

      heartbeatTimer = null;
    }
  }

  return {
    start,

    send(data) {
      if (
        connection?.open
      ) {
        try {
          connection.send(
            data
          );
        } catch {}
      }
    },

    isConnected() {
      return !!(
        connection &&
        connection.open
      );
    },

    reconnectNow() {
      if (
        destroyed ||
        connection?.open
      ) {
        return;
      }

      if (
        reconnectTimer
      ) {
        clearTimeout(
          reconnectTimer
        );

        reconnectTimer = null;
      }

      if (
        peer?.disconnected
      ) {
        try {
          peer.reconnect();
        } catch {}
      } else {
        connect();
      }
    },

    status() {
      options.log(
        `Player peer: ` +
        `signaling=${
          peer?.disconnected
            ? 'DISCONNECTED'
            : peer
              ? 'connected'
              : 'none'
        } ` +
        `data=${
          connection?.open
            ? 'open'
            : 'closed'
        }`
      );
    },

    destroy() {
      destroyed = true;

      clearTimeout(
        attemptTimer
      );

      if (
        reconnectTimer
      ) {
        clearTimeout(
          reconnectTimer
        );

        reconnectTimer = null;
      }

      stopHeartbeat();

      try {
        connection?.close();
      } catch {}

      try {
        peer?.destroy();
      } catch {}

      connection = null;
      peer = null;
    },
  };
}

// -----------------------------------------------------------------------------
// Campaign storage
// -----------------------------------------------------------------------------

function allCampaigns() {
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

function save(campaign) {
  const all =
    allCampaigns();

  all[campaign.id] =
    campaign;

  localStorage.setItem(
    LS_CAMPAIGNS,
    JSON.stringify(all)
  );
}

// -----------------------------------------------------------------------------
// Chat
// -----------------------------------------------------------------------------

function chatUi(send) {
  const box =
    h('div', {
      class:
        'chat',
    });

  const input =
    h('input', {
      placeholder:
        'Message…',
      maxlength:
        '500',
    });

  const button =
    h(
      'button',
      {
        onclick: submit,
      },
      'Send'
    );

  function submit() {
    const text =
      input.value.trim();

    if (!text) {
      return;
    }

    send(text);
    input.value = '';
  }

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

  return {
    el: h(
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

    add(message) {
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
                  `${message.from}: `
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

    enabled(value) {
      input.disabled =
        !value;

      button.disabled =
        !value;
    },
  };
}

// -----------------------------------------------------------------------------
// HOME
// -----------------------------------------------------------------------------

function viewHome() {
  const name =
    h('input', {
      placeholder:
        'New campaign name',
    });

  const list =
    h('div');

  function refresh() {
    const campaigns =
      Object.values(
        allCampaigns()
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
                    'button',
                    {
                      onclick:
                        () =>
                          location.hash =
                            '#/dm/' +
                            campaign.id,
                    },
                    'Open as DM'
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

  function create() {
    const value =
      name.value.trim();

    if (!value) {
      return;
    }

    const campaign = {
      id:
        rid(10),

      name:
        value,

      roomId:
        null,

      nextNum:
        1,

      players:
        {},

      chat:
        [],
    };

    save(
      campaign
    );

    location.hash =
      '#/dm/' +
      campaign.id;
  }

  app.append(
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

        name,

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
    )
  );

  refresh();
}

// -----------------------------------------------------------------------------
// DM
// -----------------------------------------------------------------------------

function viewDM(id) {
  const campaign =
    allCampaigns()[id];

  if (!campaign) {
    location.hash = '#/';
    return;
  }

  campaign.players ||=
    {};

  campaign.chat ||=
    [];

  campaign.nextNum ||=
    1;

  let dm = null;
  let session = null;

  const live =
    new Map();

  const {
    el: logEl,
    log,
  } =
    makeLog(
      'DM',
      () =>
        dm
          ? dm.status()
          : log(
              'no session'
            )
    );

  const mode =
    h(
      'select',
      {},

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
        'Open'
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

  const openButton =
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

  const status =
    h(
      'span',
      {
        class:
          'tag',
      },
      'closed'
    );

  const link =
    h('input', {
      readonly:
        '',
    });

  const qr =
    h('div', {
      id:
        'qr',
    });

  const lobby =
    h('div');

  const players =
    h('div');

  const turn =
    loadTurn();

  const turnUrls =
    h('input', {
      placeholder:
        'TURN URL, e.g. turn:yourserver:3478',
      value:
        turn.urls || '',
    });

  const turnUser =
    h('input', {
      placeholder:
        'TURN username',
      value:
        turn.username || '',
    });

  const turnPassword =
    h('input', {
      placeholder:
        'TURN credential/password',
      type:
        'password',
      value:
        turn.credential || '',
    });

  const turnStatus =
    h(
      'span',
      {
        class:
          'muted',
      }
    );

  const chat =
    chatUi(
      text =>
        sendChat(
          {
            from:
              'DM',
            text,
          }
        )
    );

  chat.enabled(false);

  campaign.chat
    .slice(-100)
    .forEach(
      chat.add
    );

  function saveTurnFields() {
    const value = {
      urls:
        turnUrls.value.trim(),

      username:
        turnUser.value.trim(),

      credential:
        turnPassword.value.trim(),
    };

    saveTurn(
      value
    );

    return turnConfig(
      value
    );
  }

  function testTurn() {
    const value =
      saveTurnFields();

    if (!value) {
      turnStatus.textContent =
        'TURN configuration incomplete.';
      return;
    }

    turnStatus.textContent =
      'TURN saved. It will be tested when WebRTC connects.';

    log(
      `TURN configured: ${value.urls.join(', ')}`
    );
  }

  function renderLobby() {
    const waiting =
      [
        ...live.entries(),
      ].filter(
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
    players.replaceChildren(
      ...(
        Object.entries(
          campaign.players
        ).length
          ? Object.entries(
              campaign.players
            ).map(
              ([
                token,
                player,
              ]) => {
                const online =
                  [
                    ...live.values(),
                  ].some(
                    item =>
                      item.token ===
                        token &&
                      item.status ===
                        'approved'
                  );

                return h(
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
                      : online
                        ? 'online'
                        : 'offline'
                  ),

                  !player.banned &&
                    h(
                      'button',
                      {
                        onclick:
                          () =>
                            kick(
                              token
                            ),
                      },
                      'Kick'
                    ),

                  player.banned
                    ? h(
                        'button',
                        {
                          onclick:
                            () => {
                              player.banned =
                                false;
                              save(
                                campaign
                              );
                              renderPlayers();
                            },
                        },
                        'Unban'
                      )
                    : h(
                        'button',
                        {
                          onclick:
                            () =>
                              ban(
                                token
                              ),
                        },
                        'Ban'
                      )
                );
              }
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

  function sendChat(
    message
  ) {
    campaign.chat.push(
      {
        id:
          rid(8),

        ts:
          Date.now(),

        ...message,
      }
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

    save(
      campaign
    );

    const latest =
      campaign.chat.at(-1);

    chat.add(
      latest
    );

    dm?.send(
      {
        t:
          'chat',

        msg:
          latest,
      }
    );
  }

  function approve(
    pid
  ) {
    const player =
      live.get(
        pid
      );

    if (!player) {
      return;
    }

    const saved =
      campaign.players[
        player.token
      ];

    if (saved) {
      player.status =
        'approved';

      player.num =
        saved.num;

      dm.send(
        {
          t:
            'accepted',

          num:
            saved.num,

          name:
            saved.name,

          campaignName:
            campaign.name,

          history:
            campaign.chat.slice(-50),
        },
        pid
      );

      renderLobby();
      renderPlayers();

      return;
    }

    const newPlayer = {
      token:
        player.token,

      num:
        campaign.nextNum++,

      name:
        player.name,

      banned:
        false,
    };

    campaign.players[
      player.token
    ] =
      newPlayer;

    player.status =
      'approved';

    player.num =
      newPlayer.num;

    save(
      campaign
    );

    dm.send(
      {
        t:
          'accepted',

        num:
          newPlayer.num,

        name:
          newPlayer.name,

        campaignName:
          campaign.name,

        history:
          campaign.chat.slice(-50),
      },
      pid
    );

    renderLobby();
    renderPlayers();
  }

  function deny(
    pid
  ) {
    dm.send(
      {
        t:
          'denied',

        reason:
          'The DM declined your request.',
      },
      pid
    );

    dm.close(
      pid
    );

    live.delete(
      pid
    );

    renderLobby();
  }

  function kick(
    token
  ) {
    const pid =
      [
        ...live.entries(),
      ].find(
        ([, player]) =>
          player.token ===
          token
      )?.[0];

    if (pid) {
      dm.send(
        {
          t:
            'kicked',
        },
        pid
      );

      dm.close(
        pid
      );

      live.delete(
        pid
      );
    }

    renderPlayers();
    renderLobby();
  }

  function ban(
    token
  ) {
    campaign.players[
      token
    ].banned =
      true;

    save(
      campaign
    );

    kick(
      token
    );
  }

  function onMessage(
    pid,
    message
  ) {
    if (
      !message
    ) {
      return;
    }

    if (
      message.t ===
      'join'
    ) {
      const token =
        String(
          message.token || ''
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

      const saved =
        campaign.players[
          token
        ];

      if (
        saved?.banned
      ) {
        dm.send(
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

      if (saved) {
        live.set(
          pid,
          {
            token,

            name:
              saved.name,

            num:
              saved.num,

            status:
              'approved',
          }
        );

        dm.send(
          {
            t:
              'accepted',

            num:
              saved.num,

            name:
              saved.name,

            campaignName:
              campaign.name,

            history:
              campaign.chat.slice(-50),
          },
          pid
        );

        renderLobby();
        renderPlayers();

        return;
      }

      live.set(
        pid,
        {
          token,

          name,

          num:
            null,

          status:
            'pending',
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

      if (
        session.mode ===
        'locked'
      ) {
        dm.send(
          {
            t:
              'denied',

            reason:
              'Session is locked.',
          },
          pid
        );

        dm.close(
          pid
        );

        live.delete(
          pid
        );

        return;
      }

      dm.send(
        {
          t:
            'pending',
        },
        pid
      );

      renderLobby();

      return;
    }

    const player =
      live.get(
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
          message.text || ''
        )
          .trim()
          .slice(
            0,
            500
          );

      if (text) {
        sendChat(
          {
            from:
              `${player.name} (P${player.num})`,

            text,
          }
        );
      }
    }
  }

  function openSession() {
    if (
      session
    ) {
      return;
    }

    const configuredTurn =
      saveTurnFields();

    if (
      !configuredTurn
    ) {
      log(
        'No TURN configured. ' +
        'Direct WebRTC will be tried. ' +
        'For iPhone ↔ Mac across different networks, ' +
        'a working TURN server is normally required.'
      );
    } else {
      log(
        `using TURN: ${configuredTurn.urls.join(', ')}`
      );
    }

    if (!campaign.roomId) {
      campaign.roomId =
        rid(14);

      save(
        campaign
      );
    }

    opening = true;

    log(
      `opening session: room=${campaign.roomId} mode=${mode.value}`
    );

    const transport =
      createDMPeer(
        campaign.roomId,
        {
          turn:
            configuredTurn,

          log,

          onPlayerConnect:
            pid =>
              log(
                `player transport connected ${short(pid)}`
              ),

          onPlayerDisconnect:
            pid => {
              live.delete(
                pid
              );

              renderLobby();
              renderPlayers();
            },

          onMessage,

          onSignaling:
            state => {
              signal.textContent =
                state === 'connected'
                  ? 'signaling OK'
                  : 'signaling reconnecting';
            },
        }
      );

    transport.init()
      .then(
        () => {
          dm =
            transport;

          session = {
            mode:
              mode.value,
          };

          opening =
            false;

          openButton.textContent =
            'Close session';

          mode.disabled =
            true;

          status.textContent =
            'signaling OK';

          chat.enabled(
            true
          );

          const params =
            new URLSearchParams();

          if (
            configuredTurn
          ) {
            params.set(
              'turn',
              encode(
                configuredTurn
              )
            );
          }

          const url =
            `${location.origin}` +
            `${location.pathname}` +
            `#/join/${campaign.roomId}` +
            (
              params.toString()
                ? '?' +
                  params.toString()
                : ''
            );

          link.value =
            url;

          qr.replaceChildren();

          if (
            window.QRCode
          ) {
            new window.QRCode(
              qr,
              {
                text:
                  url,

                width:
                  220,

                height:
                  220,
              }
            );
          }

          log(
            `SESSION OPEN – ${PEER_PREFIX}${campaign.roomId}`
          );
        }
      )
      .catch(
        error => {
          opening =
            false;

          log(
            `SESSION FAILED: ${error.message}`
          );

          transport.destroy();
        }
      );
  }

  function closeSession() {
    if (!session) {
      return;
    }

    dm?.destroy();

    dm =
      null;

    session =
      null;

    live.clear();

    mode.disabled =
      false;

    openButton.textContent =
      'Open session';

    status.textContent =
      'closed';

    link.value =
      '';

    qr.replaceChildren();

    chat.enabled(
      false
    );

    renderLobby();
    renderPlayers();

    log(
      'session closed'
    );
  }

  const savedTurn =
    loadTurn();

  const signal =
    h(
      'span',
      {
        class:
          'tag',
      },
      'no session'
    );

  $app?.append;

  app.append(
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
        `DM: ${campaign.name}`
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

        'Mode:',
        mode,
        openButton,
        signal
      ),

      h(
        'div',
        {
          class:
            'muted',
        },
        'No PIN.'
      ),

      h(
        'div',
        {
          class:
            'row',
        },

        link,

        h(
          'button',
          {
            onclick:
              async () => {
                try {
                  await navigator.clipboard.writeText(
                    link.value
                  );

                  log(
                    'join link copied'
                  );
                } catch {}
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
        'TURN'
      ),

      h(
        'div',
        {
          class:
            'turn-grid',
        },

        turnUrls,

        turnUser,

        turnPassword
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
          'Save TURN'
        ),

        turnStatus
      ),

      h(
        'div',
        {
          class:
            'muted',
        },
        'Use real TURN credentials. Do not use openrelayproject/openrelayproject as a production credential.'
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
      dm?.destroy();
      dm = null;
      activeLog = null;
    };
}

// -----------------------------------------------------------------------------
// PLAYER
// -----------------------------------------------------------------------------

function viewPlayer(
  roomId
) {
  const url =
    new URL(
      location.href
    );

  const turn =
    parseTurnFromQuery(
      url.hash.includes('?')
        ? url.hash.split('?')[1]
        : ''
    );

  let token =
    sessionStorage.getItem(
      SS_TOKEN
    );

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

  let wantJoin =
    false;

  let joinTimer =
    null;

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
              'not connected'
            )
    );

  const status =
    h(
      'div',
      {
        class:
          'status',
      },
      'Enter your name and join.'
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
          joinSession,
      },
      'Join'
    );

  const disconnect =
    h(
      'button',
      {
        onclick:
          disconnectPlayer,
      },
      'Disconnect'
    );

  const chat =
    chatUi(
      text => {
        if (
          state ===
            'accepted' &&
          peer
        ) {
          peer.send({
            t:
              'chat',

            text,
          });
        }
      }
    );

  chat.enabled(
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
        `state ${state} -> ${next}: ${text}`
      );
    }

    state =
      next;

    status.textContent =
      text;

    chat.enabled(
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

    peer.send({
      t:
        'join',

      token,

      name:
        name.value.trim() ||
        'Player',
    });

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
              'Connected, waiting for DM…'
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

    wantJoin =
      true;

    name.disabled =
      true;

    join.disabled =
      true;

    setState(
      'connecting',
      'Connecting to DM…'
    );

    if (
      peer?.isConnected()
    ) {
      sendJoin();
      return;
    }

    if (peer) {
      return;
    }

    log(
      turn
        ? 'TURN configuration received in link.'
        : 'No TURN configuration in link.'
    );

    peer =
      createPlayerPeer(
        roomId,
        turn,
        {
          log,

          onConnect:
            () => {
              if (
                wantJoin
              ) {
                setState(
                  'joining',
                  'Connected. Asking DM…'
                );

                sendJoin();
              }
            },

          onDisconnect:
            () => {
              if (
                wantJoin
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
              setState(
                'connecting',
                `Reconnect ${attempt} in ${Math.round(delay / 1000)}s…`
              );
            },

          onMessage:
            message => {
              handleMessage(
                message
              );
            },
        }
      );

    peer.start();
  }

  function handleMessage(
    message
  ) {
    if (!message) {
      return;
    }

    if (
      message.t ===
      'pending'
    ) {
      clearTimeout(
        joinTimer
      );

      setState(
        'pending',
        'Waiting for DM approval…'
      );

      return;
    }

    if (
      message.t ===
      'accepted'
    ) {
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

      setState(
        'accepted',
        `Joined "${message.campaignName}" as Player ${message.num} (${message.name})`
      );

      return;
    }

    if (
      message.t ===
      'chat'
    ) {
      if (
        message.msg
      ) {
        chat.add(
          message.msg
        );
      }

      return;
    }

    if (
      message.t ===
      'denied'
    ) {
      setState(
        'denied',
        message.reason ||
          'Denied.'
      );

      name.disabled =
        false;

      join.disabled =
        false;

      return;
    }

    if (
      message.t ===
      'kicked'
    ) {
      disconnectPlayer();

      setState(
        'kicked',
        'You were kicked by the DM.'
      );

      return;
    }

    if (
      message.t ===
      'banned'
    ) {
      disconnectPlayer();

      setState(
        'banned',
        'You were banned by the DM.'
      );

      return;
    }

    if (
      message.t ===
      'closed'
    ) {
      setState(
        'closed',
        'DM session closed.'
      );
    }
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

    name.disabled =
      false;

    join.disabled =
      false;

    setState(
      'idle',
      'Disconnected.'
    );
  }

  app.append(
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

      h(
        'div',
        {
          class:
            'muted',
        },
        turn
          ? 'TURN settings received from DM link.'
          : 'No TURN settings received.'
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
// TURN storage
// -----------------------------------------------------------------------------

function loadTurn() {
  try {
    return (
      JSON.parse(
        localStorage.getItem(
          LS_TURN
        )
      ) || {
        urls: '',
        username: '',
        credential: '',
      }
    );
  } catch {
    return {
      urls: '',
      username: '',
      credential: '',
    };
  }
}

function saveTurn(turn) {
  localStorage.setItem(
    LS_TURN,
    JSON.stringify(turn)
  );
}

// -----------------------------------------------------------------------------
// Route
// -----------------------------------------------------------------------------

function route() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }

  activeLog = null;

  app.replaceChildren();

  const [hash] =
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
          /^\/dm\/([a-z0-9]+)$/i
        )
    )
  ) {
    viewDM(
      match[1]
    );

    return;
  }

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

  viewHome();
}

window.addEventListener(
  'hashchange',
  route
);

route();