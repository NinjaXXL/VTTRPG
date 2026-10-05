// VTTRPG Skeleton v0.8.0
//
// Intentionally follows the simple PeerJS architecture used by
// volnuttz/5.5e-companion:
//
//   DM:
//     stable PeerJS id = "vttrpg-" + roomId
//
//   Player:
//     random PeerJS id
//
//   Signaling:
//     PeerJS public cloud
//
//   Data:
//     PeerJS/WebRTC data channels
//
// IMPORTANT:
// PEER_SERVER_CONFIG is deliberately empty.
// PeerJS 1.5.5 then uses its own default ICE configuration.
// Do not replace this with a custom STUN-only config unless you
// explicitly want to disable the PeerJS defaults.

const APP_VERSION = '0.8.0';
const PEERJS_VERSION = '1.5.5';

const PEER_PREFIX = 'vttrpg-';

const PEER_SERVER_CONFIG = {};

const STALE_CONNECTION_TIMEOUT = 60000;
const STALE_CHECK_INTERVAL = 15000;

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const CONNECT_TIMEOUT_MS = 10000;

const LS_CAMPAIGNS = 'vttrpg:campaigns';
const LS_NAME = 'vttrpg:playerName';
const SS_TOKEN = 'vttrpg:playerToken';

const $app = document.getElementById('app');

let cleanup = null;
let activeLog = null;

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

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
  ...children
) => {
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
};

function loadCampaigns() {
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
  const all =
    loadCampaigns();

  all[campaign.id] =
    campaign;

  localStorage.setItem(
    LS_CAMPAIGNS,
    JSON.stringify(all)
  );
}

function deleteCampaign(id) {
  const all =
    loadCampaigns();

  delete all[id];

  localStorage.setItem(
    LS_CAMPAIGNS,
    JSON.stringify(all)
  );
}

