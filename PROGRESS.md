# PROGRESS

> Maintained by the agent. First action of every session: read this file. Update it at the end of every phase.
> When the user returns after a break, this file tells them where things stand.

**Last updated:** 2026-11-07
**Active phase:** Phase 2 — Form and admin
**Status:** ⏸ code done — blocked on user: Cloudflare Access setup

---

## Phases

| | Phase | Status | Commit |
|---|---|---|---|
| 0 | Skeleton | ✅ | `8b74e18` |
| 1 | Static pages | ✅ | `bbdf3c0` |
| 2 | Form and admin | ⏸ | commit `phase 2: …` (hash recorded at next update) |
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

Waiting for the Cloudflare Access setup (see "Blocked on user"). After that: set `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`, deploy, verify admin login together with the user, mark Phase 2 done.

## Blocked on user

**Cloudflare Access for `/admin`** (SPEC §11 step 2, ~10 min):
1. Cloudflare dashboard → **Zero Trust**. If asked, pick a team name (free plan is enough) → this gives `<team>.cloudflareaccess.com`.
2. **Access → Applications → Add an application → Self-hosted.**
   - Name: `Üç Eksen admin`
   - Public hostname: domain `uceksen.gizemderinkok.workers.dev`, path `admin`
   - Session duration: 24 hours (or what you prefer)
3. Policy: name `Admins`, action **Allow**, include **Emails**: `gizemderinkok@gmail.com`, `bbartu.demirci@gmail.com`.
4. Login method: the default **One-time PIN** works (code sent by email). Google login is optional.
5. Do **not** use the one-click "Enable Cloudflare Access" button on the Worker's workers.dev setting — that would lock the whole site.
6. Send the agent: the **team domain** (`<team>.cloudflareaccess.com`) and the application's **Application Audience (AUD) tag** (Access → Applications → the app → Overview/Basic information). Neither is secret.

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
| 8 | `DEV_EMAIL` | ✅ `bbartu.demirci@gmail.com` |
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

**Phase 1 — Static pages (2026-11-07)**
- Six pages served as Workers static assets from `public/` at clean URLs (`/`, `/rehber`, `/danismanlik`, `/hakkimizda`, `/gizlilik`, `/satis-kosullari`); `*.html` redirects to the clean URL
- `public/styles.css` byte-identical to `design/styles.css` (CI step `check:design`); additions only in `public/site.css` (focus rings, `overflow-wrap`), tokens only
- Fonts self-hosted (`public/fonts/`, latin + latin-ext woff2) — no request leaves the site
- Prototype fixes: `index.html` was a fragment (no doctype/head/viewport) — wrapped; nav unified to 3 links everywhere; company details, processors (Resend, Cloudflare, Google), court city filled in; "Lansman fiyatı / €29" note replaced by "KDV dahil / Tek seferlik ödeme"; Stripe placeholder link → `/rehber/satin-al` (503 Turkish "yakında" page until Phase 4)
- `public/_headers`: nosniff, referrer policy, `X-Frame-Options: DENY`, permissions policy, long cache on fonts
- Worker falls back to `ASSETS` for unmatched paths (needed for tests; no effect in production)

