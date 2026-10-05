# VTTRPG – Skeleton (concept test)

Bare-bones test of the core idea: a DM hosts everything from their own browser on GitHub Pages, players join via a link + PIN. No backend, no build step, no accounts.

**What it does:** create campaign (stored in the DM's browser) → open session → share link and PIN → players ask to join → DM approves/denies/kicks/bans → shared chat (stored on the DM side, replayed to joiners) → export/import campaign as a file.

**What it deliberately does not do:** maps, tokens, characters, dice, nice UI. See `PLAN.md` for the full plan.

## How the connection works (modelled on the 5.5e-companion repo)
- **PeerJS** with the public PeerJS cloud as signaling (only introduces the browsers). Chat/game data go over WebRTC data channels, DM = host.
- Each campaign has a **permanent room id**. The DM registers the peer id `vttrpg-<roomId>`. The **join link never changes** (`#/join/<roomId>`); the **PIN** is set by the DM per session and typed by the players. The DM can still approve each player in a lobby.
- **DM:** if the signaling connection drops, it reclaims its id automatically (backoff). If the id is still held after a page refresh, it retries 3 times. Silent player connections (60 s) are dropped.
- **Player:** 10 s timeout per attempt, then **automatic retries with exponential backoff** (1 s up to 30 s), also when the tab becomes visible or the network comes back. After a drop it re-joins automatically with its token and keeps its Player number. Heartbeat ping every 30 s.
- Closing the session and reopening it later lets waiting players reconnect by themselves.

Default ICE setup = PeerJS defaults, which in practice means Google STUN only: PeerJS announced in Dec 2023 that its free TURN servers are discontinued, although the library still lists them. So **only direct connections work by default** (same Wi-Fi, or networks that allow hole punching). Networks that cannot connect directly need a **TURN relay**: get free credentials from a TURN provider, paste them into the DM view, press **Test TURN credentials** (checks them without a second device), then open the session and copy the NEW join link (the TURN settings travel inside it). **Relay-only test** forces all traffic through TURN to prove it is really used.

## Run locally
ES modules need http (not `file://`):
```
cd VTTRPG
python3 -m http.server 8000
```
Open http://localhost:8000. Several tabs work for testing (each tab is its own player).

## Deploy to GitHub Pages
1. Push to the `main` branch.
2. Repo → Settings → Pages → Source: **GitHub Actions**.
3. Open `https://<user>.github.io/<repo>/`. Check the version in the footer after a hard refresh.

## Test checklist
1. DM: create campaign → set a PIN → Open session → copy the link (or scan the QR code).
2. Player on another device/network: open the link, enter name + PIN, Join.
3. Wrong PIN → "Wrong PIN" and the form unlocks. Right PIN with "Approval required": DM approves in the Lobby.
4. Chat both ways. Reload the player tab → rejoins as the same Player number.
5. DM: Close session, wait, reopen → the player reconnects by itself.
6. Kick/Ban, Locked and Open modes.
7. DM reload → campaign and chat still there. Export → delete → import.
8. Use **Copy log** on both sides if something fails.

## Reading the log
- `rtc#N: ICE gathering finished; local candidates` → `host`/`srflx` = direct, `relay` = via TURN.
- `CONNECTED, path used (* = selected)` shows which path won.
- `PeerJS error (peer-unavailable)` → the DM is not registered (session closed or DM lost signaling).
- `ICE candidate error 701` on a TURN URL → that TURN server is unreachable from this network.

## Known limitations of the skeleton
- Third parties: PeerJS cloud (signaling) and STUN/TURN servers. No game data is stored there.
- Bans are best effort (identity is a random per-tab token).
- Storage is `localStorage` (about 5 MB). The real project should use IndexedDB.
- PeerJS is loaded from a CDN (`jsdelivr`, pinned to 1.5.5).
