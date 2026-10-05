const VERSION = '0.12.0';
const PREFIX = 'vttrpg-';

const CONNECT_TIMEOUT = 10000;
const RECONNECT_START = 1000;
const RECONNECT_MAX = 30000;

// Automatic relay. The user does not configure anything.
const PEER_CONFIG = {
  debug: 2,

  config: {
    iceServers: [
      {
        urls: 'turn:turn.anyfirewall.com:443?transport=tcp',
        username: 'webrtc',
        credential: 'webrtc',
      },
    ],

    iceTransportPolicy: 'relay',

    sdpSemantics: 'unified-plan',
  },
};

const app = document.getElementById('app');

let cleanup = null;
let logBox = null;

function log(text) {
  const line =
    `${new Date().toLocaleTimeString()}  ${text}`;

  if (logBox) {
    logBox.textContent +=
      line + '\n';

    logBox.scrollTop =
      logBox.scrollHeight;
  }

  console.log(
    '[VTTRPG]',
    text
  );
}

function makeLog() {
  logBox =
    document.createElement('pre');

  logBox.className =
    'log';

  return logBox;
}

function h(
  tag,
  props = {},
  ...children
) {
  const el =
    document.createElement(tag);

  for (
    const [key, value]
    of Object.entries(props)
  ) {
    if (
      key.startsWith('on')
    ) {
      el.addEventListener(
        key.slice(2),
        value
      );
    } else if (
      key === 'class'
    ) {
      el.className =
        value;
    } else {
      el.setAttribute(
        key,
        value
      );
    }
  }

  for (
    const child
    of children.flat()
  ) {
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

function randomRoom() {
  const chars =
    'abcdefghijklmnopqrstuvwxyz0123456789';

  const bytes =
    new Uint8Array(14);

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
}

function chatUi(send) {
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
// HOME
// -----------------------------------------------------------------------------

function home() {
  app.replaceChildren();

  const logElement =
    makeLog();

  const start =
    h(
      'button',
      {
        onclick:
          () => {
            location.hash =
              `#/dm/${randomRoom()}`;
          },
      },
      'Start DM'
    );

  app.append(
    h(
      'section',
      {},

      h(
        'h2',
        {},
        'VTTRPG DM'
      ),

      h(
        'p',
        {
          class:
            'muted',
        },
        'Start a session. The app immediately creates the QR code.'
      ),

      start
    ),

    h(
      'section',
      {},

      h(
        'h2',
        {},
        'Log'
      ),

      logElement
    )
  );

  logBox =
    logElement;

  log(
    `VTTRPG v${VERSION} ready`
  );
}

// -----------------------------------------------------------------------------
// DM
// -----------------------------------------------------------------------------

function createDMPeer(
  room,
  onConnection
) {
  const peerId =
    PREFIX + room;

  const peer =
    new Peer(
      peerId,
      PEER_CONFIG
    );

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
        `DM PeerJS error: ` +
        `${error.type || error.message || error}`
      );
    }
  );

  peer.on(
    'disconnected',
    () => {
      log(
        'DM signaling disconnected'
      );

      setTimeout(
        () => {
          if (
            !peer.destroyed
          ) {
            try {
              peer.reconnect();

              log(
                'DM signaling reconnect requested'
              );
            } catch (
              error
            ) {
              log(
                `DM reconnect failed: ${error.message}`
              );
            }
          }
        },
        1000
      );
    }
  );

  peer.on(
    'connection',
    connection => {
      log(
        `incoming connection from ${connection.peer}`
      );

      connection.on(
        'iceStateChanged',
        state => {
          log(
            `DM ICE: ${state}`
          );
        }
      );

      connection.on(
        'open',
        () => {
          log(
            `PLAYER CONNECTED: ${connection.peer}`
          );

          onConnection(
            connection
          );
        }
      );

      connection.on(
        'data',
        data => {
          if (
            data?.type ===
            'chat'
          ) {
            onConnection(
              connection,
              data
            );
          }
        }
      );

      connection.on(
        'close',
        () => {
          log(
            `PLAYER DISCONNECTED: ${connection.peer}`
          );
        }
      );

      connection.on(
        'error',
        error => {
          log(
            `DM data error: ` +
            `${error.type || error.message || error}`
          );
        }
      );
    }
  );

  return peer;
}