// -----------------------------------------------------------------------------
// Logging
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
      const line =
        `${new Date().toISOString().slice(11, 23)}  ${text}\n`;

      pre.textContent += line;
      pre.scrollTop =
        pre.scrollHeight;

      console.log(
        `[VTTRPG ${role}]`,
        text
      );
    };

  activeLog = log;

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

  log(
    `VTTRPG v${APP_VERSION} ${role} view started; page ${location.pathname}`
  );

  log(
    `env: online=${navigator.onLine} secureContext=${isSecureContext} RTCPeerConnection=${typeof RTCPeerConnection !== 'undefined'} PeerJS=${window.Peer ? 'loaded' : 'MISSING'}`
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

// -----------------------------------------------------------------------------
// PeerJS layer
// Based directly on the simple 5.5e-companion architecture.
// -----------------------------------------------------------------------------

function createDMPeer(roomId) {
  const peerId =
    PEER_PREFIX + roomId;

  const connections =
    new Map();

  let peer = null;

  let destroyed = false;
  let staleTimer = null;

  let onPlayerConnect = null;
  let onPlayerDisconnect = null;
  let onPlayerMessage = null;
  let onSignalingDisconnect = null;
  let onSignalingReconnect = null;

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

    console.log(
      '[Peer] registering DM:',
      peerId
    );

    // THIS IS THE IMPORTANT PART.
    // The DM gets the stable room ID.
    peer =
      new window.Peer(
        peerId,
        PEER_SERVER_CONFIG
      );

    peer.on(
      'open',
      id => {
        console.log(
          '[Peer] DM peer open:',
          id
        );

        attachPeerEvents();

        resolve(id);
      }
    );

    peer.on(
      'error',
      error => {
        console.error(
          '[Peer] DM error:',
          error
        );

        if (
          error.type ===
            'unavailable-id' &&
          attempt < 3
        ) {
          const delay =
            2000 *
            (attempt + 1);

          console.log(
            `[Peer] Peer ID in use, retrying in ${delay}ms`
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
            error.type ===
              'unavailable-id'
              ? 'Session ID is still held by another connection. Wait a moment and try again.'
              : `Connection error: ${error.type || error.message || error}`
          )
        );
      }
    );

    peer.on(
      'connection',
      handleIncomingConnection
    );
  }

  function attachPeerEvents() {
    peer.on(
      'disconnected',
      () => {
        if (destroyed) {
          return;
        }

        console.log(
          '[Peer] DM lost signaling connection'
        );

        onSignalingDisconnect?.();

        setTimeout(
          () => {
            if (
              !destroyed &&
              peer &&
              !peer.destroyed
            ) {
              try {
                peer.reconnect();
              } catch (
                error
              ) {
                console.error(
                  '[Peer] reconnect failed:',
                  error
                );
              }
            }
          },
          1000
        );
      }
    );

    peer.on(
      'open',
      () => {
        onSignalingReconnect?.();
      }
    );
  }

  function handleIncomingConnection(
    conn
  ) {
    console.log(
      '[Peer] incoming:',
      conn.peer
    );

    conn.on(
      'open',
      () => {
        connections.set(
          conn.peer,
          {
            conn,
            lastActivity:
              Date.now(),
          }
        );

        if (onPlayerConnect) {
          onPlayerConnect(
            conn.peer
          );
        }

        ensureStaleCheck();
      }
    );

    conn.on(
      'data',
      data => {
        const entry =
          connections.get(
            conn.peer
          );

        if (entry) {
          entry.lastActivity =
            Date.now();
        }

        if (
          data &&
          data.type === 'ping'
        ) {
          try {
            conn.send({
              type:
                'pong',

              ts:
                data.ts,
            });
          } catch {}
        }

        if (onPlayerMessage) {
          onPlayerMessage(
            conn.peer,
            data
          );
        }
      }
    );

    conn.on(
      'close',
      () => {
        const entry =
          connections.get(
            conn.peer
          );

        connections.delete(
          conn.peer
        );

        onPlayerDisconnect?.(
          conn.peer,
          entry
        );
      }
    );

    conn.on(
      'error',
      () => {
        const entry =
          connections.get(
            conn.peer
          );

        connections.delete(
          conn.peer
        );

        onPlayerDisconnect?.(
          conn.peer,
          entry
        );
      }
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

            staleTimer =
              null;

            return;
          }

          const time =
            Date.now();

          for (
            const [id, entry]
            of connections
          ) {
            if (
              time -
                entry.lastActivity >
              STALE_CONNECTION_TIMEOUT
            ) {
              console.log(
                '[Peer] stale connection:',
                id
              );

              connections.delete(
                id
              );

              try {
                entry.conn.close();
              } catch {}

              onPlayerDisconnect?.(
                id,
                entry
              );
            }
          }

          if (
            connections.size ===
            0
          ) {
            clearInterval(
              staleTimer
            );

            staleTimer =
              null;
          }
        },
        STALE_CHECK_INTERVAL
      );
  }

  function sendToPlayer(
    peerId,
    message
  ) {
    const entry =
      connections.get(
        peerId
      );

    if (
      !entry ||
      !entry.conn
    ) {
      return;
    }

    try {
      entry.conn.send(
        message
      );
    } catch (
      error
    ) {
      console.error(
        '[Peer] send failed:',
        error
      );
    }
  }

  function broadcast(
    message
  ) {
    for (
      const entry
      of connections.values()
    ) {
      try {
        entry.conn.send(
          message
        );
      } catch {}
    }
  }

  function isConnected() {
    return !!(
      peer &&
      !peer.disconnected &&
      !peer.destroyed
    );
  }

  function status() {
    console.log(
      '[Peer] DM status',
      {
        peerId,
        signaling:
          isConnected(),
        players:
          connections.size,
      }
    );
  }

  function destroy() {
    destroyed =
      true;

    if (staleTimer) {
      clearInterval(
        staleTimer
      );

      staleTimer =
        null;
    }

    if (peer) {
      try {
        peer.destroy();
      } catch {}

      peer =
        null;
    }

    connections.clear();
  }

  return {
    init,
    sendToPlayer,
    broadcast,
    isConnected,
    status,
    destroy,

    onPlayerConnect(cb) {
      onPlayerConnect =
        cb;
    },

    onPlayerDisconnect(cb) {
      onPlayerDisconnect =
        cb;
    },

    onPlayerMessage(cb) {
      onPlayerMessage =
        cb;
    },

    onSignalingDisconnect(cb) {
      onSignalingDisconnect =
        cb;
    },

    onSignalingReconnect(cb) {
      onSignalingReconnect =
        cb;
    },
  };
}

