# uceksen

Üç Eksen — guide sales, consulting bookings and customer communication in one system.
Cloudflare Workers + Hono + D1 + R2. Two Workers: **staging** `uceksen` on `https://staging.uceksen.com` (branch `staging`) and **production** `uceksen-production` on `https://uceksen.com` (branch `main`, from go-live). Each has its own D1, KV, R2 and secrets.

## Files

| File | Purpose |
|---|---|
| `CLAUDE.md` | The project's binding rules. Claude Code loads this every session. |
| `AGENTS.md` | Pointer for any AI agent entering the repo. |
| `SPEC.md` | Technical specification. What gets built. |
| `PROGRESS.md` | Live state, decisions log, what is blocked on you. |
| `design/` | Original UI prototype — reference only, never edited. |
| `public/` | Live static pages and assets (ported from `design/`). `public/styles.css` must stay byte-identical to `design/styles.css`; additions go in `public/site.css`. |
| `scripts/check-layout.mjs` | Browser layout check: phone widths, light/dark, focus, fonts. |
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
npm run check:design   # public/styles.css == design/styles.css
npm run test:layout    # needs `npm run dev` running + Google Chrome installed
```

After changing `wrangler.toml` bindings or vars: `npx wrangler types --env-interface Env`.

## Deploy

`.github/workflows/deploy.yml`: push to `staging` → typecheck → tests → staging D1 migrations → `wrangler deploy` (top level). Push to `main` → the same with `--env production`. Work goes to `staging`; `main` only gets merges from `staging` with the user's green light.
The `CLOUDFLARE_API_TOKEN` repo secret must be set. Manual deploy: staging `npm run db:migrate:remote && npm run deploy`; production `npm run db:migrate:production && npx wrangler deploy --env production`.

Secrets go in with `npx wrangler secret put NAME` (staging) or `npx wrangler secret put NAME --env production`, never into the repo. `ENCRYPTION_KEY` differs per environment.

| Secret | Purpose |
|---|---|
| `ADMIN_EMAILS` | `gizem=…,baran=…` — who may use `/admin` (must match the Access policy); the name is the message author |

`/admin` sits behind Cloudflare Access (self-hosted application on the `/admin` path). The Worker also verifies the Access JWT itself using the `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` vars in `wrangler.toml`; while those are empty, `/admin` returns 403 on the deployed Worker. Locally (`ENVIRONMENT=local`) there is no Access and you act as the first admin in `ADMIN_EMAILS`.

`ENVIRONMENT` is `"staging"` on the staging Worker, which redirects every outgoing email to `DEV_EMAIL` (switch: `MAIL_GUARD`). Production has `ENVIRONMENT = "production"`. Both share the Resend domains; inbound mail is split by reply address (`staging+…@reply.uceksen.com` vs `merhaba+…@`), see `isForThisEnvironment`.

## Language

Working language is English: code, comments, commits, documentation.
**Product language is Turkish:** every page, every email, every form label, and the admin interface.

## Stepping away and coming back

Open a new session and say "continue". The agent reads `PROGRESS.md` and picks up from there. Commits named `phase N: …` are the restore points.
