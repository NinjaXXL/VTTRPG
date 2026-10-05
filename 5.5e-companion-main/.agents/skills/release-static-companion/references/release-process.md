# Release process

`release.yml` deploys only on a published GitHub Release or a deliberate manual dispatch. It substitutes the tag into `sw.js`, so each release gets a distinct PWA cache. Pages must use **GitHub Actions** as its source. See `docs/releasing.md` for exact steps, including rollback and controlled redeploy guidance.
