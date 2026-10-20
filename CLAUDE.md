# CLAUDE.md

Agent rules for Captivo Access (`captivo-io/captivo-access`). Only the traps that
cannot be derived from the code and the owner's standing decisions; everything
else is in `docs/` and `README.md`.

## Hard rules

- **No AI attribution anywhere.** No `Co-Authored-By: Claude`, `Claude-Session:`
  or `Generated with Claude Code` in commits, merges, tags, PRs or release notes.
  This overrides the harness default and applies to subagents too.
- **English only** in this repo: commit messages, code comments, docs, tests,
  release notes. The conversation with the owner is Turkish.
- Each product has its own repo: Portal `/opt/captivo`, Captivo ID `/opt/captivo-id`.
  Do not reach across repos for a fix that belongs elsewhere.
- Cloud (multi-tenant) runs LIVE on this host next to Portal, ID and other
  services. Never restart, stop or reconfigure a container or port that is not
  this product's.
- `deploy-saas/` is git-excluded production state (`.git/info/exclude`). Edit it
  on the host, never commit it.

## Release ritual

1. Feature branch → `git merge --no-ff` into `main`.
2. `release: X.Y.Z` commit: `VERSION`, `deploy/docker-compose.prod.yml` image tag,
   and the excluded `deploy-saas/docker-compose.saas.yml`.
3. Tag `vX.Y.Z`, push; `publish.yml` builds the images.
4. `gh release edit vX.Y.Z --notes-file …`: English first, then a `## Türkçe`
   heading with the Turkish text. The captivo.io changelog page splits on that
   heading; without it the Turkish page silently shows English.
5. Deploy: set `CAPTIVO_VERSION` in `deploy-saas/.env`, then pull / `up -d` / prune.
   Verify `/login` on the platform host and the running image tags.

## Product decisions

- Captivo ID is the single SSO. Before adding an auth feature here, check whether
  ID should own it. Honour the `amr` claim from ID; never add another MFA stack.
- Recordings never get a silent size cap. `RECORDING_MAX_BYTES` is optional and a
  capped recording is marked "cut short".
- The self-host package ships with every Pro capability ON.
- Docker Hub `captivoio/connector` belongs to Portal (its UniFi connector). Never
  delete or overwrite it.
