# VTTRPG – Skeleton (concept test)

Bare-bones test of the core idea: a DM hosts the campaign in their browser on GitHub Pages, players join via a link or QR code. No application backend, build step, or accounts.

**What it does:** create campaign (stored in the DM's browser) → open session → share link → players ask to join → DM approves/denies/kicks/bans → shared chat (stored on the DM side, replayed to joiners) → export/import campaign as a file.

**What it deliberately does not do:** maps, tokens, characters, dice, nice UI. See `PLAN.md` for the full plan.

## Run locally
ES modules need http (not `file://`):
```
cd VTTRPG
python3 -m http.server 8000
```
Open http://localhost:8000. Test with several tabs: the DM in one tab, the join link in other tabs (each tab counts as a separate player).

## Deploy to GitHub Pages
1. Push to the `main` branch.
2. Repo → Settings → Pages → **Deploy from a branch** → `main` → `/(root)` → Save.
3. Open `https://<user>.github.io/<repo>/`.

## Connection model
The DM opens a session, then shares the generated link or QR code. The player opens it, enters a name, and joins. The DM approves the request. The player keeps only a random secret ID in local browser storage; player number, bans, permissions, and the campaign data remain in the DM's browser.

The test uses PeerJS public cloud signaling to introduce the two browsers, then uses a direct WebRTC data channel for chat and session messages. This is the same model used by the linked 5.5e Companion reference. The signaling service is external infrastructure; GitHub Pages alone cannot exchange WebRTC connection details. Some restrictive networks may still require TURN before remote play is reliable.

## Test checklist
1. DM: create campaign → Open session → copy link.
2. Player on another device/network (e.g. phone on mobile data): open link, enter name, Join.
3. "Approval required": DM sees the request in the Lobby → Approve. Player gets "Player 1" and the chat history.
4. Chat both ways; reload the player tab → rejoins as the same Player number.
5. Kick, then Ban; try rejoining. Try Locked / Open with a new player.
6. DM: Close session → players see "closed", old link is dead.
7. DM: reload → campaign + chat still there. Export → delete campaign → import → restored.
8. Scan the QR code from a second device and repeat the flow.

## Known limitations of the skeleton
- Third party: PeerJS public cloud handles only the WebRTC handshake. Game data is sent over the direct DM-to-player channel.
- Some networks need a TURN server for direct connections (not included).
- Bans are best effort because player identity is a random secret held by the player browser.
- Storage is `localStorage` (about 5 MB). The real project should use IndexedDB.
- PeerJS is pinned to `1.5.5` and QR rendering is loaded from a CDN.
