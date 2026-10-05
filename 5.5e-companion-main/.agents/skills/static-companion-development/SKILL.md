---
name: static-companion-development
description: Maintain or extend the 5.5e Companion static web app. Use when changing the DM dashboard, player view, IndexedDB data, PeerJS protocol, SRD UI, PWA files, or first-party asset paths in this repository.
---

# Static Companion Development

Read `AGENTS.md` and `references/architecture.md` before making changes.

1. Preserve static hosting and relative first-party URLs.
2. Keep IndexedDB store names, record fields, and PeerJS payloads backward compatible unless a migration is explicitly requested.
3. Treat SRD JSON as read-only licensed material.
4. For PWA work, preserve offline fallback and validate both pages.
5. Run `npm run verify`; use a local HTTP server for browser or service-worker checks.
