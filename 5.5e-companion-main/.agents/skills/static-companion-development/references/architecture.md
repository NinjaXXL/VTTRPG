# Companion constraints

The production URL is a GitHub Pages project site, so `/asset` is incorrect; use paths relative to each HTML file. `index.html` is the DM entry point and `player.html` is the player entry point. Data lives only in the DM's IndexedDB database (`dnd-companion`); live updates travel over PeerJS/WebRTC. Read `docs/architecture.md` for the full map.
