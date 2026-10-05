# Development and verification

Run the app from a local HTTP server; opening the HTML files directly does not exercise fetches or service-worker registration correctly.

```bash
python3 -m http.server 8000
npm run verify
```

Open `http://localhost:8000/` for the DM dashboard and `http://localhost:8000/player.html` for the player view.

`npm run verify` has no package installation step. It syntax-checks browser JavaScript, parses local JSON/manifests, and verifies referenced first-party assets. It is intentionally a fast static gate, not a browser end-to-end suite.

Before a user-facing change, check:

- DM and player views at a narrow mobile viewport.
- A fresh workspace and an existing workspace in IndexedDB.
- A player joining, claiming, and receiving a character update when session behaviour changes.
- The installed app updating after a release when PWA files change.
