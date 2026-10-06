# VTTRPG – connection test (Trystero)

Two files: `index.html` + `app.js`. A DM hosts from their own browser (GitHub Pages), players join via link or QR code and chat. No backend.

**Flow:** create campaign (stored in the DM's browser) → Start session → share link / QR code → player opens it, enters a name, Join → chat (history is stored on the DM side) → every step is written to the connection log.

## TURN (important for different networks)
Set it **once at the top of `app.js`**, it is then used automatically by the DM and by every player:
- `TURN_SERVERS = [{ urls: [...], username, credential }]`, or
- `TURN_FETCH_URL = 'https://…'` (a URL that returns the same list as JSON, e.g. a provider's credentials endpoint).

Without TURN the log shows `WARNING: no TURN server configured`, and devices on networks that cannot reach each other directly will not connect. Values in `app.js` are readable by everyone who opens the page.

## Signaling
Trystero (pinned `0.26.0`, loaded from esm.run with esm.sh as fallback) introduces the browsers through public relays. The DM can choose `mqtt` (default), `torrent` or `nostr`; the choice is stored in the link. Chat data uses the direct WebRTC channel (or the TURN relay).

## Run / deploy
- Locally: `python3 -m http.server 8000`, open http://localhost:8000 (several tabs work for testing).
- GitHub Pages: push to `main`, Settings → Pages → Source: GitHub Actions.
- **After every change bump the version in two places:** `APP_VERSION` in `app.js` and `?v=` in the script tag of `index.html`. The footer shows the running version.

## Reading the log
- `rtc#N: ICE gathering done; local candidates {...}`: `host`/`srflx` = direct, `relay` = via TURN.
- `CONNECTED, path used (* = selected)`: which path was chosen.
- `ICE candidate error 701 … turn:` = that TURN server is unreachable; `401` = wrong credentials.
- `JOIN ERROR: could not connect to peer … after exchanging SDP` = browsers found each other but the network path failed.
- `status @…s` lines show the state of every signaling relay and peer connection.
- Use **Copy log** on both sides and send both.
