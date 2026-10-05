# 5.5e Companion contributor guide

## Project boundaries

- Keep the application fully static. GitHub Pages serves the repository artifact; do not add a server or a build-time framework without an explicit architecture decision.
- Keep every first-party asset URL relative. The production site is hosted below `/5.5e-companion/`, so root-relative URLs break it.
- Treat `data/srd-5.2-*.json` and `LICENSE-SRD` as licensed reference material: do not edit them unless the task explicitly changes the SRD dataset and attribution.
- Preserve IndexedDB compatibility (`dnd-companion`, version 1) and the PeerJS message protocol. Existing DM workspaces and connected players must continue to work after an update.
- Do not store secrets, session content, or player data in the repository or deployment logs.

## Application map

- `index.html` is the DM dashboard; `player.html` is the player view.
- `js/db.js` owns IndexedDB, `js/peer.js` owns PeerJS/WebRTC, and `js/dm.js`/`js/player.js` own their respective UIs.
- `sw.js`, `manifest.webmanifest`, and `js/pwa.js` provide installability and offline caching.
- `.github/workflows/verify.yml` checks changes; `.github/workflows/release.yml` deploys published releases to Pages.

## Working rules

- Use vanilla browser JavaScript and the existing IIFE/global-export patterns.
- Prefer `async`/`await`; keep DOM updates event-driven.
- Maintain the existing input limits and escaping/sanitization patterns when adding form fields.
- Test desktop and mobile layouts for changes to either page.
- Run `npm run verify` before handing off a change. Serve locally with `python3 -m http.server 8000` when browser testing is needed.

Read [docs/architecture.md](docs/architecture.md) for system details and [docs/releasing.md](docs/releasing.md) before changing deployment or publishing a release.