**Phase 2 — Form and admin (2026-11-07, code done; Access setup pending)**
- `POST /api/talep` (JSON from the modal, form-encoded as no-JS fallback → Turkish HTML page): honeypot `website` (200, nothing stored), KV rate limit 5/hour/IP (`KV` namespace `uceksen-kv`), validation with Turkish messages, then one D1 batch: upsert `contacts` by email (lower-cased), new `conversations` (state `new`, 32-char base64url `reply_token` + `plus_token`, `source`, `consent_at`), first `messages` row (`in`, `customer`)
- Migration `0002`: `conversations.source`, `conversations.consent_at`
- Modal script moved to `public/talep.js` (shared by `/danismanlik` and `/hakkimizda`), real submit, inline error box, disabled button while sending
- Prototype bug fixed: `.modal-form`/`.modal-done` `display:flex` overrode `hidden`, so the success panel showed under the form at all times → `[hidden] { display: none !important; }` in `site.css`
- `/admin` (Hono JSX, `public/admin.css`, tokens only): conversation list with state filters + counts, preview, Turkish dates in `settings.host_tz`; detail with contact facts, consent time, message thread, state change (POST, CSRF origin check, 303 back). `no-store` + `noindex`.
- Auth: `requireAdmin` verifies the Cloudflare Access JWT (RS256 against the team's certs, `aud`, `iss`, `exp`), then requires the email in `ADMIN_EMAILS` (secret, set on the Worker). Access not configured ⇒ 403 for everyone. `local`/`test` environments skip Access and act as the first admin.
- Tests: 40 Worker tests (26 new: form storage, honeypot, upsert, 5 validation cases, rate limit, no-JS post, JWT accept/reject × 7, deployed /admin 403/200 cases, list/detail/filter/state change, CSRF, XSS escaping, 404). Mutation-checked: disabling the honeypot or the `aud` check makes tests fail. Browser check now 64 checks incl. form → admin end-to-end and admin pages at 320/375/1280 light/dark.
- Tests: 14 Worker tests (every page 200, `lang="tr"`, viewport, title, no Google Fonts, no `.html` links, no `[placeholder]`, identical nav, legal details, redirect, assets, buy placeholder). Browser layout check `npm run test:layout`: 6 pages × 320/375/414/1280px × light/dark + modal at 320px = 49 renders — no horizontal scroll, gutter ≥ 16px, correct theme background, fonts loaded with Turkish glyphs, keyboard focus visible, zero external requests. Screenshots reviewed manually.

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
- **2026-11-07 — `design/` is frozen reference; `public/` is the live source.** Pages were ported once with fixes; later phases edit `public/`. Only `styles.css` is enforced identical.
- **2026-11-07 — Nav = Rehber · Danışmanlık · Hakkımızda on every page.** The prototype had 5 links on three pages and 3 on the other three; 5 links overflow at phone width. Legal pages stay in the footer.
- **2026-11-07 — Fonts self-hosted** instead of Google Fonts CDN: loading from Google sends visitor IPs to Google, which the privacy page does not disclose (EU courts have ruled this a GDPR breach). Same typefaces, same weights.
- **2026-11-07 — Privacy page processors:** Resend (email send/receive), Cloudflare (hosting + data), and Google (calendar + Meet) — Google was missing from the prototype but processes consulting data. **User should confirm the wording.**
- **2026-11-07 — Court city = Amsterdam** (company seat). Confirmed by user.
- **2026-11-07 — Consulting flow follows the design, not SPEC §5.4 step 1** (confirmed by user). Customer submits the request form → admins evaluate in the conversation → admin sends a Stripe payment link from the admin conversation → after payment the customer picks a slot (SPEC §5.4 from step 2 on is unchanged). `/danismanlik` has no direct checkout.
- **2026-11-07 — Rate limiting in KV** (global standard: KV for edge state). Fixed window; soft limit because KV is eventually consistent across locations — acceptable for form abuse.
- **2026-11-07 — Worker verifies the Access JWT in addition to Access itself.** Not a password mechanism (CLAUDE.md forbids that); it guards against a misconfigured or bypassed Access app. Fails closed.
- **2026-11-07 — `ADMIN_EMAILS` format `gizem=…,baran=…`** (SPEC said plain comma-separated) so the admin's identity maps to `messages.author`. Kept as a secret because the repo is public.
- **2026-11-07 — Each form submission opens a new conversation**, even for a known email (SPEC §5.1). The contact is upserted; empty phone does not erase a stored one.
- **2026-11-07 — Google refresh token encrypted at rest** (AES-GCM, key from `ENCRYPTION_KEY` secret) instead of plaintext in `settings`.
- **2026-11-07 — Single Google calendar:** the "Üç Eksen" calendar in `gizemderinkok@gmail.com`. OAuth is done with that account; freebusy queries that account's calendars only (SPEC §5.5 mentions gizem + baran; reduced to gizem).
- **2026-11-07 — Guide price is €15 permanently.** SPEC §1 "€29 from December" dropped. One Stripe price.
- **2026-11-07 — Mailbox must stay possible later.** Planned for Phase 3: inbound threading (Reply-To `merhaba+{token}@…`) goes to a dedicated subdomain (e.g. `reply.uceksen.com`) with its own MX to Resend, so the root domain's MX can later be moved to a real mailbox provider without breaking conversation threading. Confirm with user at start of Phase 3.

## Known issues

- `GH_TOKEN` lacks the `read:org` scope; `gh auth status` warns. Harmless for this repo.
- Until Phase 3 the form's success text says a confirmation email was sent, but no email is sent yet.
- `/satis-kosullari` says an expired download link can be renewed "siteden" and links to `/`; point it at `/indir` in Phase 4.
- `/gizlilik` promises an unsubscribe link at the bottom of guide-update emails — must be implemented in Phase 4.
- `test:layout` runs locally only (needs Chrome + running dev server); not in CI.

## Open questions

—

## Next step

User sets up Cloudflare Access → agent configures + verifies → Phase 2 done. Then Phase 3 (email) — before it: domain, DNS permission on the token, Resend account + API key, MX approval.
