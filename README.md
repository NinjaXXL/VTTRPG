# VTTRPG – Skeleton (concept test)

Bare-bones test of the core idea: a DM hosts everything from their own browser on GitHub Pages, players join via a link. No backend, no build step, no accounts.

**What it does:** create campaign (stored in the DM's browser) → open session → share link → players ask to join → DM approves/denies/kicks/bans → shared chat (stored on the DM side, replayed to joiners) → export/import campaign as a file.

**What it deliberately does not do:** maps, tokens, characters, dice, nice UI. See `PLAN.md` for the full plan.

## Run locally
ES modules need http (not `file://`):
```
cd VTTRPG
python3 -m http.server 8000
```
Open http://localhost:8000. Test with several tabs: the DM in one tab, the join link in other tabs (each tab counts as a separate player). A real test needs a second device or network (see below).

## Deploy to GitHub Pages
1. Push to the `main` branch.
2. Repo → Settings → Pages → Source: **GitHub Actions**.
3. Open `https://<user>.github.io/<repo>/`.

## Test checklist
1. DM: create campaign → Open session → copy link.
2. Player on another device/network (e.g. phone on mobile data): open link, enter name, Join.
3. Join mode "Approval required": DM sees the request in the Lobby → Approve. Player gets "Player 1", chat history.
4. Chat both ways; reload the player tab → rejoins as the same Player number (token kept per tab).
5. Kick, then Ban; try rejoining. Switch mode to Locked / Open and retry with a new player.
6. DM: Close session → players see "closed", old link is dead.
7. DM: reload the page → campaign + chat still there. Export → delete campaign → import → restored.
8. Check the *Connection log* on both sides to see how long connecting takes.

## Things this test is meant to reveal
- Do players connect reliably through the free public signaling relays (Trystero)? How long does it take?
- Do some networks (corporate Wi-Fi, mobile carriers) fail? (Would need a TURN server.)
- Does the DM's tab survive being in the background (browsers throttle hidden tabs)?

## Known limitations of the skeleton
- Third party: only for the WebRTC handshake (public relays + STUN). No game data is stored there. The link contains a random secret that encrypts the handshake.
- Players are connected to each other too (Trystero mesh), but the client only trusts the peer that answered its join request, and a malicious player could try to pose as the DM. Fine for a test, needs hardening later.
- Bans are best effort: the identity is a random per-tab token, so a banned player could join again from a new tab/browser.
- Storage is `localStorage` (about 5 MB). The real project should use IndexedDB.
- The Trystero version is pinned (`0.21.8`) and loaded from a CDN (`esm.run`).
