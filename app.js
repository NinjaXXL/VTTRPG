const PREFIX = 'vttrpg-';

const PEER_OPTIONS = {
  config: {
    iceServers: [
      {
        urls: 'stun:stun.l.google.com:19302'
      },
      {
        urls: 'turn:turn.anyfirewall.com:443?transport=tcp',
        username: 'webrtc',
        credential: 'webrtc'
      }
    ]
  }
};

const app = document.getElementById('app');

let peer = null;
let connection = null;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function createRoomId() {
  return Math.random().toString(36).slice(2, 12);
}

function getBaseUrl() {
  return location.origin + location.pathname;
}

function addChat(from, text) {
  const chat = document.getElementById('chat');
  if (!chat) return;

  chat.insertAdjacentHTML(
    'beforeend',
    `<div class="msg"><b>${escapeHtml(from)}:</b> ${escapeHtml(text)}</div>`
  );

  chat.scrollTop = chat.scrollHeight;
}

function chatUi(enabled) {
  return `
    <div id="chat"></div>

    <div class="row">
      <input
        id="message"
        placeholder="Nachricht…"
        ${enabled ? '' : 'disabled'}
      >

      <button
        id="send"
        ${enabled ? '' : 'disabled'}
      >
        Senden
      </button>
    </div>
  `;
}

function enableChat(enabled) {
  const input = document.getElementById('message');
  const button = document.getElementById('send');

  if (!input || !button) return;

  input.disabled = !enabled;
  button.disabled = !enabled;
}

function bindChat() {
  const input = document.getElementById('message');
  const button = document.getElementById('send');

  if (!input || !button) return;

  const send = () => {
    const text = input.value.trim();

    if (!text) return;
    if (!connection || !connection.open) return;

    connection.send({
      type: 'chat',
      text
    });

    addChat('Du', text);

    input.value = '';
    input.focus();
  };

  button.onclick = send;

  input.onkeydown = event => {
    if (event.key === 'Enter') {
      send();
    }
  };
}

function showHome() {
  app.innerHTML = `
    <section>
      <h2>DM</h2>

      <button id="start">
        Session öffnen
      </button>

      <p class="muted">
        Session öffnen und danach den QR-Code für die Spieler anzeigen.
      </p>
    </section>
  `;

  document.getElementById('start').onclick = () => {
    const room = createRoomId();
    location.hash = '#/dm/' + room;
  };
}

function showDm(room) {
  const link = `${getBaseUrl()}#/join/${room}`;

  app.innerHTML = `
    <section>
      <div class="status" id="status">
        DM wird verbunden…
      </div>

      <p>
        Spieler scannen diesen QR-Code:
      </p>

      <input
        id="link"
        readonly
        value="${escapeHtml(link)}"
      >

      <div id="qr"></div>
    </section>

    <section>
      <h2>Chat</h2>
      ${chatUi(false)}
    </section>
  `;

  bindChat();

  if (window.QRCode) {
    QRCode.toCanvas(
      link,
      {
        width: 220
      },
      (error, canvas) => {
        if (!error) {
          const qr = document.getElementById('qr');
          if (qr) {
            qr.appendChild(canvas);
          }
        }
      }
    );
  }
}

function startDmPeer(room) {
  peer = new Peer(
    PREFIX + room,
    PEER_OPTIONS
  );

  peer.on('open', () => {
    const status = document.getElementById('status');

    if (status) {
      status.textContent = 'DM ist bereit. Warte auf Spieler…';
    }
  });

  peer.on('connection', incoming => {
    connection = incoming;

    connection.on('open', () => {
      const status = document.getElementById('status');

      if (status) {
        status.textContent = 'Spieler verbunden.';
      }

      enableChat(true);
    });

    connection.on('data', message => {
      if (
        message &&
        message.type === 'chat'
      ) {
        addChat('Spieler', message.text);
      }
    });

    connection.on('close', () => {
      connection = null;

      const status = document.getElementById('status');

      if (status) {
        status.textContent = 'Spieler getrennt.';
      }

      enableChat(false);
    });

    connection.on('error', error => {
      const status = document.getElementById('status');

      if (status) {
        status.textContent =
          'Verbindungsfehler: ' +
          (error.type || error.message || error);
      }

      enableChat(false);
    });
  });

  peer.on('error', error => {
    const status = document.getElementById('status');

    if (status) {
      status.textContent =
        'PeerJS-Fehler: ' +
        (error.type || error.message || error);
    }
  });
}

function showPlayer(room) {
  app.innerHTML = `
    <section>
      <div class="status" id="status">
        Verbinde mit dem DM…
      </div>
    </section>

    <section>
      <h2>Chat</h2>
      ${chatUi(false)}
    </section>
  `;

  bindChat();

  peer = new Peer(
    undefined,
    PEER_OPTIONS
  );

  peer.on('open', () => {
    connection = peer.connect(
      PREFIX + room,
      {
        reliable: true
      }
    );

    connection.on('open', () => {
      const status = document.getElementById('status');

      if (status) {
        status.textContent = 'Mit dem DM verbunden.';
      }

      enableChat(true);
    });

    connection.on('data', message => {
      if (
        message &&
        message.type === 'chat'
      ) {
        addChat('DM', message.text);
      }
    });

    connection.on('close', () => {
      connection = null;

      const status = document.getElementById('status');

      if (status) {
        status.textContent =
          'Verbindung zum DM geschlossen.';
      }

      enableChat(false);
    });

    connection.on('error', error => {
      const status = document.getElementById('status');

      if (status) {
        status.textContent =
          'Verbindungsfehler: ' +
          (error.type || error.message || error);
      }

      enableChat(false);
    });
  });

  peer.on('error', error => {
    const status = document.getElementById('status');

    if (status) {
      status.textContent =
        'PeerJS-Fehler: ' +
        (error.type || error.message || error);
    }
  });
}

function cleanupPeer() {
  if (peer) {
    try {
      peer.destroy();
    } catch (_) {
    }
  }

  peer = null;
  connection = null;
}

function route() {
  cleanupPeer();

  const joinMatch =
    location.hash.match(/^#\/join\/([a-z0-9]+)$/);

  const dmMatch =
    location.hash.match(/^#\/dm\/([a-z0-9]+)$/);

  if (joinMatch) {
    showPlayer(joinMatch[1]);
    return;
  }

  if (dmMatch) {
    showDm(dmMatch[1]);
    startDmPeer(dmMatch[1]);
    return;
  }

  showHome();
}

window.addEventListener(
  'hashchange',
  route
);

route();