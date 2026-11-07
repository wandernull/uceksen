# PROGRESS

> Maintained by the agent. First action of every session: read this file. Update it at the end of every phase.
> When the user returns after a break, this file tells them where things stand.

**Last updated:** 2026-11-07
**Active phase:** Phase 0 — Skeleton
**Status:** ✅ done — awaiting user approval before Phase 1

---

## Phases

| | Phase | Status | Commit |
|---|---|---|---|
| 0 | Skeleton | ✅ | first commit `phase 0: …` (hash recorded at next update) |
| 1 | Static pages | ⬜ | — |
| 2 | Form and admin | ⬜ | — |
| 3 | Email | ⬜ | — |
| 4 | Guide sales | ⬜ | — |
| 5 | Booking (without Google) | ⬜ | — |
| 6 | Google Calendar | ⬜ | — |
| 7 | Intake, reminders, summary | ⬜ | — |
| 8 | Cleanup and resilience | ⬜ | — |
| 9 | Go live | ⬜ | — |

Status markers: ⬜ not started · 🔄 in progress · ⏸ blocked on user · ✅ done

---

## Currently working on

Nothing — Phase 0 finished, waiting for approval to start Phase 1 (static pages).

## Blocked on user

Nothing right now.

## Preparation status (SPEC §10), as of 2026-11-07

| # | Item | Status |
|---|---|---|
| 1 | Cloudflare token (Workers, D1, R2) | ✅ `CLOUDFLARE_API_TOKEN` in `~/.gizem-creds`, verified |
| 2 | Prototype files | ✅ `design/` |
| 3 | Admin emails | ✅ `gizemderinkok@gmail.com`, `bbartu.demirci@gmail.com` |
| 4 | Domain on Cloudflare | ⬜ ask before Phase 3 |
| 5 | DNS permission on token | ❓ user believes it exists — verify before Phase 3 |
| 6 | Resend account + key | ⬜ ask before Phase 3 |
| 7 | Company details | ✅ Back of the Envelope B.V., Keizersgracht 520H, 1017EK Amsterdam, Netherlands · KvK 97838810 · BTW NL868254010B01 · court city still unknown |
| 8 | `DEV_EMAIL` | ⬜ ask before Phase 3 |
| 9 | Stripe account (isolated, KYC) | ⬜ ask before Phase 4 |
| 10 | Stripe test restricted key | ⬜ ask before Phase 4 |
| 11 | Guide PDF | ⬜ ask before Phase 4 |
| 12 | GCP project + OAuth client | ⬜ ask before Phase 6 |
| 13 | "Üç Eksen" calendar | ⬜ in `gizemderinkok@gmail.com`, configure in Phase 6 |

## Completed

**Phase 0 — Skeleton (2026-11-07)**
- Hono app on Workers, TypeScript strict, `src/index.ts` → `/health` (checks D1 with `SELECT 1`, returns 503 if the DB is unreachable)
- D1 `uceksen-db` (`8cef0ac7-f979-4657-822f-ee79f0cb5bac`), R2 `uceksen-files`, both bound in `wrangler.toml` as `DB` / `BUCKET`
- `migrations/0001_init.sql`: full SPEC §4 data model up front (CHECK constraints on enums, `bookings.start_utc UNIQUE`, partial unique index so only one `guide_versions.is_current`, seeded `settings` row id=1). Applied locally and remotely.
- Tests: Vitest 5 + `@cloudflare/vitest-plugin` (runs in workerd, D1 migrations applied per run). 3 tests: `/health` 200, schema/table list + settings defaults, duplicate `start_utc` rejected.
- Deployed: `https://uceksen.gizemderinkok.workers.dev/health` → 200 `{"ok":true,"environment":"staging","db":true}`
- GitHub repo `wandernull/uceksen` (public), `CLOUDFLARE_API_TOKEN` set as Actions secret, `.github/workflows/deploy.yml` deploys on push to `main`
- `AGENTS.md`, `README.md` (setup/run/deploy), `.gitignore` (`.dev.vars`, `.env*`, `*.key`, `.wrangler/`, the bundle zip)

## Decisions made

> Anything that deviates from `SPEC.md`, or that the spec did not cover, goes here with the reasoning.

- **2026-11-07 — Single deployed environment.** User does not want staging + production. One Worker (`uceksen`) on `uceksen.gizemderinkok.workers.dev` until the domain is handed over. Locally: `wrangler dev`. Replaces SPEC §3 three-environment table.
- **2026-11-07 — Deployed Worker runs with `ENVIRONMENT = "staging"` until Phase 9.** Because there is only one deployment, it must keep the `DEV_EMAIL` guard on during the build. Flipping `ENVIRONMENT` to `"production"` is part of go-live (Phase 9), done together with the Stripe live key.
- **2026-11-07 — CI deploys on every push to `main`** (GitHub Actions: typecheck → tests → D1 migrations → `wrangler deploy`). Global standard; acceptable since the only deployment is guarded as above.
- **2026-11-07 — Public GitHub repo** under the account tied to `GH_TOKEN` (`wandernull`). Company details (name, address, KvK, BTW) go directly into the legal pages: Dutch law requires them to be shown publicly on a business website anyway, so there is nothing to hide.
- **2026-11-07 — `AGENTS.md` added; no `PROJECT_PLAN.md`.** `PROGRESS.md` + `SPEC.md` fill that role; a third file would drift.
- **2026-11-07 — Node 22 (`.nvmrc` = 22.21.1), not the global-standard 20.19.5.** Current wrangler (4.158) and `@cloudflare/vitest-plugin` require Node ≥ 22; Node 20 is EOL since April 2026.
- **2026-11-07 — `@cloudflare/vitest-plugin` instead of `@cloudflare/vitest-pool-workers`** (the latter is deprecated/renamed). Vitest 5.
- **2026-11-07 — Whole data model in migration 0001.** SPEC §4 is fully specified, so the schema lands once; later phases add migrations only for real changes. Timestamps are UTC ISO-8601 strings with ms + `Z`.
- **2026-11-07 — Google refresh token encrypted at rest** (AES-GCM, key from `ENCRYPTION_KEY` secret) instead of plaintext in `settings`.
- **2026-11-07 — Single Google calendar:** the "Üç Eksen" calendar in `gizemderinkok@gmail.com`. OAuth is done with that account; freebusy queries that account's calendars only (SPEC §5.5 mentions gizem + baran; reduced to gizem).
- **2026-11-07 — Guide price is €15 permanently.** SPEC §1 "€29 from December" dropped. One Stripe price.
- **2026-11-07 — Mailbox must stay possible later.** Planned for Phase 3: inbound threading (Reply-To `merhaba+{token}@…`) goes to a dedicated subdomain (e.g. `reply.uceksen.com`) with its own MX to Resend, so the root domain's MX can later be moved to a real mailbox provider without breaking conversation threading. Confirm with user at start of Phase 3.

## Known issues

- `GH_TOKEN` lacks the `read:org` scope; `gh auth status` warns. Harmless for this repo.
- Legal pages: court city for `satis-kosullari.html` is not provided yet (assume Amsterdam unless told otherwise — confirm in Phase 1).

## Next step

On approval: Phase 1 — move `design/` pages into the Worker (Workers static assets), route all six pages, fill company details into the legal pages.
