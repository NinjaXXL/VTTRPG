# 5.5e Companion

A web app for tabletop 5.5e sessions. DMs manage characters and track battlefield encounters, while players view their character sheets in real time via QR code + PIN.

**Live site:** https://volnuttz.github.io/5.5e-companion

## Features

- **DM Dashboard** - Create and manage characters (stats, equipment, spells, features, currency)
- **Player View** - Join sessions via QR code, view character sheets with tabs (Stats, Equipment, Spells)
- **Battlefield** - Track monster and character HP, view stat blocks during encounters
- **Treasures & Shops** - Manage loot pools and shops, assign items to characters
- **Real-time Updates** - Character changes sync instantly to players via PeerJS/WebRTC
- **Workspace Management** - Save, load, and clear workspace data (JSON backup/restore)
- **Character Import/Export** - Import characters from TOML files; export for sharing or backup
- **Session Notes** - Persistent auto-saving freeform notes per session
- **SRD 5.2 Data** - Pre-loaded spells, monsters, equipment, class features, species traits, and feats

## Tech Stack

- **Hosting:** GitHub Pages (fully static, deployed from published GitHub Releases)
- **Storage:** IndexedDB (client-side, DM's browser is source of truth)
- **Real-time:** PeerJS / WebRTC data channels (public cloud signaling)
- **Frontend:** Vanilla HTML/CSS/JS + DaisyUI 4 + Tailwind CSS (CDN, no build step)

## How It Works

1. DM opens the app and creates characters
2. DM clicks "Start Session" and sets a PIN
3. A QR code is generated — players scan it or navigate to the join URL
4. Players enter the PIN and claim a character
5. Character updates (HP, equipment, etc.) sync in real time via WebRTC

All data is stored in the DM's browser via IndexedDB. Use **Save Workspace** to export data as JSON for backup.

## Local Development

This is a static web app and can be run with Python's built-in server (recommended):

```bash
git clone https://github.com/volnuttz/5.5e-companion.git
cd 5.5e-companion
python3 -m http.server 8000
```

Open `http://localhost:8000/index.html` for DM or `http://localhost:8000/player.html` for player.

## Project Structure

```
├── .github/workflows/   # Static validation and release-only Pages deployment
├── docs/                # Architecture, development, and release guidance
├── data/                # SRD 5.2 reference data (read-only JSON)
├── css/style.css        # Parchment theme styles
├── js/
│   ├── constants.js     # Classes, species, backgrounds, spell slots
│   ├── db.js            # IndexedDB abstraction layer
│   ├── peer.js          # PeerJS communication layer
│   ├── dm.js            # DM dashboard logic
│   └── player.js        # Player character sheet logic
├── manifest.webmanifest # Installable web-app metadata
├── sw.js                # Offline shell and release-versioned cache
├── index.html           # DM dashboard page
├── player.html          # Player view page
└── LICENSE-SRD          # SRD 5.2 CC BY 4.0 attribution
```

## Releases

See [docs/releasing.md](docs/releasing.md) for the release process and the one-time GitHub Pages configuration change. Run `npm run verify` before merging or publishing.

## License

SRD 5.2 content is used under the [Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/). See [LICENSE-SRD](LICENSE-SRD) for full attribution.
