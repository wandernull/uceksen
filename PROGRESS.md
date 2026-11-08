# PROGRESS

> Maintained by the agent. First action of every session: read this file. Update it at the end of every phase.
> When the user returns after a break, this file tells them where things stand.

**Last updated:** 2026-11-07
**Active phase:** Phase 3 — Email
**Status:** ⏸ code done and deployed — waiting for the user's real-mailbox test

---

## Phases

| | Phase | Status | Commit |
|---|---|---|---|
| 0 | Skeleton | ✅ | `8b74e18` |
| 1 | Static pages | ✅ | `bbdf3c0` |
| 2 | Form and admin | ✅ | `7aadf1b`, `94b5749` (Access) |
| 3 | Email | 🔄 | — |
| 4 | Guide sales | ⬜ | — |
| 5 | Booking (without Google) | ⬜ | — |
| 6 | Google Calendar | ⬜ | — |
| 7 | Intake, reminders, summary | ⬜ | — |
| 8 | Cleanup and resilience | ⬜ | — |
| 9 | Go live | ⬜ | — |

Status markers: ⬜ not started · 🔄 in progress · ⏸ blocked on user · ✅ done

---

## Currently working on

Phase 3 code is done, deployed and verified live by the agent (form → acknowledgement sent; simulated reply through the real `reply.` MX + webhook matched by In-Reply-To, quote stripped, state → ours). Remaining: the user's real-mailbox test (SPEC §9 Phase 3 test), then mark Phase 3 done.

## Blocked on user

**Real-mailbox test** (inbox: DEV_EMAIL `bbartu.demirci@gmail.com`):
1. Find "[TEST] Durum Analizi talebi — Üç Eksen" (live test conversation "Canlı Test") — reply to it from Gmail with a short text.
2. Within a minute the reply should appear in `/admin` → that conversation, without the quoted part; an "[Üç Eksen] Yeni yanıt (e-posta)" notification arrives too.
3. Reply from `/admin`; the email should arrive in the same Gmail thread.

**Reference — how Access was set up** (dashboard as of 2026-11, for reference): Zero Trust → Access controls → Applications → Self-hosted and private → *Workers* → **don't** pick a Worker type (both "production and preview URLs" and "preview URLs" protect the whole Worker; neither takes a path) → instead Destinations → **+ Add public hostname**: subdomain `uceksen`, domain `gizemderinkok.workers.dev`, path `admin`. Policy `Admins` (Allow, Include → Emails: the two admin addresses). Authentication: One-time PIN (had to be added first under login methods; only "Cloudflare" was listed), instant authentication on. App name in dashboard: `uceksen`.

## Preparation status (SPEC §10), as of 2026-11-07

| # | Item | Status |
|---|---|---|
| 1 | Cloudflare token (Workers, D1, R2) | ✅ `CLOUDFLARE_API_TOKEN` in `~/.gizem-creds`, verified |
| 2 | Prototype files | ✅ `design/` |
| 3 | Admin emails | ✅ `gizemderinkok@gmail.com`, `bbartu.demirci@gmail.com` |
| 4 | Domain on Cloudflare | ✅ `uceksen.com`, zone `a4190a0f842469760211c91a23d5a744`, active |
| 5 | DNS permission on token | ✅ Zone → DNS → Edit added 2026-11-07, read + write verified |
| 6 | Resend account + key | ✅ account `baran@uceksen.com`; full-access key in `~/.gizem-creds` as `RESEND_API_KEY_UCEKSEN` → `RESEND_API_KEY` in `.dev.vars` + Worker secret |
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

