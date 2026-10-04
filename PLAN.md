# VTTRPG – Project Plan

A serverless, browser-only, multi-user TTRPG tabletop for GitHub Pages: interactive maps with lighting and tokens, characters (attributes, items, features, macros) and a chat with roll output, usernames and history.

Status: Planning (v0.1 of this document)

---

## 1. Requirements (as given)

| # | Requirement |
|---|-------------|
| R1 | Everything lives in the browser / GitHub Pages. No backend, no database, no storage outside the browser. |
| R2 | Repo is a **GitHub Template**. The DM creates their own repo from it and enables GitHub Pages. Only the DM ever hosts or deploys anything. |
| R3 | The DM creates a **Campaign** on the site. All campaign data is stored locally in the DM's browser. |
| R4 | The DM has full permissions. Everyone else is a **Player**. |
| R5 | Players join through a **link** the DM creates and shares. The link acts as a **session** the DM can open/close. |
| R6 | The DM has **moderation** over who joins (approve, kick, ban, lock). |
| R7 | Chat, maps, creatures, features etc. are stored locally on the DM side with **export/import** to a file. |
| R8 | v1: Players are only numbered by join order ("Player 1", "Player 2"). No accounts, no per-player storage. All players can access all player-facing content. |

---

## 2. Key architectural decisions

### 2.1 The DM's browser is the server
The DM's open tab is the single source of truth ("host-authoritative" model).
- Players connect directly to the DM's browser via **WebRTC data channels** (star topology: DM in the center, players as leaves).
- The DM's client holds the full campaign state, applies/validates all changes, and broadcasts state updates to players.
- Players keep only a transient in-memory copy. Closing a player's tab loses nothing.

**Consequences to accept (and state in the README):**
- A session only works while the DM's tab is open and online.
- If the DM's browser data is cleared and no export exists, the campaign is gone → autosave-to-file reminders and export are mandatory features.

### 2.2 "Cookies" → IndexedDB
Real cookies hold about 4 KB and are sent with every request, so they cannot hold maps, images or chat logs.
Use **IndexedDB** (via a small wrapper such as `idb` or Dexie) with `localStorage` only for tiny settings. It's the same "local browser storage" idea, but with hundreds of MB of capacity. Call `navigator.storage.persist()` to reduce the risk of eviction.

### 2.3 The one unavoidable third party: signaling
WebRTC peers need to exchange connection info (SDP/ICE) once before they can talk directly. A static site cannot do this alone. Options:

| Option | How it works | Pros | Cons |
|--------|--------------|------|------|
| **A. Public signaling relay (recommended)** via a library like **Trystero** (uses BitTorrent trackers, Nostr relays or MQTT brokers) or **PeerJS** public cloud | Used only for the handshake. No game data is stored there. | Fully automatic, link-click join, no hosting by the DM | Relies on free public infrastructure that can be down. Transient metadata (not content) passes through it |
| **B. Manual signaling** | DM and player copy/paste offer/answer blobs (or QR codes) | 100% serverless, zero third parties | Poor UX, especially for many players |
| **C. DM-provided signaling** | Cloudflare Worker etc. | Reliable | Violates "nothing but GitHub Pages" |

**Decision for v1:** Option A behind an abstraction (`Transport` interface) so it can be swapped. Option B is a fallback later. This does not violate R1 in spirit: no data is *stored* outside the browser. It is transient connection setup, and it will be documented honestly.

Also: WebRTC uses public **STUN** servers by default. A minority of strict networks (corporate / some mobile) need **TURN** relay, which is not free to host. v1 accepts that a few players may fail to connect and shows a clear diagnostic message.

### 2.4 Link-as-session design
- The DM creates a Campaign with a random **campaign ID** (stable, stored locally).
- "Open session" generates a **session link**: `https://<dm>.github.io/<repo>/#/join/<sessionId>[?k=<secret>]`
  - Uses the URL **hash** so GitHub Pages' static hosting needs no routing. The secret never goes to a server.
  - `sessionId` doubles as the signaling "room" name; derive it from a random token plus a secret so the room can't be guessed.
