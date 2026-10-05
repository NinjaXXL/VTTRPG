const VERSION = '0.11.0';
const PREFIX = 'vttrpg-';

const CONNECT_TIMEOUT = 10000;
const RECONNECT_START = 1000;
const RECONNECT_MAX = 30000;

const NAME_KEY = 'vttrpg:name';
const DM_NAME_KEY = 'vttrpg:dmName';

const app = document.getElementById('app');

let cleanup = null;
let activeLog = null;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function id(length = 12) {
  const chars =
    'abcdefghijklmnopqrstuvwxyz0123456789';

  const bytes =
    new Uint8Array(length);

  crypto.getRandomValues(bytes);

  return [...bytes]
    .map(
      x => chars[x % chars.length]
    )
    .join('');
}

function h(tag, props = {}, ...children) {
  const el =
    document.createElement(tag);

  for (
    const [key, value]
    of Object.entries(props)
  ) {
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

function logSafe(value) {
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
}

function makeLog() {
  const box =
    h(
      'pre',
      {
        class: 'log',
      }
    );

  const log =
    text => {
      box.textContent +=
        `${new Date().toLocaleTimeString()}  ${text}\n`;

      box.scrollTop =
        box.scrollHeight;

      console.log(
        '[VTTRPG]',
        text
      );
    };

  activeLog =
    log;

  return {
    log,
    el: box,
  };
}

// -----------------------------------------------------------------------------
// TURN data in join link
// -----------------------------------------------------------------------------

function encodeTurn(data) {
  const bytes =
    new TextEncoder().encode(
      JSON.stringify(data)
    );

  let binary = '';

  for (const byte of bytes) {
    binary +=
      String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeTurn(value) {
  const normalized =
    value
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
      char => char.charCodeAt(0)
    );

  return JSON.parse(
    new TextDecoder().decode(bytes)
  );
}

function getTurnFromHash() {
  const query =
    location.hash.split('?')[1] || '';

  const params =
    new URLSearchParams(query);

  const value =
    params.get('t');

  if (!value) {
    return null;
  }

  try {
    return decodeTurn(value);
  } catch {
    return null;
  }
}

function getTurnConfig(
  urls,
  username,
  credential
) {
  const list =
    urls
      .split(',')
      .map(x => x.trim())
      .filter(Boolean);

  if (
    !list.length ||
    !username ||
    !credential
  ) {
    return null;
  }

  return {
    urls: list,
    username,
    credential,
  };
}

function peerOptions(turn) {
  if (!turn) {
    return {};
  }

  return {
    config: {
      iceServers: [
        {
          urls:
            'stun:stun.l.google.com:19302',
        },
        turn,
      ],

      sdpSemantics:
        'unified-plan',
    },
  };
}

// -----------------------------------------------------------------------------
// DM Peer
// Same basic structure as 5.5e-companion/js/peer.js
// -----------------------------------------------------------------------------

function createDMPeer(
  room,
  turn,
  log,
  onPlayer,
  onMessage,
  onClose
) {
  const peerId =
    PREFIX + room;

  const peer =
    new Peer(
      peerId,
      peerOptions(turn)
    );

  const connections =
    new Map();

  peer.on(
    'open',
    id => {
      log(
        `DM PeerJS open: ${id}`
      );
    }
  );

  peer.on(
    'error',
    error => {
      log(
        `DM PeerJS error: ${
          error?.type ||
          error?.message ||
          error
        }`
      );
    }
  );

  peer.on(
    'disconnected',
    () => {
      log(
        'DM signaling disconnected; reconnecting…'
      );

      setTimeout(
        () => {
          try {
            if (
              !peer.destroyed
            ) {
              peer.reconnect();
            }
          } catch {}
        },
        1000
      );
    }
  );

  peer.on(
    'connection',
    connection => {
      log(
        `incoming player: ${connection.peer}`
      );

      connection.on(
        'open',
        () => {
          connections.set(
            connection.peer,
            connection
          );

          log(
            `PLAYER CONNECTED: ${connection.peer}`
          );

          onPlayer(
            connection
          );
        }
      );

      connection.on(
        'data',
        data => {
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

          onMessage(
            connection,
            data
          );
        }
      );

      connection.on(
        'close',
        () => {
          connections.delete(
            connection.peer
          );

          log(
            `player disconnected: ${connection.peer}`
          );

          onClose(
            connection.peer
          );
        }
      );

      connection.on(
        'error',
        error => {
          log(
            `player error: ${
              error?.type ||
              error?.message ||
              error
            }`
          );
        }
      );
    }
  );

  return {
    send(
      connection,
      data
    ) {
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

    sendAll(data) {
      for (
        const connection
        of connections.values()
      ) {
        if (
          connection.open
        ) {
          try {
            connection.send(
              data
            );
          } catch {}
        }
      }
    },

    destroy() {
      for (
        const connection
        of connections.values()
      ) {
        try {
          connection.close();
        } catch {}
      }

      connections.clear();

      try {
        peer.destroy();
      } catch {}
    },
  };
}

// -----------------------------------------------------------------------------
// Player Peer
// Same basic structure as 5.5e-companion/js/peer.js
// -----------------------------------------------------------------------------

function createPlayerPeer(
  room,
  turn,
  log,
  onOpen,
  onMessage,
  onClose
) {
  const hostId =
    PREFIX + room;

  const peer =
    new Peer(
      undefined,
      peerOptions(turn)
    );

  let connection =
    null;

  let reconnectTimer =
    null;

  let attempt =
    0;

  function connect() {
    if (
      peer.destroyed
    ) {
      return;
    }

    attempt++;

    log(
      `connecting to ${hostId} ` +
      `(attempt ${attempt})…`
    );

    connection =
      peer.connect(
        hostId,
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

          log(
            'connection to DM timed out'
          );

          try {
            connection.close();
          } catch {}

          reconnect();
        },
        CONNECT_TIMEOUT
      );

    connection.on(
      'open',
      () => {
        opened =
          true;

        clearTimeout(
          timeout
        );

        attempt =
          0;

        log(
          'PLAYER CONNECTED'
        );

        onOpen(
          connection
        );
      }
    );

    connection.on(
      'data',
      data => {
        onMessage(
          connection,
          data
        );
      }
    );

    connection.on(
      'close',
      () => {
        clearTimeout(
          timeout
        );

        log(
          'connection to DM closed'
        );

        onClose();

        reconnect();
      }
    );

    connection.on(
      'error',
      error => {
        clearTimeout(
          timeout
        );

        log(
          `player connection error: ${
            error?.type ||
            error?.message ||
            error
          }`
        );

        onClose();

        reconnect();
      }
    );
  }

  function reconnect() {
    if (
      reconnectTimer ||
      peer.destroyed
    ) {
      return;
    }

    const delay =
      Math.min(
        RECONNECT_MAX,
        RECONNECT_START *
          2 ** Math.min(
            attempt,
            5
          )
      );

    log(
      `reconnecting in ${Math.round(delay / 1000)}s…`
    );

    reconnectTimer =
      setTimeout(
        () => {
          reconnectTimer =
            null;

          connect();
        },
        delay
      );
  }

  peer.on(
    'open',
    peerId => {
      log(
        `Player PeerJS open: ${peerId}`
      );

      connect();
    }
  );

  peer.on(
    'error',
    error => {
      log(
        `Player PeerJS error: ${
          error?.type ||
          error?.message ||
          error
        }`
      );
    }
  );

  peer.on(
    'disconnected',
    () => {
      log(
        'Player signaling disconnected'
      );

      setTimeout(
        () => {
          try {
            if (
              !peer.destroyed &&
              peer.disconnected
            ) {
              peer.reconnect();
            }
          } catch {}
        },
        1000
      );
    }
  );

  return {
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

    destroy() {
      if (
        reconnectTimer
      ) {
        clearTimeout(
          reconnectTimer
        );

        reconnectTimer =
          null;
      }

      try {
        connection?.close();
      } catch {}

      try {
        peer.destroy();
      } catch {}
    },
  };
}

// -----------------------------------------------------------------------------
// Chat
// -----------------------------------------------------------------------------

function makeChat(
  send
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
      }
    );

  const button =
    h(
      'button',
      {
        onclick:
          submit,
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
        submit();
      }
    }
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
              'msg',
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

          h(
            'b',
            {},
            `${message.from}: `
          ),

          message.text
        )
      );

      box.scrollTop =
        box.scrollHeight;
    },

    enable(value) {
      input.disabled =
        !value;

      button.disabled =
        !value;
    },
  };
}