function createPlayerPeer(
  roomId
) {
  const hostPeerId =
    PEER_PREFIX + roomId;

  let peer = null;
  let conn = null;

  let destroyed = false;

  let reconnectAttempt = 0;
  let reconnectTimer = null;

  let heartbeatTimer = null;

  let onMessage = null;
  let onDisconnect = null;
  let onConnect = null;
  let onReconnecting = null;

  function connect() {
    return new Promise(
      (resolve, reject) => {
        destroyed =
          false;

        createPeer(
          resolve,
          reject
        );
      }
    );
  }

  function createPeer(
    resolve,
    reject
  ) {
    if (
      peer &&
      !peer.destroyed
    ) {
      openConnection(
        resolve,
        reject
      );

      return;
    }

    // EXACTLY the simple player approach:
    // let PeerJS generate the player ID.
    peer =
      new window.Peer(
        undefined,
        PEER_SERVER_CONFIG
      );

    peer.on(
      'open',
      () => {
        openConnection(
          resolve,
          reject
        );
      }
    );

    peer.on(
      'disconnected',
      () => {
        if (destroyed) {
          return;
        }

        console.log(
          '[Peer] Player lost signaling connection'
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
        console.error(
          '[Peer] Player peer error:',
          error
        );

        if (reject) {
          const fn =
            reject;

          reject =
            null;

          fn(error);
        } else {
          scheduleReconnect();
        }
      }
    );
  }

  function openConnection(
    resolve,
    reject
  ) {
    if (
      destroyed ||
      !peer ||
      peer.destroyed
    ) {
      return;
    }

    conn =
      peer.connect(
        hostPeerId,
        {
          reliable:
            true,
        }
      );

    let opened =
      false;

    const timeout =
      setTimeout(
        () => {
          if (opened) {
            return;
          }

          console.warn(
            '[Peer] connection to DM timed out'
          );

          try {
            conn.close();
          } catch {}

          if (reject) {
            const fn =
              reject;

            reject =
              null;

            fn(
              new Error(
                'Connection timed out'
              )
            );
          } else {
            scheduleReconnect();
          }
        },
        CONNECT_TIMEOUT_MS
      );

    conn.on(
      'open',
      () => {
        opened =
          true;

        clearTimeout(
          timeout
        );

        reconnectAttempt =
          0;

        console.log(
          '[Peer] connected to DM'
        );

        startHeartbeat();

        if (resolve) {
          const fn =
            resolve;

          resolve =
            null;

          fn();
        }

        onConnect?.();
      }
    );

    conn.on(
      'data',
      data => {
        onMessage?.(
          data
        );
      }
    );

    conn.on(
      'close',
      () => {
        clearTimeout(
          timeout
        );

        stopHeartbeat();

        console.log(
          '[Peer] disconnected from DM'
        );

        onDisconnect?.();

        scheduleReconnect();
      }
    );

    conn.on(
      'error',
      error => {
        clearTimeout(
          timeout
        );

        stopHeartbeat();

        console.error(
          '[Peer] connection error:',
          error
        );

        onDisconnect?.();

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
        RECONNECT_BASE_DELAY *
          Math.pow(
            2,
            reconnectAttempt
          ),
        RECONNECT_MAX_DELAY
      );

    reconnectAttempt++;

    console.log(
      `[Peer] reconnecting in ${delay}ms`
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

          if (!destroyed) {
            doReconnect();
          }
        },
        delay
      );
  }

  function doReconnect() {
    if (destroyed) {
      return;
    }

    console.log(
      '[Peer] attempting reconnect'
    );

    if (
      peer &&
      !peer.destroyed
    ) {
      openConnection(
        null,
        null
      );
    } else {
      createPeer(
        null,
        null
      );
    }
  }

  function reconnectNow() {
    if (
      destroyed ||
      isConnected()
    ) {
      return;
    }

    cancelReconnect();

    doReconnect();
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

  function startHeartbeat() {
    stopHeartbeat();

    heartbeatTimer =
      setInterval(
        () => {
          if (
            isConnected()
          ) {
            try {
              conn.send({
                type:
                  'ping',

                ts:
                  Date.now(),
              });
            } catch {}
          }
        },
        30000
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

  function sendToDM(
    message
  ) {
    if (
      conn &&
      conn.open
    ) {
      try {
        conn.send(
          message
        );
      } catch {}
    }
  }

  function isConnected() {
    return !!(
      conn &&
      conn.open
    );
  }

  function status() {
    console.log(
      '[Peer] Player status',
      {
        signaling:
          !!peer &&
          !peer.disconnected &&
          !peer.destroyed,

        connected:
          isConnected(),

        peerId:
          peer?.id ||
          null,
      }
    );
  }

  function destroy() {
    destroyed =
      true;

    cancelReconnect();
    stopHeartbeat();

    try {
      peer?.destroy();
    } catch {}

    peer =
      null;

    conn =
      null;
  }

  return {
    connect,
    sendToDM,
    isConnected,
    reconnectNow,
    cancelReconnect,
    status,
    destroy,

    onMessage(cb) {
      onMessage =
        cb;
    },

    onDisconnect(cb) {
      onDisconnect =
        cb;
    },

    onConnect(cb) {
      onConnect =
        cb;
    },

    onReconnecting(cb) {
      onReconnecting =
        cb;
    },
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

  function send() {
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
  }

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

function route() {
  cleanup?.();

  cleanup =
    null;

  activeLog =
    null;

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

// -----------------------------------------------------------------------------
// Home
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

  function renderList() {
    const campaigns =
      Object.values(
        loadCampaigns()
      );

    list.replaceChildren(
      ...(campaigns.length
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
          ])
    );
  }

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
      'Players join using the QR code or join link.'
    )
  );

  renderList();
}

// -----------------------------------------------------------------------------
// DM
// -----------------------------------------------------------------------------

function viewDM(
  campaignId
) {
  const campaign =
    loadCampaigns()[
      campaignId
    ];

  if (!campaign) {
    location.hash =
      '#/';

    return;
  }

  let dmPeer =
    null;

  let session =
    null;

  const connections =
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

  const modeSelect =
    h(
      'select',
      {
        onchange:
          () =>
            session &&
            (
              session.mode =
                modeSelect.value
            ),
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

  const sessionButton =
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

  const linkInput =
    h(
      'input',
      {
        readonly:
          '',

        placeholder:
          'Session link appears here',
      }
    );

  const qr =
    h(
      'div',
      {
        id:
          'qr',
      }
    );

  const lobby =
    h('div');

  const players =
    h('div');

  const chat =
    makeChat(
      text =>
        postChat(
          'DM',
          text
        )
    );

  chat.setEnabled(
    false
  );

  campaign.chat =
    Array.isArray(
      campaign.chat
    )
      ? campaign.chat
      : [];

  campaign.chat
    .slice(-100)
    .forEach(
      chat.add
    );

  log(
    `campaign "${campaign.name}" (${campaignId}) loaded from localStorage: ` +
    `${Object.keys(campaign.players || {}).length} known players, ` +
    `${campaign.chat.length} chat messages`
  );

  function approvedPeerIds() {
    return [
      ...connections.entries(),
    ]
      .filter(
        ([, player]) =>
          player.status ===
          'approved'
      )
      .map(
        ([peerId]) =>
          peerId
      );
  }

  function broadcast(
    message
  ) {
    dmPeer?.broadcast(
      message
    );
  }

  function postChat(
    from,
    text
  ) {
    const message = {
      id:
        rid(8),

      ts:
        Date.now(),

      from,

      text:
        String(text || '')
          .slice(0, 500),
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

    saveCampaign(
      campaign
    );

    chat.add(
      message
    );

    broadcast({
      type:
        'chat',

      msg:
        message,
    });
  }

  function systemMessage(
    text
  ) {
    const message = {
      id:
        rid(8),

      ts:
        Date.now(),

      sys:
        true,

      text,
    };

    campaign.chat.push(
      message
    );

    saveCampaign(
      campaign
    );

    chat.add(
      message
    );

    broadcast({
      type:
        'chat',

      msg:
        message,
    });
  }

  function renderPlayers() {
    const entries =
      Object.entries(
        campaign.players || {}
      );

    players.replaceChildren(
      ...(entries.length
        ? entries.map(
            ([
              token,
              player,
            ]) => {
              const live =
                [
                  ...connections.values(),
                ].some(
                  connection =>
                    connection.token ===
                      token &&
                    connection.status ===
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
                    : live
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

                            saveCampaign(
                              campaign
                            );

                            renderPlayers();
                          },
                      },
                      'Unban'
                    )
                  : [
                      live
                        ? h(
                            'button',
                            {
                              onclick:
                                () =>
                                  kickPlayer(
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
                              kickPlayer(
                                token,
                                true
                              ),
                        },
                        'Ban'
                      ),
                    ]
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
          ])
    );
  }

  function renderLobby() {
    const pending =
      [
        ...connections.entries(),
      ]
        .filter(
          ([, player]) =>
            player.status ===
            'pending'
        );

    lobby.replaceChildren(
      ...(pending.length
        ? pending.map(
            ([
              peerId,
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
                          peerId
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
                          peerId
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
  }

  function roster() {
    return Object.values(
      campaign.players || {}
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
              ...connections.values(),
            ].some(
              connection =>
                connection.status ===
                  'approved' &&
                connection.token ===
                  player.token
            ),
        })
      );
  }

  function sendAccepted(
    peerId,
    player
  ) {
    dmPeer?.sendToPlayer(
      peerId,
      {
        type:
          'accepted',

        num:
          player.num,

        name:
          player.name,

        campaignName:
          campaign.name,

        history:
          campaign.chat.slice(
            -100
          ),

        roster:
          roster(),
      }
    );
  }

  function approve(
    peerId
  ) {
    const connection =
      connections.get(
        peerId
      );

    if (!connection) {
      return;
    }

    if (
      connection.status ===
      'approved'
    ) {
      return;
    }

    const token =
      connection.token;

    if (
      campaign.players[
        token
      ]
    ) {
      connection.status =
        'approved';

      connection.num =
        campaign.players[
          token
        ].num;

      sendAccepted(
        peerId,
        campaign.players[
          token
        ]
      );

      renderLobby();
      renderPlayers();

      return;
    }

    const num =
      campaign.nextNum++;

    const player = {
      token,

      num,

      name:
        connection.name,

      banned:
        false,
    };

    campaign.players[
      token
    ] =
      player;

    connection.status =
      'approved';

    connection.num =
      num;

    saveCampaign(
      campaign
    );

    sendAccepted(
      peerId,
      player
    );

    systemMessage(
      `${player.name} joined as Player ${num}`
    );

    renderLobby();
    renderPlayers();
  }

  function deny(
    peerId
  ) {
    dmPeer?.sendToPlayer(
      peerId,
      {
        type:
          'denied',

        reason:
          'The DM declined your request.',
      }
    );

    connections.delete(
      peerId
    );

    setTimeout(
      () =>
        dmPeer?.close?.(
          peerId
        ),
      100
    );

    renderLobby();
  }

  function kickPlayer(
    token,
    ban
  ) {
    let peerId =
      null;

    for (
      const [
        id,
        player,
      ] of connections
    ) {
      if (
        player.token ===
        token
      ) {
        peerId =
          id;

        break;
      }
    }

    if (peerId) {
      dmPeer?.sendToPlayer(
        peerId,
        {
          type:
            ban
              ? 'banned'
              : 'kicked',
        }
      );

      connections.delete(
        peerId
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

      if (ban) {
        campaign.players[
          token
        ].approved =
          false;
      }

      saveCampaign(
        campaign
      );
    }

    renderPlayers();
    renderLobby();
  }

  function openSession() {
    if (session) {
      return;
    }

    if (!campaign.roomId) {
      campaign.roomId =
        rid(14);

      saveCampaign(
        campaign
      );

      log(
        `created stable room id ${campaign.roomId}`
      );
    }

    sessionButton.disabled =
      true;

    log(
      `opening session: mode=${modeSelect.value}, room=${campaign.roomId}`
    );

    const transport =
      createDMPeer(
        campaign.roomId
      );

    transport.onPlayerConnect(
      peerId => {
        log(
          `incoming connection from ${short(peerId)}`
        );
      }
    );

    transport.onPlayerDisconnect(
      peerId => {
        const player =
          connections.get(
            peerId
          );

        if (player) {
          log(
            `${player.name} disconnected`
          );
        }

        connections.delete(
          peerId
        );

        renderLobby();
        renderPlayers();
      }
    );

    transport.onPlayerMessage(
      (
        peerId,
        data
      ) => {
        if (!data) {
          return;
        }

        if (
          data.type ===
          'join'
        ) {
          handleJoin(
            peerId,
            data
          );

          return;
        }

        const player =
          connections.get(
            peerId
          );

        if (
          !player ||
          player.status !==
            'approved'
        ) {
          return;
        }

        if (
          data.type ===
          'chat'
        ) {
          const text =
            String(
              data.text || ''
            )
              .trim()
              .slice(0, 500);

          if (text) {
            postChat(
              `${player.name} (P${player.num})`,
              text
            );
          }
        }
      }
    );

    transport.onSignalingDisconnect(
      () => {
        status.textContent =
          'signaling lost';

        log(
          'PeerJS signaling disconnected'
        );
      }
    );

    transport.onSignalingReconnect(
      () => {
        status.textContent =
          'signaling OK';

        log(
          'PeerJS signaling reconnected'
        );
      }
    );

    transport.init()
      .then(
        () => {
          dmPeer =
            transport;

          session = {
            mode:
              modeSelect.value,
          };

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
          }

          status.textContent =
            'signaling OK';

          sessionButton.disabled =
            false;

          sessionButton.textContent =
            'Close session';

          modeSelect.disabled =
            true;

          chat.setEnabled(
            true
          );

          log(
            `SESSION OPEN – DM peer id is ${PEER_PREFIX}${campaign.roomId}`
          );

          renderLobby();
          renderPlayers();
        }
      )
      .catch(
        error => {
          log(
            `COULD NOT OPEN SESSION: ${error.message}`
          );

          transport.destroy();

          sessionButton.disabled =
            false;
        }
      );
  }

  function handleJoin(
    peerId,
    data
  ) {
    const token =
      String(
        data.token || ''
      )
        .slice(0, 64);

    const name =
      String(
        data.name || 'Player'
      )
        .trim()
        .slice(0, 30);

    if (!token) {
      return;
    }

    const saved =
      campaign.players[
        token
      ];

    if (
      saved?.banned
    ) {
      dmPeer?.sendToPlayer(
        peerId,
        {
          type:
            'denied',

          reason:
            'You are banned.',
        }
      );

      return;
    }

    connections.set(
      peerId,
      {
        token,

        name:
          name || 'Player',

        status:
          saved
            ? 'approved'
            : 'pending',

        num:
          saved
            ? saved.num
            : null,
      }
    );

    if (saved) {
      sendAccepted(
        peerId,
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
      dmPeer?.sendToPlayer(
        peerId,
        {
          type:
            'denied',

          reason:
            'Session is locked.',
        }
      );

      connections.delete(
        peerId
      );

      return;
    }

    if (
      session.mode ===
      'open'
    ) {
      approve(
        peerId
      );

      return;
    }

    dmPeer?.sendToPlayer(
      peerId,
      {
        type:
          'pending',
      }
    );

    renderLobby();
  }

  function closeSession() {
    if (!session) {
      return;
    }

    connections.clear();

    dmPeer?.broadcast({
      type:
        'closed',
    });

    const oldPeer =
      dmPeer;

    dmPeer =
      null;

    session =
      null;

    modeSelect.disabled =
      false;

    sessionButton.textContent =
      'Open session';

    status.textContent =
      'closed';

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

        'Join mode:',

        modeSelect,

        sessionButton,

        status
      ),

      h(
        'div',
        {
          class:
            'muted',
        },
        'No PIN is used. Anyone with the session link can request access. '
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

      connections.clear();

      activeLog =
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

  if (!token) {
    token =
      rid(24);

    sessionStorage.setItem(
      SS_TOKEN,
      token
    );
  }

  let playerPeer =
    null;

  let state =
    'idle';

  let joinTimer =
    null;

  let wantJoin =
    false;

  const {
    el: logEl,
    log,
  } =
    makeLog(
      'Player',
      () =>
        playerPeer
          ? playerPeer.status()
          : log(
              'no player peer'
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

  const info =
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
          join,
      },
      'Join'
    );

  const disconnectButton =
    h(
      'button',
      {
        onclick:
          disconnect,
      },
      'Disconnect'
    );

  const chat =
    makeChat(
      text => {
        if (
          state ===
            'accepted' &&
          playerPeer
        ) {
          playerPeer.sendToDM({
            type:
              'chat',

            text,
          });
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

    wantJoin =
      true;

    nameInput.disabled =
      true;

    joinButton.disabled =
      true;

    if (
      playerPeer?.isConnected()
    ) {
      sendJoin(
        name
      );

      return;
    }

    setState(
      'connecting',
      'Connecting to DM…'
    );

    playerPeer =
      createPlayerPeer(
        roomId
      );

    playerPeer.onConnect(
      () => {
        if (
          wantJoin
        ) {
          sendJoin(
            name
          );
        }
      }
    );

    playerPeer.onDisconnect(
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
      }
    );

    playerPeer.onReconnecting(
      (
        attempt,
        delay
      ) => {
        if (
          state ===
            'connecting'
        ) {
          setState(
            'connecting',
            `Retry ${attempt} in ${Math.round(delay / 1000)}s…`
          );
        }
      }
    );

    playerPeer.onMessage(
      data => {
        handlePlayerMessage(
          data
        );
      }
    );

    playerPeer.connect()
      .catch(
        error => {
          log(
            `initial connection failed: ${error.message}`
          );

          setState(
            'connecting',
            'Could not connect yet. Retrying…'
          );
        }
      );
  }

  function sendJoin(
    name
  ) {
    if (
      !playerPeer ||
      !playerPeer.isConnected()
    ) {
      return;
    }

    playerPeer.sendToDM({
      type:
        'join',

      token,

      name,
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
              'Connected. Waiting for DM response…'
            );
          }
        },
        8000
      );

    setState(
      'joining',
      'Request sent to DM…'
    );
  }

  function handlePlayerMessage(
    data
  ) {
    if (!data) {
      return;
    }

    if (
      data.type ===
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
      data.type ===
      'accepted'
    ) {
      clearTimeout(
        joinTimer
      );

      chat.clear();

      (
        data.history ||
        []
      )
        .forEach(
          chat.add
        );

      info.textContent =
        `Player ${data.num}`;

      setState(
        'accepted',
        `Joined "${data.campaignName}" as Player ${data.num} (${data.name})`
      );

      return;
    }

    if (
      data.type ===
      'denied'
    ) {
      setState(
        'denied',
        `Not admitted: ${data.reason || 'denied'}`
      );

      return;
    }

    if (
      data.type ===
      'kicked'
    ) {
      setState(
        'kicked',
        'You were kicked by the DM.'
      );

      disconnect();

      return;
    }

    if (
      data.type ===
      'banned'
    ) {
      setState(
        'banned',
        'You were banned by the DM.'
      );

      disconnect();

      return;
    }

    if (
      data.type ===
      'closed'
    ) {
      setState(
        'closed',
        'DM session closed.'
      );

      return;
    }

    if (
      data.type ===
      'chat'
    ) {
      if (
        data.msg
      ) {
        chat.add(
          data.msg
        );
      }

      return;
    }

    if (
      data.type ===
      'pong'
    ) {
      return;
    }
  }

  function disconnect() {
    wantJoin =
      false;

    clearTimeout(
      joinTimer
    );

    playerPeer?.destroy();

    playerPeer =
      null;

    nameInput.disabled =
      false;

    joinButton.disabled =
      false;

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
        playerPeer &&
        wantJoin
      ) {
        playerPeer.reconnectNow();
      }
    };

  const onOnline =
    () => {
      if (
        playerPeer &&
        wantJoin
      ) {
        playerPeer.reconnectNow();
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
        `Room: ${roomId}`
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

      status,

      info,

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

      playerPeer?.destroy();

      playerPeer =
        null;

      activeLog =
        null;
    };
}

// -----------------------------------------------------------------------------
// Version / startup
// -----------------------------------------------------------------------------

const version =
  document.getElementById(
    'version'
  );

if (version) {
  version.textContent =
    `VTTRPG skeleton v${APP_VERSION} · PeerJS ${PEERJS_VERSION}`;
}

window.addEventListener(
  'beforeunload',
  () => {
    try {
      cleanup?.();
    } catch {}
  }
);

route();