- "Close session" disconnects all peers, invalidates the link (new token next time).
- Moderation: join requests land in a **lobby**; the DM approves/denies. Modes: *open*, *approval required* (default), *locked*. Kick, ban (by session-scoped peer ID, with the honest caveat that bans are best-effort in an account-less system) and a player cap.

### 2.5 Player identity in v1
- On approval the DM's client assigns `playerNumber` (1, 2, 3 … by join order) and a display name (default "Player N", editable by the player and a DM-overridable).
- A **reconnect token** stored in the player's `sessionStorage`/`localStorage` lets a player who refreshes keep their number during the same campaign. This is a small convenience and not an account.
- v1 permission model: Players can see everything player-facing and may move **their own token(s)**, roll, chat and edit characters. (Open question: should any player be able to edit any character? See §9.)

### 2.6 Tech stack (proposal)
- **Vite + TypeScript**, static build, deployed by a **GitHub Actions workflow** to Pages (included in the template so the DM only has to enable Pages → "GitHub Actions").
- UI: **Svelte** (matches your existing character sheet project and has a small bundle) – or plain TS + Web Components if you'd rather avoid a framework. Decision in §9.
- Map rendering: **PixiJS** (WebGL, good for dynamic lighting/fog via masks/filters) or Canvas2D + custom shadow casting. PixiJS recommended.
- Storage: IndexedDB (Dexie). State sync: small custom event/patch protocol, or **Yjs** CRDT (see §4.3).
- Dice: custom parser (`2d6+3`, `4d6kh3`, advantage, exploding) with unit tests; seeded RNG option not needed in v1.
- Tests: Vitest for logic (dice, macros, lighting math, sync), Playwright for 2-browser multiplayer smoke tests.

---

## 3. Feature scope

### 3.1 Campaign management (DM)
- Create / rename / delete / list campaigns (stored locally)
- Export campaign → single `.vttrpg.json` or `.zip` (images included); import → restore. Autosave nudges ("last export: 12 days ago").
- Settings: system flavour (generic first), grid, units, session mode.

### 3.2 Maps
- Upload background image (stored as Blob in IndexedDB, downscaled/compressed option)
- Grid (square first, hex later): size, offset, snap
- Pan/zoom, ruler/measure, pings
- **Tokens:** image, size, owner (DM/Player N), name, visibility, HP bar/status icons, link to character/creature
- **Fog of war / vision:** per-token vision radius, DM reveal/hide brush
- **Lighting:** light sources (radius bright/dim, color), walls/doors/windows as line segments blocking light and vision, ambient darkness level; DM sees everything, players see through their tokens' vision
- Multiple maps/scenes; DM decides which scene players see
- Layers: background, tokens, GM-only layer, drawings/annotations

### 3.3 Characters & Creatures
- Sheet model with: **Attributes** (name, value, derived formulas), **Items** (inventory, quantity, weight, description, equipped), **Features** (description, uses/recharge), **Macros**
- **Macros:** named roll/chat templates with references, e.g. `/r 1d20 + @attr.str.mod` or buttons on the sheet that roll and post to chat. Formula engine with variable resolution and safe expression evaluator (no `eval`).
- Creature library (DM) → drag onto a map to create a token + linked sheet instance
- Reuse ideas/code from your existing *DND Character Sheets* project (engine/schema) where it fits – reviewed once I have access to it again.

### 3.4 Chat
- Messages with sender name/number, timestamp, type (text, roll, whisper, system, emote)
- Roll output cards: formula, individual dice, modifiers, total, crit/fumble highlight
- Whispers / GM-only rolls
- Chat history persisted on the DM side, replayed to players on join (last N messages), included in the export
- Slash commands: `/r`, `/gmr`, `/w`, `/me`

### 3.5 Moderation & session
- Lobby with approve/deny, kick, ban, lock, rename, mute
- Connection status and latency per player; DM "pause" (blur map for players)

