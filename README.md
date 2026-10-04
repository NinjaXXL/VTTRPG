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
Open http://localhost:8000. Test with several tabs: the DM in one tab, the join link in other tabs (each tab counts as a separate player).

## Deploy to GitHub Pages
1. Push to the `main` branch.
2. Repo → Settings → Pages → Source: **GitHub Actions**.
3. Open `https://<user>.github.io/<repo>/`.

## Signaling strategy (important for connecting)
Players and DM find each other through free public relays. The DM picks the strategy before opening a session and it is stored in the join link (`#/join/<room>.<secret>.<strategy>`):

| Strategy | Relays | Notes |
|----------|--------|-------|
| `mqtt` (default) | public MQTT brokers (emqx, hivemq, shiftr, mosquitto) | Library maintainers rate it the most robust after Nostr |
| `torrent` | public WebTorrent trackers | |
| `nostr` | public Nostr relays | Many relays now reject this kind of traffic |

If players see "No DM found", close the session, pick another strategy, reopen and share the **new** link. The *Connection log* on both sides prints which library loaded and the state of every relay connection at 2/6/15/30 s. Please send that log if it still fails.

## Test checklist
1. DM: create campaign → Open session → copy link.
2. Player on another device/network (e.g. phone on mobile data): open link, enter name, Join.
3. "Approval required": DM sees the request in the Lobby → Approve. Player gets "Player 1" and the chat history.
4. Chat both ways; reload the player tab → rejoins as the same Player number.
5. Kick, then Ban; try rejoining. Try Locked / Open with a new player.
6. DM: Close session → players see "closed", old link is dead.
7. DM: reload → campaign + chat still there. Export → delete campaign → import → restored.
8. Compare strategies: how long does connecting take?

## Known limitations of the skeleton
- Third party: only for the WebRTC handshake (public relays + STUN). No game data is stored there. The link contains a random secret that encrypts the handshake.
- Some networks need a TURN server for direct connections (not included).
- Players are also connected to each other (mesh). The client only trusts the peer that answered its join request, but a malicious player could try to pose as the DM.
- Bans are best effort (identity is a random per-tab token).
- Storage is `localStorage` (about 5 MB). The real project should use IndexedDB.
- Trystero is pinned to `0.26.0` and loaded from a CDN (`esm.run`, fallback `esm.sh`).