function dmView(
  room
) {
  app.replaceChildren();

  const logElement =
    makeLog();

  logBox =
    logElement;

  let player =
    null;

  const status =
    h(
      'div',
      {
        class:
          'status',
      },
      'Starting…'
    );

  const joinUrl =
    `${location.origin}` +
    `${location.pathname}` +
    `#/join/${room}`;

  const url =
    h(
      'input',
      {
        readonly:
          '',
        value:
          joinUrl,
      }
    );

  const qr =
    h(
      'canvas',
      {
        id:
          'qr',
      }
    );

  const chat =
    chatUi(
      text => {
        if (
          !player?.open
        ) {
          return;
        }

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

        player.send({
          type:
            'chat',

          msg:
            message,
        });
      }
    );

  chat.enable(
    false
  );

  const peer =
    createDMPeer(
      room,
      (
        connection,
        data
      ) => {
        if (
          !data
        ) {
          player =
            connection;

          status.textContent =
            'Player connected';

          chat.enable(
            true
          );

          return;
        }

        if (
          data.type ===
          'chat'
        ) {
          chat.add(
            data.msg
          );

          // Echo chat to all other participants.
          if (
            player?.open
          ) {
            player.send(
              data
            );
          }
        }
      }
    );

  QRCode.toCanvas(
    qr,
    joinUrl,
    {
      width:
        240,

      margin:
        2,
    }
  );

  status.textContent =
    'Waiting for player…';

  app.append(
    h(
      'section',
      {},

      h(
        'h2',
        {},
        'DM session'
      ),

      status,

      h(
        'p',
        {},
        'Scan this QR code:'
      ),

      qr,

      h(
        'div',
        {
          class:
            'row',
        },

        url,

        h(
          'button',
          {
            onclick:
              async () => {
                try {
                  await navigator.clipboard.writeText(
                    joinUrl
                  );

                  log(
                    'link copied'
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

      logElement
    )
  );

  log(
    `DM room: ${room}`
  );

  log(
    `DM peer id: ${PREFIX}${room}`
  );

  log(
    'ICE policy: relay only'
  );

  log(
    'TURN: turn.anyfirewall.com:443/tcp'
  );

  cleanup =
    () => {
      try {
        peer.destroy();
      } catch {}
    };
}

// -----------------------------------------------------------------------------
// PLAYER
// -----------------------------------------------------------------------------

function playerView(
  room
) {
  app.replaceChildren();

  const logElement =
    makeLog();

  logBox =
    logElement;

  const status =
    h(
      'div',
      {
        class:
          'status',
      },
      'Connecting…'
    );

  let connection =
    null;

  const chat =
    chatUi(
      text => {
        if (
          !connection?.open
        ) {
          return;
        }

        connection.send({
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

  const peer =
    new Peer(
      undefined,
      PEER_CONFIG
    );

  peer.on(
    'open',
    id => {
      log(
        `Player PeerJS open: ${id}`
      );

      log(
        `connecting to ${PREFIX}${room}`
      );

      connection =
        peer.connect(
          PREFIX + room,
          {
            reliable:
              true,
          }
        );

      let opened =
        false;

      const timer =
        setTimeout(
          () => {
            if (
              !opened
            ) {
              status.textContent =
                'Connection failed';

              log(
                'connection timed out'
              );
            }
          },
          CONNECT_TIMEOUT
        );

      connection.on(
        'iceStateChanged',
        state => {
          log(
            `Player ICE: ${state}`
          );
        }
      );

      connection.on(
        'open',
        () => {
          opened =
            true;

          clearTimeout(
            timer
          );

          status.textContent =
            'Connected';

          chat.enable(
            true
          );

          log(
            'PLAYER CONNECTED'
          );
        }
      );

      connection.on(
        'data',
        data => {
          if (
            data?.type ===
            'chat'
          ) {
            chat.add(
              data.msg
            );
          }
        }
      );

      connection.on(
        'close',
        () => {
          status.textContent =
            'Disconnected';

          chat.enable(
            false
          );

          log(
            'connection closed'
          );
        }
      );

      connection.on(
        'error',
        error => {
          status.textContent =
            'Connection error';

          log(
            `data error: ` +
            `${error.type || error.message || error}`
          );
        }
      );
    }
  );

  peer.on(
    'error',
    error => {
      status.textContent =
        'PeerJS error';

      log(
        `Player PeerJS error: ` +
        `${error.type || error.message || error}`
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
          if (
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
        'p',
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

      logElement
    )
  );

  log(
    `room: ${room}`
  );

  log(
    'ICE policy: relay only'
  );

  log(
    'TURN: turn.anyfirewall.com:443/tcp'
  );

  cleanup =
    () => {
      try {
        peer.destroy();
      } catch {}
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

  const path =
    (
      location.hash
        .replace(/^#/, '') ||
      '/'
    ).split('?')[0];

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
      dm[1]
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