### Out of scope for v1 (parking lot)
Player accounts / per-player storage · audio/video · hex grids · animated tokens · rules automation for specific systems · mobile-native apps · persistent bans across sessions · TURN hosting

---

## 4. Architecture

### 4.1 Modules
```
src/
  app/            shell, routing (hash), pages: Home, Campaign (DM), Join (Player)
  core/
    state/        campaign state model + reducers/actions
    storage/      IndexedDB repo, export/import, migrations
    net/          Transport interface, WebRTC impl, protocol, host/client roles
    permissions/  role checks (DM vs Player), per-action validation
  features/
    map/          renderer, tokens, grid, fog, lighting, walls, tools
    sheets/       attributes, items, features, macros, formula engine
    dice/         parser, roller
    chat/         store, commands, roll cards
    session/      lobby, moderation, invite link
  ui/             shared components, theme
.github/workflows/deploy.yml   build + deploy to Pages
```

### 4.2 Roles & trust
- **DM client = authority.** Every player action is sent as an *intent* ("move token X to (x,y)", "roll 1d20+3", "post chat"); the DM validates against permissions and applies it, then broadcasts the result. Players never mutate state directly.
- Rolls are executed **on the DM side** (prevents trivial cheating and enables hidden rolls).
- Fog/vision secrets: the DM only sends players data they're allowed to see (hidden tokens and GM layer are never transmitted), not just hidden in the UI.

### 4.3 Sync protocol
Because the host is authoritative, a full CRDT is overkill. Proposed v1: **versioned event log + snapshots**.
- Messages: `hello`, `join_request`, `join_accept`, `snapshot` (full player-visible state), `patch` (incremental ops with sequence number), `intent`, `chat`, `ping`.
- Late joiner or reconnect: receive snapshot, then patches. Sequence gap → request a new snapshot.
- Large assets (map images) are sent in **chunks** over the data channel, with hash-based dedupe/caching on the player side.
- Protocol versioned from day 1 (`protocolVersion`) so the DM's repo and a player's cached page can detect mismatch.

### 4.4 Data model (sketch)
```
Campaign { id, name, createdAt, schemaVersion, settings }
Scene    { id, name, mapAssetId, grid, walls[], lights[], fog, ambient }
Token    { id, sceneId, x, y, size, ownerRef, characterId?, visible, vision, light? }
Character{ id, kind: 'pc'|'npc', name, attributes[], items[], features[], macros[] }
Asset    { id, hash, mime, blob }
ChatMsg  { id, ts, senderRef, kind, text, roll?, whisperTo? }
Session  { id, isOpen, mode, players[ {num, name, token, status} ], bans[] }
```
Every persisted record carries `schemaVersion`; migrations run on load/import.

---

## 5. Milestones

| M | Goal | Key deliverables | Done when |
|---|------|------------------|-----------|
| **M0** | Foundations | Vite+TS(+Svelte) scaffold, CI deploy to Pages, template-repo settings, README "How to deploy your own" | A fresh repo created from the template shows a live page via Pages |
| **M1** | Local campaign + storage | Create/list/delete campaign, IndexedDB layer, export/import, persist() | Export → clear browser data → import restores everything |
| **M2** | Dice + chat (local) | Dice parser + tests, chat UI, roll cards, slash commands, persisted history | `/r 4d6kh3+2` renders a correct roll card that survives reload |
| **M3** | Networking spike → real session | Transport abstraction, WebRTC via Trystero, session open/close, link, lobby approve/deny, player numbering, snapshot sync, chat over network | Two browsers on different networks chat and roll through the DM |
| **M4** | Maps & tokens | PixiJS renderer, image upload, grid, pan/zoom, tokens, ownership, networked movement, ruler/pings, multiple scenes | DM and players see synced movement; players can only move own tokens |
| **M5** | Characters & macros | Sheet model/UI, formula engine, items/features, macro buttons → chat, creature library, token↔sheet link | A macro on a sheet rolls with sheet values and posts to chat |
| **M6** | Lighting & vision | Walls/doors, lights, vision, fog reveal, player-specific visibility with server-side filtering | A player cannot see (or receive data for) areas out of their tokens' sight |
| **M7** | Moderation & hardening | Kick/ban/lock/mute, reconnect handling, error/diagnostic UI, bounded message sizes, backpressure, autosave reminders | Survives player refresh/drop and DM reload (session resumes) |
| **M8** | Polish & release | Docs, template flag set, sample campaign, accessibility pass, v1.0 tag | Someone unfamiliar can deploy and run a session from the README alone |