// -----------------------------------------------------------------------------
// Home
// -----------------------------------------------------------------------------

function home() {
  const {
    el: logEl,
    log,
  } = makeLog();

  const name =
    h(
      'input',
      {
        placeholder:
          'DM name',
        value:
          'VTTRPG DM',
      }
    );

  const turnUrls =
    h(
      'input',
      {
        placeholder:
          'TURN URL, e.g. turn:your-server:3478',
      }
    );

  const turnUser =
    h(
      'input',
      {
        placeholder:
          'TURN username',
      }
    );

  const turnCredential =
    h(
      'input',
      {
        type:
          'password',

        placeholder:
          'TURN credential',
      }
    );

  const start =
    () => {
      const turn =
        getTurnConfig(
          turnUrls.value.trim(),
          turnUser.value.trim(),
          turnCredential.value.trim()
        );

      try {
        localStorage.setItem(
          DM_NAME_KEY,
          name.value.trim() ||
            'VTTRPG DM'
        );
      } catch {}

      const room =
        id(14);

      const query =
        turn
          ? `?t=${encodeTurn(turn)}`
          : '';

      location.hash =
        `#/dm/${room}${query}`;
    };

  app.append(
    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Start DM'
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
              start,
          },
          'Start session'
        )
      ),

      h(
        'div',
        {
          class:
            'muted',
        },
        'The session generates one permanent room link and a QR code.'
      )
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'TURN'
      ),

      turnUrls,
      turnUser,
      turnCredential,

      h(
        'div',
        {
          class:
            'muted',
        },
        'For your iPhone ↔ Mac test, enter real TURN credentials here. Without TURN, WebRTC only works when the networks can establish a direct path.'
      )
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Log'
      ),

      logEl
    )
  );

  log(
    `VTTRPG v${VERSION} ready`
  );
}

