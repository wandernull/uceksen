# uceksen

Üç Eksen — guide sales, consulting bookings and customer communication in one system.
Cloudflare Workers + Hono + D1 + R2. One deployment: `https://uceksen.gizemderinkok.workers.dev` (until the real domain is connected).

## Files

| File | Purpose |
|---|---|
| `CLAUDE.md` | The project's binding rules. Claude Code loads this every session. |
| `AGENTS.md` | Pointer for any AI agent entering the repo. |
| `SPEC.md` | Technical specification. What gets built. |
| `PROGRESS.md` | Live state, decisions log, what is blocked on you. |
| `design/` | UI prototype and design system. Not to be changed. |
| `src/` | Worker source (Hono). |
| `migrations/` | D1 schema, plain SQL, numbered `0001_`, `0002_`, … |
| `test/` | Vitest, running inside the Workers runtime. |

## Setup

Requires Node 22 (`.nvmrc`).

```sh
nvm use
npm install
cp .dev.vars.example .dev.vars   # local secrets; never committed
npm run db:migrate:local
```

## Run

```sh
npm run dev          # http://localhost:8787, /health should return 200
npm test
npm run typecheck
```

After changing `wrangler.toml` bindings or vars: `npx wrangler types --env-interface Env`.

## Deploy

Every push to `main` runs `.github/workflows/deploy.yml`: typecheck → tests → remote D1 migrations → `wrangler deploy`.
The `CLOUDFLARE_API_TOKEN` repo secret must be set. Manual deploy: `npm run db:migrate:remote && npm run deploy`.

Secrets go in with `npx wrangler secret put NAME`, never into the repo.

`ENVIRONMENT` is `"staging"` on the deployed Worker until go-live, which keeps every outgoing email redirected to `DEV_EMAIL`. Switching it to `"production"` is part of Phase 9.

## Language

Working language is English: code, comments, commits, documentation.
**Product language is Turkish:** every page, every email, every form label, and the admin interface.

## Stepping away and coming back

Open a new session and say "continue". The agent reads `PROGRESS.md` and picks up from there. Commits named `phase N: …` are the restore points.
