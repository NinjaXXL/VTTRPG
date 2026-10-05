# Architecture

5.5e Companion is a static, two-page web application. GitHub Pages hosts the files directly; there is no application server or build output.

| Area | Source of truth | Compatibility concern |
| --- | --- | --- |
| DM workspace | IndexedDB (`dnd-companion`) in the DM browser | Preserve database/store names and stored-record shapes. |
| Live session | PeerJS/WebRTC through the public PeerJS signalling service | Preserve message types and payloads in `js/peer.js`. |
| SRD content | `data/srd-5.2-*.json` | Read-only licensed data; retain `LICENSE-SRD` and attribution. |
| Install/offline shell | `manifest.webmanifest`, `js/pwa.js`, `sw.js` | Keep first-party paths relative for the Pages subpath. |

## Runtime entry points

- `index.html` loads the DM dashboard plus IndexedDB and PeerJS layers.
- `player.html` reads `room` from the query string and loads the player sheet plus PeerJS.
- `404.html` provides a simple Pages fallback.

## PWA behaviour

The service worker precaches the application shell and tries to cache CDN dependencies. Same-origin requests use network first with a cached fallback, so a new deployment is preferred whenever the network is available. Release deployment substitutes its tag for `__RELEASE_VERSION__` in `sw.js`; that creates a new cache namespace per release.

Offline mode retains the UI and local workspace. A live player session still needs a network connection to the DM/PeerJS service.