**Phase 2 — Form and admin (2026-11-07, done; admin login verified by user)**
- `POST /api/talep` (JSON from the modal, form-encoded as no-JS fallback → Turkish HTML page): honeypot `website` (200, nothing stored), KV rate limit 5/hour/IP (`KV` namespace `uceksen-kv`), validation with Turkish messages, then one D1 batch: upsert `contacts` by email (lower-cased), new `conversations` (state `new`, 32-char base64url `reply_token` + `plus_token`, `source`, `consent_at`), first `messages` row (`in`, `customer`)
- Migration `0002`: `conversations.source`, `conversations.consent_at`
- Modal script moved to `public/talep.js` (shared by `/danismanlik` and `/hakkimizda`), real submit, inline error box, disabled button while sending
- Prototype bug fixed: `.modal-form`/`.modal-done` `display:flex` overrode `hidden`, so the success panel showed under the form at all times → `[hidden] { display: none !important; }` in `site.css`
- `/admin` (Hono JSX, `public/admin.css`, tokens only): conversation list with state filters + counts, preview, Turkish dates in `settings.host_tz`; detail with contact facts, consent time, message thread, state change (POST, CSRF origin check, 303 back). `no-store` + `noindex`.
- Auth: `requireAdmin` verifies the Cloudflare Access JWT (RS256 against the team's certs, `aud`, `iss`, `exp`), then requires the email in `ADMIN_EMAILS` (secret, set on the Worker). Access not configured ⇒ 403 for everyone. `local`/`test` environments skip Access and act as the first admin.
- Tests: 40 Worker tests (26 new: form storage, honeypot, upsert, 5 validation cases, rate limit, no-JS post, JWT accept/reject × 7, deployed /admin 403/200 cases, list/detail/filter/state change, CSRF, XSS escaping, 404). Mutation-checked: disabling the honeypot or the `aud` check makes tests fail. Browser check now 64 checks incl. form → admin end-to-end and admin pages at 320/375/1280 light/dark.
- Tests: 14 Worker tests (every page 200, `lang="tr"`, viewport, title, no Google Fonts, no `.html` links, no `[placeholder]`, identical nav, legal details, redirect, assets, buy placeholder). Browser layout check `npm run test:layout`: 6 pages × 320/375/414/1280px × light/dark + modal at 320px = 49 renders — no horizontal scroll, gutter ≥ 16px, correct theme background, fonts loaded with Turkish glyphs, keyboard focus visible, zero external requests. Screenshots reviewed manually.

**Phase 3 — Email infrastructure (2026-11-07)**
- Root `uceksen.com` mail: **Cloudflare Email Routing** (user's choice). MX `route1/2/3.mx.cloudflare.net`, SPF `include:_spf.mx.cloudflare.net`, DKIM `cf2024-1._domainkey`. Rules: `baran@` and `merhaba@` → `baran@botelabs.io`. Namecheap forwarding MX/SPF and parking `A`/`www CNAME` deleted by the user.
- Resend (EU region `eu-west-1`), two domains on the free plan (limit 3):
  - `uceksen.com` (id `4c608941-c10e-4616-9bbd-908c9f89b049`) — sending only. Records: `resend._domainkey` TXT, `send` MX + TXT SPF, `rsend` CNAME (DNS only).
  - `reply.uceksen.com` (id `f740f79f-ba2c-4b95-8d8e-d819b001f3df`) — receiving only. Records: `resend._domainkey.reply` TXT, `reply` MX 10 → `receive-euw1.forge.rmta.net`.
  - Both verified.
- `_dmarc.uceksen.com` TXT `v=DMARC1; p=none;` (monitoring only).
- Site is still on workers.dev; `uceksen.com` has no A/CNAME until go-live.

**Phase 3 — Email code (2026-11-08)**
- `src/lib/mail.ts`: Resend client; **DEV_EMAIL guard inside `sendMail`** (every recipient → DEV_EMAIL unless `ENVIRONMENT === "production"`, intended recipients written at the top of the body, subject prefixed `[TEST]`; no DEV_EMAIL ⇒ nothing is sent).
- Outgoing: message row written first (`send_status` pending → sent/failed), then sent. Subject `<conversation subject> — Üç Eksen`, `Re: …` after the first message. `Reply-To: merhaba+<plus_token>@reply.uceksen.com`, `In-Reply-To`/`References` from the conversation's stored Message-IDs, footer link to `/konusma/<reply_token>`. Admin replies are signed with the admin's name.
- Contact form now sends the acknowledgement (quotes the form text) + one admin notification. Email failures never fail the form; a failed message shows "Gönderilemedi" + "Tekrar gönder" in `/admin`.
- `POST /api/webhooks/resend`: Svix signature check (5 min tolerance) → fetch full email from Resend → dedupe by Message-ID → match by In-Reply-To/References (resolving not-yet-known sent Message-IDs on the way), else by plus token → strip quotes (Gmail/Apple/Outlook, EN+TR; raw body kept in `messages.body_raw`) → store, state `ours`, attachments to R2, notify admins. Unmatched → `unmatched_emails` + notification; listed at `/admin/eslesmeyen`.
- `/konusma/<reply_token>`: thread + reply form with attachments (≤5 files, ≤10 MB each, document/image types), honeypot, CSRF origin check, 10 replies/hour/IP, `no-store`, `noindex`, `Referrer-Policy: no-referrer`. Downloads only via the same token, always `Content-Disposition: attachment`.
- `/admin`: reply box, send status + resend, attachments, sender shown when it differs from the contact, customer page link, "Eşleşmeyen" page.
- Migration `0003`: message send/receive columns, `attachments` table, dedupe indexes.
- Resend webhook `2f6b919a-ea32-48e2-8961-5c6015b4cc09` → `https://uceksen.gizemderinkok.workers.dev/api/webhooks/resend` (`email.received`). Worker secrets: `ADMIN_EMAILS`, `DEV_EMAIL`, `RESEND_API_KEY`, `RESEND_INBOUND_SECRET`. **The webhook URL must be changed to the real domain at go-live.**
- Tests: 99 Worker tests (DEV_EMAIL guard for every environment value, signature accept/reject incl. replay, 13 quote-stripping cases, HTML fallback, matching by header/token/late Message-ID, unmatched, dedupe, attachments, thread headers on admin replies, `/konusma` privacy headers/uploads/CSRF/honeypot/rate limit, admin reply/resend). Tests use a fake Resend and have network access disabled. Mutation-checked: disabling the guard, the signature check or quote stripping fails 11 / 4 / 13 tests. Browser check: 72 checks incl. admin reply (real send to DEV_EMAIL) and customer reply with a file.

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
- **2026-11-07 — Canonical admin URL is `/admin/`.** The Access path rule `admin` covers `/admin/` and below but not the bare `/admin` (it reached the Worker and got 403). The Worker now 301-redirects `/admin` → `/admin/` (query kept) and routes non-strictly; all admin links point at `/admin/`. The Worker's JWT check still guards every admin route.
- **2026-11-07 — `ADMIN_EMAILS` format `gizem=…,baran=…`** (SPEC said plain comma-separated) so the admin's identity maps to `messages.author`. Kept as a secret because the repo is public.
- **2026-11-07 — Each form submission opens a new conversation**, even for a known email (SPEC §5.1). The contact is upserted; empty phone does not erase a stored one.
- **2026-11-07 — Google refresh token encrypted at rest** (AES-GCM, key from `ENCRYPTION_KEY` secret) instead of plaintext in `settings`.
- **2026-11-07 — Single Google calendar:** the "Üç Eksen" calendar in `gizemderinkok@gmail.com`. OAuth is done with that account; freebusy queries that account's calendars only (SPEC §5.5 mentions gizem + baran; reduced to gizem).
- **2026-11-07 — Guide price is €15 permanently.** SPEC §1 "€29 from December" dropped. One Stripe price.
- **2026-11-07 — Mailbox must stay possible later.** Planned for Phase 3: inbound threading (Reply-To `merhaba+{token}@…`) goes to a dedicated subdomain (e.g. `reply.uceksen.com`) with its own MX to Resend, so the root domain's MX can later be moved to a real mailbox provider without breaking conversation threading. Confirm with user at start of Phase 3.
- **2026-11-07 — Replies go to `merhaba+{plus_token}@reply.uceksen.com`** (SPEC §5.2 said `merhaba+…@uceksen.com`). The root MX belongs to Cloudflare Email Routing, so Resend receives on a dedicated subdomain. A future mailbox on the root never breaks threading. Direct mail to `merhaba@uceksen.com` is forwarded by Email Routing, not ingested.
- **2026-11-07 — Resend in the EU region** (GDPR; customer data stays in the EU).
- **2026-11-08 — Plain-text emails only.** Simple, threads and quotes cleanly everywhere; matches the plain tone. HTML can be added later.
- **2026-11-08 — Plus token is lower-case base32 (32 chars, 160 bits)** instead of base64url: mail systems may change an address's case. `reply_token` (URL) stays base64url.
- **2026-11-08 — Message-ID is SES's, not ours.** Resend ignores a custom `Message-ID`; the real one is fetched from Resend after sending (and lazily before threading/matching).
- **2026-11-08 — One notification email to all admins** (not one per admin), so outside production it is a single test email.
- **2026-11-08 — Email attachments are stored in R2 too** (SPEC only required them on the web path); >10 MB ones are skipped (still in Resend).

## Known issues

- `GH_TOKEN` lacks the `read:org` scope; `gh auth status` warns. Harmless for this repo.
- Admin replies can't carry attachments yet (customers can attach on `/konusma`).
- At go-live: change the Resend webhook endpoint and `APP_URL` to the real domain (links in already-sent test emails point at workers.dev).
- `/satis-kosullari` says an expired download link can be renewed "siteden" and links to `/`; point it at `/indir` in Phase 4.
- `/gizlilik` promises an unsubscribe link at the bottom of guide-update emails — must be implemented in Phase 4.
- `test:layout` runs locally only (needs Chrome + running dev server); not in CI.

## Open questions

—

## Next step

Phase 3 (email) — before it: domain, DNS permission on the token, Resend account + API key, MX approval.
