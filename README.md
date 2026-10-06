# VTTRPG – connection test (Trystero + Cloudflare TURN)

Two files: `index.html` + `app.js`. A DM hosts from their own browser (GitHub Pages), players join via link or QR code and chat. No backend.

**Flow:** create campaign (stored in the DM's browser) → set up TURN once → Start session → share link / QR code → player opens it, enters a name, Join → chat (history is stored on the DM side) → every step is written to the connection log.

## TURN with Cloudflare (free tier) – one-time setup for the DM
Without a TURN relay, devices on networks that cannot reach each other directly (e.g. phone on mobile data and a home Wi-Fi) will not connect. Cloudflare Realtime TURN has a free tier (1,000 GB of TURN traffic per month, then billed per GB; check the current terms and whether a payment method is required when you sign up).

1. In the Cloudflare dashboard open **Realtime** (formerly Calls) → **TURN** → create a **TURN key**. Note the **key ID** and the **API token** (the token is probably shown only once).
2. Open the DM view of your campaign, enter key ID + token in the TURN section, press **Save & test**. They stay in this browser only.
3. Start the session. The DM's browser asks Cloudflare for short-lived credentials (24 h) and puts them into the join link and QR code, so the players use the relay automatically. Credentials are renewed when less than 2 h are left; players need the *current* link after that.

**If the browser cannot call the Cloudflare API (CORS error in the log)**, create the credentials on any computer with curl and paste the JSON into the DM view ("or paste credentials created with curl" → *Use pasted credentials*):
```
curl -X POST "https://rtc.live.cloudflare.com/v1/turn/keys/YOUR_KEY_ID/credentials/generate-ice-servers" \
  -H "Authorization: Bearer YOUR_API_TOKEN" -H "Content-Type: application/json" -d '{"ttl": 86400}'
```
Security: the API token is a long-term secret. Never put it into `app.js` or the repo. Players only ever see the short-lived credentials from the link. Anyone with the link can use them until they expire.

## Signaling
Trystero (pinned `0.26.0`, loaded from esm.run with esm.sh as fallback) introduces the browsers through public relays. The DM can choose `mqtt` (default), `torrent` or `nostr`; the choice is stored in the link. Chat data uses the direct WebRTC channel (or the TURN relay).

## Run / deploy
- Locally: `python3 -m http.server 8000`, open http://localhost:8000 (several tabs work for testing).
- GitHub Pages: push to `main`, Settings → Pages → Source: GitHub Actions.
- **After every change bump the version in two places:** `APP_VERSION` in `app.js` and `?v=` in the script tag of `index.html`. The footer shows the running version.

## Reading the log
- `TURN configured: turn:turn.cloudflare.com…` → TURN is active. `WARNING: no TURN configured` → it is not.
- `TURN test OK` → Cloudflare issued a relay address, so key and credentials work.
- `rtc#N: ICE gathering done; local candidates {...}`: `host`/`srflx` = direct, `relay` = via TURN.
- `CONNECTED, path used (* = selected)`: which path was chosen (`relay` means TURN carried the connection).
- `ICE candidate error 701 … turn:` = TURN server unreachable; `401` = wrong or expired credentials.
- `JOIN ERROR: could not connect to peer … after exchanging SDP` = browsers found each other but the network path failed.
- `status @…s` lines show the state of every signaling relay and peer connection.
- Use **Copy log** on both sides and send both.