// -----------------------------------------------------------------------------
// DM view
// -----------------------------------------------------------------------------

function dmView(
  room,
  turn
) {
  if (cleanup) {
    cleanup();
  }

  app.replaceChildren();

  let dmName =
    'VTTRPG DM';

  try {
    dmName =
      localStorage.getItem(
        DM_NAME_KEY
      ) ||
      dmName;
  } catch {}

  const {
    el: logEl,
    log,
  } = makeLog();

  const status =
    h(
      'span',
      {
        class:
          'status',
      },
      'starting…'
    );

  const link =
    h(
      'input',
      {
        readonly:
          '',
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

  const playerStatus =
    h(
      'div',
      {
        class:
          'muted',
      },
      'No player connected.'
    );

  let connectedPlayer =
    null;

  const chat =
    makeChat(
      text => {
        const message = {
          from:
            'DM',

          text,

          ts:
            Date.now(),
        };

        chat.add(
          message
        );

        if (
          connectedPlayer
        ) {
          transport.send(
            connectedPlayer,
            {
              type:
                'chat',

              msg:
                message,
            }
          );
        }
      }
    );

  chat.enable(
    false
  );

  const url =
    `${location.origin}` +
    `${location.pathname}` +
    `#/join/${room}` +
    (
      turn
        ? `?t=${encodeTurn(turn)}`
        : ''
    );

  link.value =
    url;

  const transport =
    createDMPeer(
      room,
      turn,
      log,

      connection => {
        connectedPlayer =
          connection;

        status.textContent =
          'Player connected';

        playerStatus.textContent =
          `Connected: ${connection.peer}`;

        chat.enable(
          true
        );
      },

      (connection, data) => {
        if (
          data?.type ===
          'chat'
        ) {
          chat.add(
            data.msg
          );
        }
      },

      () => {
        connectedPlayer =
          null;

        status.textContent =
          'Player disconnected';

        playerStatus.textContent =
          'No player connected.';

        chat.enable(
          false
        );
      }
    );

  if (
    window.QRCode
  ) {
    new QRCode(
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

  app.append(
    h(
      'section',
      {},

      h(
        'h2',
        {},
        dmName
      ),

      status,

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
                    url
                  );

                  log(
                    'link copied'
                  );
                } catch {}
              },
          },
          'Copy link'
        )
      ),

      qr,

      playerStatus
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
        'Log'
      ),

      logEl
    )
  );

  cleanup =
    () => {
      transport.destroy();
      connectedPlayer =
        null;
    };

  log(
    `DM room: ${room}`
  );

  log(
    `DM peer ID: ${PREFIX}${room}`
  );

  log(
    turn
      ? `TURN configured: ${turn.urls.join(', ')}`
      : 'No TURN configured'
  );
}

