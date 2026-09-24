# Contributing to Captivo Access

Thanks for your interest in contributing. The project is actively developed and
released as tagged versions (`vX.Y.Z`); conventions still evolve, so keep an eye
on recent commits. It's a Node/Next.js control plane plus three Go services
(`connector/`, `dataplane/`, and the shared `tunnel/`).

## Requirements

- **Node.js 20** (see `.nvmrc`)
- **pnpm 9.14.2** (`corepack enable pnpm` or `corepack pnpm@9.14.2 <cmd>`)
- **Docker** + Docker Compose (for the local Postgres instance)
- **Go 1.25+** — only if you touch `connector/`, `dataplane/`, or `tunnel/`
  (a `go.work` at the repo root spans all three modules; the `dataplane`
  module targets Go 1.25, so a full `go build ./...` needs 1.25+)

## Setup

```bash
git clone https://github.com/captivo-io/captivo-access.git
cd captivo-access
pnpm install
cp .env.example .env   # edit DATABASE_URL / POSTGRES_PASSWORD / SESSION_SECRET
pnpm db:generate
pnpm dev
```

## Commands

```bash
pnpm dev          # dev server, http://localhost:3100
pnpm build        # production build
pnpm test         # vitest
pnpm lint         # eslint
pnpm typecheck    # tsc --noEmit
pnpm db:generate  # regenerate Prisma client after a schema change
pnpm db:push      # push schema to the database
pnpm build:recorder  # regenerate src/recorder/rec.bundle.ts after editing
                     # src/recorder/record-init.ts (commit the generated output)
```

For the Go services (from the repo root, spanning the `go.work` modules):

```bash
go build ./...    # connector, dataplane, tunnel
go vet ./...
go test ./...
```

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` before opening a
PR — those run in CI. For a PR touching `connector/`, `dataplane/`, or `tunnel/`,
also run `go test ./...` and `go vet ./...` locally (CI currently gates only the
Node build).

## Commit style

Short, imperative commit messages (`feat: ...`, `fix: ...`, `docs: ...`,
`chore: ...`). Keep PRs focused on a single change.

## Pull requests

1. Fork the repo and create a branch off `main`.
2. Make your change, keeping it scoped and covered by tests where practical.
3. Ensure `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
4. Open a PR describing the change and why it's needed.

## Reporting security vulnerabilities

**Do not open a public issue for a security vulnerability.** See
[SECURITY.md](./SECURITY.md) for how to report it privately.

## License

By contributing, you agree that your contributions will be licensed under
the [Apache License 2.0](./LICENSE), the same license as the rest of the
project.