M0–M3 prove the riskiest assumption (serverless multiplayer) early. If M3 fails badly, we find out before building maps.

---

## 6. Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Public signaling relays unreliable/blocked | Players can't join | Transport abstraction; multiple relay strategies in Trystero; manual copy/paste fallback (Option B) |
| Strict NATs need TURN | Some players fail to connect | Clear diagnostics; document limitation; allow the DM to optionally enter their own TURN credentials in settings |
| DM browser storage evicted/cleared | Campaign lost | `storage.persist()`, prominent export, periodic backup reminders, optional auto-download of backups |
| DM tab closes/sleeps (esp. mobile/background tab throttling) | Session drops | Document "DM keeps tab foregrounded on desktop"; Screen Wake Lock; fast resume + snapshot on reconnect |
| Large map images over data channels | Slow joins | Downscale on upload, chunking, hash cache, thumbnails first |
| Lighting/vision performance | Low FPS | WebGL (Pixi) masks, cap wall/light counts, test on mid-range laptops |
| Cheating by players (devtools) | Spoilers | Authority + data filtering on DM side so hidden info is never sent |
| Bans easy to evade | Moderation weak | Document honestly; lock mode + approval as the primary tools |
| Schema changes break old exports | Data loss | `schemaVersion` + migrations + import validation from M1 |
| Scope creep | Never ships | Strict milestone gates; parking lot list above |

---

## 7. Template & deployment plan

1. Mark repo as **Template repository** (Settings → "Template repository").
2. Include `.github/workflows/deploy.yml` (build with Vite, `base` path auto-detected from the repo name, deploy via `actions/deploy-pages`).
3. README "DM quick start": *Use this template → Create repository → Settings → Pages → Source: GitHub Actions → open the URL → Create Campaign → Open Session → copy link*.
4. Privacy note in the README: what is stored where, what the signaling relay sees.
5. Versioning: tagged releases; template users can pull updates manually; app shows its version and warns on protocol mismatch between DM and players.

---

## 8. Testing strategy
- **Unit (Vitest):** dice parser, formula/macro evaluation, permission checks, patch application, export/import + migrations, lighting geometry
- **Integration:** protocol host/client with an in-memory fake transport (no browser needed)
- **E2E (Playwright):** two or three browser contexts: join flow, lobby approval, token movement, chat, reconnect
- **Manual:** cross-network test (home vs mobile hotspot) at M3 and M7

---

## 9. Open questions for you

1. **Framework:** Svelte (consistent with your existing character sheet app) or no framework?
2. **Signaling:** OK to use a public relay (Option A) for the handshake only, with manual fallback later?
3. **Player permissions in v1:** can a player edit only their own character, or any? Move only own tokens, or any?
4. **Game system:** generic first (custom attributes/macros) or targeting D&D 5e's rules/sheet layout from the start? Should we port parts of your existing sheet project?
5. **Persistence of the session after the DM reloads:** should players auto-reconnect when the DM reopens the same session link?
6. **Language/UI:** English only, or German + English?
7. **Asset size budget:** acceptable max map image size (e.g. 10 MB each)?

---

## 10. Immediate next steps
1. You answer §9 (even partially; I'll assume defaults: Svelte, Option A, players edit only own characters, generic system, English).
2. I scaffold M0 in this folder: Vite + TS + Svelte, deploy workflow, README, template notes.
3. Start the M3 networking spike early (small proof of concept) to validate the serverless approach before investing in the map.