// -----------------------------------------------------------------------------
// Player view
// -----------------------------------------------------------------------------

function playerView(
  room
) {
  if (cleanup) {
    cleanup();
  }

  app.replaceChildren();

  const {
    el: logEl,
    log,
  } = makeLog();

  const turn =
    getTurnFromHash();

  const status =
    h(
      'span',
      {
        class:
          'status',
      },
      'connecting…'
    );

  let peer;

  const chat =
    makeChat(
      text => {
        peer.send({
          type:
            'chat',

          msg: {
            from:
              'Player',

            text,

            ts:
              Date.now(),
          },
        });
      }
    );

  chat.enable(
    false
  );

  peer =
    createPlayerPeer(
      room,
      turn,
      log,

      connection => {
        status.textContent =
          'Connected';

        chat.enable(
          true
        );

        log(
          `data channel open to DM`
        );
      },

      (connection, data) => {
        if (
          data?.type ===
          'chat'
        ) {
          chat.add(
            data.msg
          );
        }
      },

      () => {
        status.textContent =
          'Disconnected – reconnecting…';

        chat.enable(
          false
        );
      }
    );

  app.append(
    h(
      'section',
      {},

      h(
        'h2',
        {},
        'VTTRPG Player'
      ),

      status,

      h(
        'div',
        {
          class:
            'muted',
        },
        `Room: ${room}`
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
        'Log'
      ),

      logEl
    )
  );

  cleanup =
    () => {
      peer.destroy();
    };

  log(
    turn
      ? `TURN configuration received from DM link`
      : 'No TURN configuration in DM link'
  );

  log(
    `connecting to ${PREFIX}${room}`
  );
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

function route() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }

  activeLog = null;

  app.replaceChildren();

  const [path] =
    (
      location.hash
        .replace(/^#/, '') ||
      '/'
    ).split('?');

  const dm =
    path.match(
      /^\/dm\/([a-z0-9]+)$/i
    );

  const player =
    path.match(
      /^\/join\/([a-z0-9]+)$/i
    );

  if (dm) {
    dmView(
      dm[1],
      getTurnFromHash()
    );

    return;
  }

  if (player) {
    playerView(
      player[1]
    );

    return;
  }

  home();
}

window.addEventListener(
  'hashchange',
  route
);

route();