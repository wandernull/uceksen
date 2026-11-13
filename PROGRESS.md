# PROGRESS

> Maintained by the agent. First action of every session: read this file. Update it at the end of every phase.
> When the user returns after a break, this file tells them where things stand.

**Last updated:** 2026-11-13 (live)
**Active phase:** 9 — Go live
**Status:** 🟢 **LIVE on https://uceksen.com since 2026-11-13** (production Worker `uceksen-production`, `main` @ `e95494e`, incl. Phase P). First live order (free, via code) delivered. Remaining post-switch steps under "Blocked on user". Next build phase: 7.

---

## Phases

| | Phase | Status | Commit |
|---|---|---|---|
| 0 | Skeleton | ✅ | `8b74e18` |
| 1 | Static pages | ✅ | `bbdf3c0` |
| 2 | Form and admin | ✅ | `7aadf1b`, `94b5749` (Access) |
| 3 | Email | ✅ | `99a3b9d` |
| 4 | Guide sales | ✅ | `3ecf790`, `a6c96d5`, `b6f0e4b` (₺ font) |
| 5 | Booking (without Google) | ✅ | see `git log --grep 'phase 5'` |
| 6 | Google Calendar | ✅ | `92ebc3c` (live test on staging passed 2026-11-11) |
| 7 | Intake, reminders, summary | ⬜ | — |
| 8 | Cleanup and resilience | ⬜ | — |
| 9 | Go live (prep list for the user, then the switch) | ✅ live 2026-11-13 (first live order delivered; remaining user checks under "Blocked on user") | `4991fad` |
| 10 | Environment split (was "S"): `staging` branch → staging, `main` → production Worker | ✅ | `9ac82e7`…`efd0b0c` |
| 11 | Promo codes (was "P") (Stripe) from admin, sent via the admin email flow | ✅ live 2026-11-13 (staging test passed: 100% code → €0 guide order delivered) | `e95494e` |

**Revised order (user decision 2026-11-13):** S → 9 → P → 7 → 8. Table rows are in that order. After Phase 8 everything is a new feature on live.

Status markers: ⬜ not started · 🔄 in progress · ⏸ blocked on user · ✅ done

---

## Currently working on

**Phase S — environment split** (2026-11-13), on branch `staging`:
- `wrangler.toml`: top level = staging Worker `uceksen` (unchanged resources, `staging.uceksen.com`, `REPLY_LOCAL = "staging"`); `[env.production]` = Worker `uceksen-production` with its own D1 `uceksen-db-production` (`5baf8445-…`), KV `b37ebc7f…`, R2 `uceksen-files-production`, `ENVIRONMENT = "production"`, `APP_URL = https://uceksen.com`, `REPLY_LOCAL = "merhaba"`, `routes = []` (explicit: routes are inherited otherwise and production would take `staging.uceksen.com`), `workers_dev = false`. Sandbox price ids until go-live.
- CI: push to `staging` → tests → staging migrations → deploy top level; push to `main` → same with `--env production`. GitHub environments `staging` / `production`.
- Inbound: both environments share `reply.uceksen.com`; `isForThisEnvironment` makes staging keep only `staging[+token]@` mail and production everything else except staging's. Tests added (190 total).
- Production D1 migrated (0001–0006, settings row present). Production secrets set: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, `ENCRYPTION_KEY` (new random), `ADMIN_EMAILS` (`gizem=gizemderinkok@gmail.com,baran=bbartu.demirci@gmail.com`, copied from `.dev.vars`). `STRIPE_SECRET_KEY` = restricted live key "uceksen worker" (Checkout Sessions, Charges and Refunds, Invoices — all write; `STRIPE_LIVE_KEY_UCEKSEN` in creds), set 2026-11-13. `RESEND_INBOUND_SECRET` from production Resend webhook `860977ab-9a52-4499-981a-ea5c532e42b6` → `https://uceksen.com/api/webhooks/resend` (`email.received`), set 2026-11-13. `DEV_EMAIL` not needed in production.
- **Stripe live mirrored 2026-11-13** (account `acct_1UZRHAJ8zQ8f9hgO`, via the temporary setup key `STRIPE_LIVE_SETUP_KEY_UCEKSEN`): products `prod_VcV7JXVd3LzsqI` (Rehber, `txcd_10302000`, €15 `price_1UbG6xJ8zQ8f9hgOL394U2IP`) and `prod_VcV7fPkwd1ZZhl` (Durum Analizi, `txcd_20060048`, €100 `price_1UbG6xJ8zQ8f9hgOO4vxy0kK`), both inclusive; tax settings inclusive + default `txcd_10302000`; NL registration `taxreg_1UbG6wJ8zQ8f9hgO1BsMHr39` (standard, small_seller, as sandbox); webhook `we_1UbG7FJ8zQ8f9hgOdwJp6GYq` → `https://uceksen.com/api/webhooks/stripe` (2 events), secret set as production `STRIPE_WEBHOOK_SECRET`. Live price ids in `[env.production.vars]`. Branding done by the user; Radar Lite; Stripe Tax on. Sandbox consultation description fixed (had lost its "+").
- Note: test conversations on staging made before the split have `merhaba+…` reply addresses; replies to those now go to production's side, not staging.

**Phase P — promo codes (2026-11-13, live in production via merge `e95494e`).**
- `/admin/kodlar` ("Kodlar" in the admin nav): create a code (own or generated 8-char code; percent 1–100 or €1–200; Rehber / Durum Analizi / both; optional total use limit; optional last day, valid to the end of that day in `host_tz`), list active codes (from Stripe, `metadata.project = uceksen`), "Kapat" deactivates. Stripe holds everything: one coupon (`duration=once`, `applies_to.products`, name = "%N indirim"/"€N indirim", shown at Checkout) + one promotion code per code. Nothing in D1.
- Conversation page: "İndirim kodu gönder" picks an active code and sends a ready Turkish email through the normal admin send (thread, signature, DEV_EMAIL guard) with the Rehber link and/or the conversation's payment link.
- Checkout: `allow_promotion_codes` on both products. A 100% code gives a €0 order that Stripe completes with `payment_status = no_payment_required` (no payment intent): `isSettled` treats that as paid only when `amount_total = 0`, so the guide is delivered and the consultation booked. Cancelling a free booking refunds nothing (`refund_status` NULL; email: "ücretsiz olduğu için iade edilecek bir tutar yok").
- New vars `STRIPE_PRODUCT_GUIDE` / `STRIPE_PRODUCT_CONSULT` (sandbox ids on staging, live ids in production). Stripe API version on both accounts is `2026-10-28.endive`: promotion codes take `promotion[type]=coupon&promotion[coupon]=…` (the old `coupon` param is rejected).
- Verified against real Stripe: sandbox create/list/deactivate; live 100%-off session with automatic tax + invoice + terms consent → total 0 (probe objects removed).
- **Open:** live restricted key "uceksen worker" can read promotion codes but lacks **Coupons: Write** (checked 2026-11-13) — creating codes in production fails until the user adds it (and Promotion Codes: Write). No redeploy needed.
- **Found 2026-11-13:** the Stripe sandbox had lost its Terms of service URL (every staging checkout failed); the user set it again the same day. Staging test passed: `DENEME100` (sandbox, 100%, both products, 10 uses) → €0 guide order delivered.

## Blocked on user

Production post-switch steps (Phase 9 B4 + C), state 2026-11-13:
1. ✅ Guide PDF uploaded in production (`v1.0`, current).
2. ✅ Live guide order with a 100% code (`TEST5NVRD2`, 2 uses, expires 2026-11-20; created via the setup key): €0 purchase #1 recorded, delivery email sent without `[TEST]`. **Close the code at `/admin/kodlar` after testing.**
3. ⬜ Working hours + rules at `/admin/takvim` (production).
4. ⬜ Gizem connects Google (`gizemderinkok@gmail.com`) in production; check booking calendar "Üç Eksen" + busy calendars.
5. ⬜ Real paid tests: guide €15 → refund in Stripe; consultation → booking → Meet event + `.ics` → cancel (>48 h) → automatic refund; contact form → admin reply → email reply lands in the production thread; link preview.
6. ⬜ Live Stripe key "uceksen worker": add **Coupons: Write** + **Promotion Codes: Write** (creating codes from `/admin/kodlar` in production fails until then).
7. ⬜ Delete the Stripe setup key (dashboard + `STRIPE_LIVE_SETUP_KEY_UCEKSEN` in creds) once 6 is done and no more API setup is needed.

Google preparation (done 2026-11-10): GCP project `uceksen` under `baran@botelabs.io`, Calendar API on, consent screen External + **In production** (unverified; fine for one user), scopes `calendar.events`, `calendar.freebusy`, `calendar.calendarlist.readonly`, no logo (a logo forces verification). Authorized domains `uceksen.com` + `gizemderinkok.workers.dev`; homepage/privacy/terms links point at `uceksen.com`. Web client `uceksen-web` with redirect URIs for workers.dev, `uceksen.com` and `localhost:8787` (`/admin/google/callback`). Client id/secret in `~/.gizem-creds` (`GOOGLE_CLIENT_ID_UCEKSEN`, `GOOGLE_CLIENT_SECRET_UCEKSEN`) → `.dev.vars` + Worker secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; `ENCRYPTION_KEY` generated separately for local and the Worker. "Üç Eksen" calendar created; Baran's calendar shared free/busy with Gizem.

Not blocking, for later:
- Set real working hours at `/admin/takvim` (staging has none, so the booking page shows "boş saat yok").
- Upload the real guide PDF at `/admin/rehber` (version e.g. `1.0`, "güncel yap" on). The deployed site currently sells placeholder version `0.1`.
- Accountant: 9% vs 21% NL VAT for the guide (currently tax code `txcd_10302000`, e-book, 9%).

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
| 9 | Stripe account (isolated, KYC) | ✅ live `acct_1UZRHAJ8zQ8f9hgO` activated 2026-11-13; sandbox "Üç Eksen sandbox" `acct_1UZRHhJguQXFmVyO` used for the build |
| 10 | Stripe test key | ✅ full sandbox secret key (user's choice over restricted) in `~/.gizem-creds` as `STRIPE_SECRET_KEY_UCEKSEN` → `.dev.vars` + Worker secret `STRIPE_SECRET_KEY` |
| 11 | Guide PDF | ✅ v1.0 uploaded in production via `/admin/rehber` |
| 12 | GCP project + OAuth client | ✅ 2026-11-10, see "Blocked on user" |
| 13 | "Üç Eksen" calendar | ✅ in `gizemderinkok@gmail.com`; chosen after connecting |

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
- Staging on `staging.uceksen.com` since 2026-11-11 (workers.dev still answers); `uceksen.com` itself has no A/CNAME until go-live.

**Phase 3 — Email code (2026-11-08, done; real-mailbox test passed)**
- `src/lib/mail.ts`: Resend client; **DEV_EMAIL guard inside `sendMail`** (every recipient → DEV_EMAIL unless `ENVIRONMENT === "production"`, intended recipients written at the top of the body, subject prefixed `[TEST]`; no DEV_EMAIL ⇒ nothing is sent).
- Outgoing: message row written first (`send_status` pending → sent/failed), then sent. Subject `<conversation subject> — Üç Eksen`, `Re: …` after the first message. `Reply-To: merhaba+<plus_token>@reply.uceksen.com`, `In-Reply-To`/`References` from the conversation's stored Message-IDs, footer link to `/konusma/<reply_token>`. Admin replies are signed with the admin's name.
- Contact form now sends the acknowledgement (quotes the form text) + one admin notification. Email failures never fail the form; a failed message shows "Gönderilemedi" + "Tekrar gönder" in `/admin`.
- `POST /api/webhooks/resend`: Svix signature check (5 min tolerance) → fetch full email from Resend → dedupe by Message-ID → match by In-Reply-To/References (resolving not-yet-known sent Message-IDs on the way), else by plus token → strip quotes (Gmail/Apple/Outlook, EN+TR; raw body kept in `messages.body_raw`) → store, state `ours`, attachments to R2, notify admins. Unmatched → `unmatched_emails` + notification; listed at `/admin/eslesmeyen`.
- `/konusma/<reply_token>`: thread + reply form with attachments (≤5 files, ≤10 MB each, document/image types), honeypot, CSRF origin check, 10 replies/hour/IP, `no-store`, `noindex`, `Referrer-Policy: no-referrer`. Downloads only via the same token, always `Content-Disposition: attachment`.
- `/admin`: reply box, send status + resend, attachments, sender shown when it differs from the contact, customer page link, "Eşleşmeyen" page.
- Migration `0003`: message send/receive columns, `attachments` table, dedupe indexes.
- Resend webhook `2f6b919a-ea32-48e2-8961-5c6015b4cc09` → `https://staging.uceksen.com/api/webhooks/resend` since 2026-11-11 (was workers.dev) (`email.received`). Worker secrets: `ADMIN_EMAILS`, `DEV_EMAIL`, `RESEND_API_KEY`, `RESEND_INBOUND_SECRET`. Changed to the real domain at go-live (see the switch checklist).
- Tests: 99 Worker tests (DEV_EMAIL guard for every environment value, signature accept/reject incl. replay, 13 quote-stripping cases, HTML fallback, matching by header/token/late Message-ID, unmatched, dedupe, attachments, thread headers on admin replies, `/konusma` privacy headers/uploads/CSRF/honeypot/rate limit, admin reply/resend). Tests use a fake Resend and have network access disabled. Mutation-checked: disabling the guard, the signature check or quote stripping fails 11 / 4 / 13 tests. Browser check: 72 checks incl. admin reply (real send to DEV_EMAIL) and customer reply with a file.

**Phase 4 — Guide sales (2026-11-08)**
- Stripe sandbox `acct_1UZRHhJguQXFmVyO`. Stripe Tax: head office Keizersgracht 520H Amsterdam, prices tax-**inclusive**, NL registration (`small_seller`, no OSS). Products (metadata `project=uceksen`):
  - "Üç Eksen — Rehber" `prod_VafcUBOU4v6dXg` / `price_1UZUGsJguQXFmVyOe5dbLWcY` — €15, `txcd_10302000` (e-book) → NL/DE 9%, TR 0%
  - "Durum Analizi" `prod_VafccJ4Zqsasad` / `price_1UZUGtJguQXFmVyOrMb6Nq3j` — €200, `txcd_20060048` → NL/DE 21%, TR 0% (used in Phase 5)
  - Price ids are plain vars in `wrangler.toml` (`STRIPE_PRICE_GUIDE`, `STRIPE_PRICE_CONSULT`).
- Branding: account branding (icon, logo, #3a5a40 / #f4f4f1) set by the user in the sandbox dashboard. Each Checkout session also sets `branding_settings`: display name "Üç Eksen", Source Sans (Source Serif 4 is not offered; PT Serif has no ₺ glyph and Noto Serif draws ₺ like "Ł"), rectangular, the two colours. Brand files: Archivo wordmark + "ÜE" icon (generated, user keeps the originals).
- `POST /rehber/satin-al` (the button on `/rehber` is now a form; GET redirects to `/rehber`): 503 "yakında" while no PDF is current, 20/hour/IP, then Checkout with: price, `automatic_tax`, `consent_collection.terms_of_service=required` + Turkish consent text (terms link + withdrawal-right waiver), `invoice_creation` with the B.V. legal details in the footer, `metadata.project/kind` on the session and the PaymentIntent, `locale=tr`. Success → `/rehber/tesekkurler`.
- `POST /api/webhooks/stripe`: Stripe signature (HMAC-SHA256 hex, 5 min tolerance, several `v1` allowed) → only `checkout.session.completed` / `async_payment_succeeded` with `metadata.project=uceksen`, `kind=guide`, `payment_status=paid`; everything else 200 and ignored. Fulfilment is one D1 batch: upsert contact (existing name kept), new conversation "Rehber siparişin" (state `completed`, source `rehber`), `purchases` (+ invoice id/hosted URL, country, terms consent), `download_tokens` (7 days, 5 downloads), delivery message; then the email is sent (link, rules, amount incl. VAT, invoice link) and admins get "Yeni satış". Idempotent per session id (redeliveries send nothing; a delivery stuck in `pending` is resent).
- Webhook endpoint `we_1UZVhCJguQXFmVyO0PR5sOT1` → `https://staging.uceksen.com/api/webhooks/stripe` since 2026-11-11 (was workers.dev); secret in `.dev.vars` + Worker secret `STRIPE_WEBHOOK_SECRET`.
- `/d/{token}`: GET shows a page (version, size, downloads left, valid until) and does **not** count; the "PDF'i indir" button POSTs, which counts atomically (`UPDATE … WHERE download_count < max_downloads AND expires_at > now`) and streams the current version from R2 (`Content-Disposition: attachment`, `no-store`, `noindex`, `no-referrer`). Expired / used up → 410 page with a link to `/indir`; unknown → 404. Existing tokens serve whichever version is current.
- `/indir`: email form, honeypot, 3/hour/IP **and** 3/hour per address, same answer whether or not the address bought (no enumeration). Sends a fresh token for the latest purchase into that purchase's conversation.
- `/admin/rehber` (new nav item): current version, upload (version label, PDF ≤ 50 MB, `%PDF-` check, unique version, optional "make current"), version list with "Güncel yap" and admin download, sales list (amount, country, downloads, invoice link, link to the conversation), total. "Alıcılara bildir": emails each purchaser once per version (25 per click, claimed in `guide_update_notices` before sending), with a new download link and an opt-out link.
- Opt-out: `/konusma/{reply_token}/abonelik` (GET shows the button, POST toggles `contacts.guide_updates_optout_at`) — fulfils the promise on `/gizlilik`. `/satis-kosullari` "siteden" now links to `/indir`.
- Migration `0004`: purchase → conversation link, invoice id/url, terms flag, token index, `guide_versions.size`, `contacts.guide_updates_optout_at`, `guide_update_notices`.
- Deployed; placeholder PDF `0.1` uploaded to R2 (`guide/0.1-placeholder.pdf`) and set current on remote D1.
- **Live sandbox test (2026-11-08):** `/rehber` → "Satın al" → branded Turkish Checkout (tax €1.24 = 9% for NL shown) → test card 4242 → `/rehber/tesekkurler`; webhook delivered and verified; purchase row (NL, terms accepted, invoice URL), delivery email sent to DEV_EMAIL; `/d/{token}` page showed 5 left, POST returned the identical PDF, page then showed 4.
- Tests: 125 Worker tests (26 new: signature accept/reject/replay, Checkout params, closed-without-PDF, Stripe down, unsigned/foreign/unpaid events, fulfilment + email, idempotency, failed email, repeat buyer + reply threading, GET doesn't count, 5 downloads then 6th rejected, parallel last download, expired, unknown, new version served, `/indir` send/unknown/IP limit/address cap/honeypot, upload validation, update notices once + opt-out, admin page). Mutation-checked: disabling the Stripe signature check or the download limit fails 2 tests each. Browser check: 103 checks incl. admin upload → signed webhook → `/d/` download, new pages at 320–1280px light/dark (fixed: admin nav overflowed 6px at 320px with the new item — now wraps).

**Phase 5 — Booking, without Google (2026-11-08)**
- Flow (as decided 2026-11-07): contact form → conversation → admin clicks **"Ödeme bağlantısını gönder"** in `/admin/konusma/{id}` (standard signed email with `/konusma/{reply_token}/odeme`, state `theirs`, `consult_offered_at` set) → that page (only exists once offered; forwards to the booking page if already paid) → Stripe Checkout €200 (`kind=consult`, `conversation_id` in metadata, email prefilled, terms consent, invoice, Turkish) → webhook **or** the success page `/odeme/tamam?oturum=…` (asks Stripe itself if the webhook is late; both idempotent) → `booking_intents` row (60 days, payment intent, amount in EUR, invoice URL) + email with `/randevu/{token}`, conversation `awaiting_booking`, admins notified.
- `/randevu/{token}`: slots in the customer's zone (`randevu.js` switches to the browser's zone on first visit; zone selectable; host zone without JS), grouped by week (first week open). Booking = one SQL statement (`INSERT … SELECT … WHERE NOT EXISTS overlapping live booking incl. buffers`) + the unique index as the final lock; on conflict 409 "Bu saat az önce doldu". Then intent `used_at`, conversation `theirs`, confirmation email with `.ics` attachment, admin notification. Booked page shows date/zone/duration, `.ics` download, change link.
- `/randevu/{token}/degistir`: reschedule while > 24 h ahead and < 2 times (same booking row, `state=rescheduled`, `reschedule_count+1`, own slot excluded from conflicts; email with updated `.ics`); cancel (checkbox) → slot freed first, then Stripe refund (idempotency key per booking) if > 48 h ahead; < 48 h: no refund (`not_eligible`). Failed refund → `refund_status=failed`, conversation back to `ours`, admins get "İADE BAŞARISIZ". Cancellation email carries a `STATUS:CANCELLED` `.ics`.
- Admin: conversation page has a "Durum Analizi" section (payment, booking in host + customer zone, state, refund, customer link, **"İptal et ve tam iade yap"** — admin cancellations always refund). `/admin/takvim` (new nav item): upcoming bookings, preview of open slots, weekly hours (add/delete, duplicates ignored), exceptions (closed day/range, extra opening), settings (host zone, start times, notice, horizon, buffers, max per week).
- Slots (`src/lib/slots.ts`, pure, Luxon): rule windows + extra openings in `host_tz`, fixed start times, whole 90 min must fit, minus blocks, minus live bookings and (Phase 6) Google busy time each widened by the buffers (15 before / 30 after), min notice 48 h, horizon 45 days, max 3 per ISO week (host zone). Times that don't exist on a spring-forward day are skipped; the repeated hour in autumn is offered once.
- `.ics` (`src/lib/ics.ts`): `METHOD:PUBLISH`, `ORGANIZER;CN=Üç Eksen:mailto:merhaba@uceksen.com`, no ATTENDEE, UTC times, UID `booking-{id}@uceksen.com`, SEQUENCE = reschedules (+1 on cancel), 30-min alarm, CRLF, 75-octet folding (UTF-8 safe), RFC escaping. Built when the email is sent, so a resend carries the current state. Meet link goes into LOCATION/DESCRIPTION once Phase 6 fills `meet_url`.
- Email attachments added to `sendMail` (Resend `attachments`); `messages.booking_id` marks emails that carry the `.ics`.
- Migration `0005`: `bookings` rebuilt — `start_utc` UNIQUE now a **partial unique index over live bookings** (`confirmed`, `rescheduled`) so a cancellation frees the slot; cancel/refund columns; payment columns on `booking_intents`; `conversations.consult_offered_at`; `messages.booking_id`.
- Shared CSS: `.facts`, `.btn-small` moved from `admin.css` to `site.css` (customer pages use them); selects/date/time/number inputs styled like text inputs.
- **Live sandbox test (2026-11-08):** payment page → Checkout (€200, NL VAT €34,71 shown, email prefilled) → test card → success page → `/randevu/…?tz=Europe/Amsterdam` (browser zone) → booked → cancelled > 48 h ahead → Stripe sandbox refund €200 `succeeded`; three emails sent to DEV_EMAIL. Temporary hours removed afterwards.
- Tests: 158 Worker tests (32 new): slot rules, window fit, horizon, blocks/extras, buffers at the exact boundary, max per week, host_tz change keeps booked instants, **DST spring-forward and fall-back (Europe/Amsterdam 2026)**, display across zones with different DST dates; `.ics` structure/folding/escaping/sequence; payment gating + Checkout params, webhook + success-page fulfilment, idempotency, slot listing per zone, booking + `.ics` email, **three concurrent requests for one slot → exactly one wins**, unavailable/expired, reschedule ×2 limit, old slot freed, cancel > 48 h refund / < 48 h none / < 24 h no reschedule, failed refund, admin cancel, DB lock incl. cancelled rows, `/admin/takvim` validation. Mutation-checked: removing the DST gap check, the busy/booking check, max-per-week, the refund window or the reschedule limits fails 1 / 11 / 1 / 1 / 2 tests. Browser check 126 checks incl. hours → payment link → paid webhook → pick slot → change page.

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
- **2026-11-07 — Single Google calendar:** the "Üç Eksen" calendar in `gizemderinkok@gmail.com`. OAuth is done with that account. ~~freebusy queries that account's calendars only~~ — superseded 2026-11-10: busy calendars are selectable and include Baran's (shared free/busy with Gizem), as SPEC §5.5 intended.
- **2026-11-07 — Guide price is €15 permanently.** SPEC §1 "€29 from December" dropped. One Stripe price.
- **2026-11-07 — Mailbox must stay possible later.** Planned for Phase 3: inbound threading (Reply-To `merhaba+{token}@…`) goes to a dedicated subdomain (e.g. `reply.uceksen.com`) with its own MX to Resend, so the root domain's MX can later be moved to a real mailbox provider without breaking conversation threading. Confirm with user at start of Phase 3.
- **2026-11-07 — Replies go to `merhaba+{plus_token}@reply.uceksen.com`** (SPEC §5.2 said `merhaba+…@uceksen.com`). The root MX belongs to Cloudflare Email Routing, so Resend receives on a dedicated subdomain. A future mailbox on the root never breaks threading. Direct mail to `merhaba@uceksen.com` is forwarded by Email Routing, not ingested.
- **2026-11-07 — Resend in the EU region** (GDPR; customer data stays in the EU).
- **2026-11-08 — Plain-text emails only.** Simple, threads and quotes cleanly everywhere; matches the plain tone. HTML can be added later.
- **2026-11-08 — Plus token is lower-case base32 (32 chars, 160 bits)** instead of base64url: mail systems may change an address's case. `reply_token` (URL) stays base64url.
- **2026-11-08 — Message-ID is SES's, not ours.** Resend ignores a custom `Message-ID`; the real one is fetched from Resend after sending (and lazily before threading/matching).
- **2026-11-08 — One notification email to all admins** (not one per admin), so outside production it is a single test email.
- **2026-11-08 — Email attachments are stored in R2 too** (SPEC only required them on the web path); >10 MB ones are skipped (still in Resend).
- **2026-11-08 — Stripe: one NL B.V. account (Back of the Envelope B.V.) sells under the "Üç Eksen" brand** for NL, DE and TR customers. Stripe Tax with the NL registration in `small_seller` mode; no OSS and no Turkish KDV registration until the thresholds are reached (user's decision). Guide e-book code (9%) pending the accountant's confirmation.
- **2026-11-08 — Full sandbox secret key instead of a restricted key** (user's choice for the build; SPEC §7 asked for restricted). Go-live should use a restricted live key.
- **2026-11-08 — Stripe invoices on** (`invoice_creation`), legal details in the invoice footer from code; brand name "Üç Eksen" on Checkout via per-session `branding_settings`.
- **2026-11-08 — PDF streamed through the Worker instead of a presigned R2 URL** (SPEC §5.3). Presigning needs separate R2 S3 credentials; streaming keeps the file without any public URL and lets the Worker set the download headers.
- **2026-11-08 — `/d/{token}` GET shows a page; only the button (POST) counts a download** (SPEC said GET counts). Mail scanners and link previews open links with GET and would use up the 5 downloads.
- **2026-11-08 — Every purchase gets its own conversation** (SPEC §4 has only `purchases.contact_id`): the delivery email threads like any other, a customer's reply ("dosya açılmıyor") lands in `/admin`, and `/indir` / update emails go into the same thread. State `completed`, so sales don't crowd "Sıra bizde"; a reply moves it to `ours`.
- **2026-11-08 — Adaptive Pricing is on (Stripe default):** TR visitors see and pay in TRY (e.g. ₺871,73 for €15), Stripe converts. Sales are booked in EUR from `currency_conversion`; the delivery email shows what the customer paid. Open question to the user: keep lira for TR buyers or force EUR.
- **2026-11-08 — Buying is a POST form**, not a link: crawlers following links would otherwise create Checkout sessions.
- **2026-11-08 — `/indir` is also limited per email address** (3/hour), on top of SPEC's 3/hour/IP, so nobody can flood a purchaser's inbox from many IPs.
- **2026-11-08 — Admin logout (user request):** "Çıkış" in the admin nav links to `/cdn-cgi/access/logout`, which Cloudflare Access handles on our hostname (not the Worker): it deletes the app cookie and revokes the Access session (old tokens rejected within ~30 s), then shows Cloudflare's logged-out page. The next `/admin/` visit asks for a new one-time PIN. Locally (no Access) the link has nothing behind it.
- **2026-11-08 — Theme switch (user request, between Phases 5 and 6):** icon button at the end of the nav on every page (static, customer, admin) cycles Otomatik → Açık → Koyu. Default follows the OS; the choice is kept per browser in `localStorage` (`uceksen-theme`) and applied from `/theme.js` in `<head>` before first paint, via the design's existing `[data-theme]` override (no colour changes). Hidden without JavaScript.
- **2026-11-08 — Booking lock is a partial unique index** (`start_utc` unique among `confirmed`/`rescheduled`), not a plain column UNIQUE: otherwise a cancelled booking would block its slot forever. Bookings are inserted with a single `INSERT … SELECT … WHERE NOT EXISTS` that also enforces the buffers, so no read-then-write gap.
- **2026-11-08 — Admin opens the payment step per conversation** (`consult_offered_at`); the link `/konusma/{reply_token}/odeme` creates a fresh Checkout session on each click (sessions expire after 24 h; the emailed link does not).
- **2026-11-08 — Success page fulfils too** (`/odeme/tamam?oturum=…` asks Stripe for the session if the webhook hasn't arrived), so the customer lands on the booking page right after paying. Idempotent per session.
- **2026-11-08 — Booking via `POST /randevu/{token}`** (SPEC said `POST /api/randevu`): plain form, works without JavaScript; same lock semantics.
- **2026-11-08 — Rescheduling keeps the booking row** (state `rescheduled`, count +1); the `.ics` keeps its UID and raises SEQUENCE so calendars move the event.
- **2026-11-08 — Reschedule/cancel rules from `/satis-kosullari`:** reschedule while > 24 h ahead, max 2; cancel any time before the start, refund only > 48 h ahead (customer) or always (admin). The terms' "< 48 h: one free reschedule" is covered by the general reschedule rule.
- **2026-11-08 — Weekday numbering 0 = Monday … 6 = Sunday** in `availability_rules` (SPEC left it open).
- **2026-11-08 — A paid consult session without a matching conversation** is acknowledged and reported to admins ("Eşleşmeyen Durum Analizi ödemesi"), not retried.
- **2026-11-08 — Update notices go out in batches of 25 per click** (Worker subrequest limits), tracked per version and contact so nobody gets one twice.

- **2026-11-10 — Busy calendars are chosen in `/admin/takvim`.** Default after connecting: Gizem's main calendar + people's calendars shared with her (personal addresses, e.g. Baran's); not holidays/subscriptions/secondary calendars. A calendar shared but never added to her list can be added by address. The booking calendar itself is never "busy": bookings are counted from the database.
- **2026-11-10 — Google unreadable → no slots (fail closed).** If Google is connected but freebusy fails (outage, revoked grant, a calendar no longer shared), customers see "Takvimi şu an kontrol edemiyoruz" and booking is refused, rather than risk booking over a private appointment. Admins get one alert per 6 hours. Not connected at all → slots from hours only (Phase 5 behaviour).
- **2026-11-10 — Google failure never loses a booking.** The DB booking stands; `bookings.gcal_status = failed` + admin notice; the confirmation says the link will follow. "Tekrar dene" on the conversation page re-syncs and, if that creates the Meet link, emails it to the customer with an updated `.ics`.
- **2026-11-10 — Our own Google event ids** (`uc…`, base32hex) are written to the booking before the insert, so a retry cannot create a second event (409 → patch). Reschedule patches the same event (Meet link unchanged); cancel deletes it. Every write uses `sendUpdates=none`, no attendees.
- **2026-11-10 — Redirect URI derived from `APP_URL`** (`{APP_URL}/admin/google/callback`) instead of a `GOOGLE_REDIRECT_URI` variable (SPEC §6). The callback is under `/admin`, so Cloudflare Access protects it; OAuth state is one-time, 10 min, bound to the admin, plus PKCE.
- **2026-11-10 — Access token cached in KV, encrypted** (AES-GCM, separate purpose from the refresh token). Ciphertexts bind their purpose as AAD. Losing/rotating the Worker's `ENCRYPTION_KEY` means reconnecting Google once.
- **2026-11-10 — GCP project lives in `baran@botelabs.io`** (user's choice). Only Gizem sees the consent screen (support email shown there); customers never see anything from Google.

- **2026-11-10 — Consultation €100 (was €200); launch prices, no strikethrough.** User asked for crossed-out "was" prices (~~€30~~ €15, ~~€200~~ €100). Not done: under the EU Price Indication Directive art. 6a (Omnibus, ACM in NL) a crossed-out price must be the lowest price actually charged in the previous 30 days, and neither was ever charged. Instead (user's choice): "Lansman fiyatı. 1 Şubat 2027'den itibaren €30 / €200" under the price on `/rehber`, `/danismanlik`, the payment page and the terms. The home page shows no prices. Sandbox consult price now `price_1UaLI4JguQXFmVyOT5C8HrYe` (€100, inclusive); the €200 price is archived.

- **2026-11-13 — Promo codes live in Stripe only, no D1 table.** Stripe already stores redemptions, limits and expiry; a copy would drift. Codes are scoped to products via coupon `applies_to`, single use per order (`duration=once`). €0 orders are accepted only as `no_payment_required` with a zero total.
- **2026-11-13 — Went live.** Switch done by A after the user's go: production Resend webhook `860977ab-…` + secret, `uceksen.com` route on `[env.production]`, fast-forward merge `staging` → `main` (`4991fad`), CI deployed production. Checks passed: `/health` production + DB, all public pages/sitemap/llms.txt/og.png 200, robots.txt production rules + sitemap, `/admin/` → Access login, both webhooks 401 unsigned, www → apex 301, staging still healthy. Guide purchase answers 503 until a guide version exists in production (intended).
- **2026-11-13 — Production `routes = []` explicit; no `www` on the Worker.** Wrangler inherits top-level routes into environments, which would move `staging.uceksen.com` to production. `www` is redirected by a Cloudflare redirect rule, not served by the Worker (static assets would otherwise be served twice, and `/admin` on `www` is outside Access).
- **2026-11-13 — Separate staging and production; revised phase order (user decision).** Reverses the 2026-11-07 single-deployment decision: going live while Phases 7–8 continue needs a place to test that isn't production. Branches: work goes to `staging` (deploys staging); `main` gets merges from `staging` only with the user's green light (deploys production on `uceksen.com`). Order: S (split) → 9 (go live) → P (promo codes) → 7 → 8; afterwards everything is a new feature on live. Phase commits now land on `staging` and reach `main` by merge.
- **2026-11-12 — DEV_EMAIL guard temporarily off on staging (user decision, overriding CLAUDE.md).** `MAIL_GUARD = "off"` in `wrangler.toml`; honoured only for exactly `ENVIRONMENT=staging`. Staging emails now go to the real recipients, so any address typed into a form or used in a test purchase gets real mail. Restore: delete the line and push. **Restored the same day** (`MAIL_GUARD = "on"`); the switch stays for future use.
- **2026-11-11 — Staging on `staging.uceksen.com` (user request).** Worker custom domain instead of workers.dev, so testing uses the real zone; workers.dev kept on as a fallback until go-live. Still one deployment: going live is config (`APP_URL`, `ENVIRONMENT`, routes) plus Access/webhooks, not a new Worker. Google connected with Baran's account on staging so testing doesn't wait on Gizem; swapped at go-live. The Google connect hint is now the signed-in admin's own address (was always Gizem's).
- **2026-11-10 — SEO / AI-agent pass (pulled forward from Phase 8's robots/sitemap).** Every public page: Turkish meta description, canonical + Open Graph/X tags pointing at `https://uceksen.com` (never workers.dev), JSON-LD (Organization with legal name/VAT, WebSite; Product+Offer €15 on `/rehber`, Service+Offer €100 on `/danismanlik`, VAT included, `priceValidUntil` 2027-01-31). New titles for `/`, `/rehber`, `/danismanlik` (h1s unchanged). `robots.txt`/`sitemap.xml` from the Worker: outside production `Disallow: /` (staging must not be indexed); production hides token/admin paths, names the sitemap, AI crawlers allowed. `llms.txt` (Turkish summary, products, prices; `src/content/llms.txt`, served by the Worker with `charset=utf-8` — as a static asset it went out without a charset and showed mojibake). Share image `og.png` + favicon/app icons rendered by `scripts/render-brand.mjs` from the site fonts and colours.

## Phase 9 — go-live checklist (two Workers, from Phase S)

Production = Worker `uceksen-production` (branch `main`), already created with its own D1/KV/R2 and most secrets. Staging stays as it is. **U** = user, **A** = agent.

**A. User prep (any time before the switch)**
1. ✅ (2026-11-13) **Stripe live** (`acct_1UZRHAJ8zQ8f9hgO`, activated), dashboard-only settings: public details (name "Üç Eksen", support email `merhaba@uceksen.com`, support URL `https://uceksen.com`, terms `https://uceksen.com/satis-kosullari`, privacy `https://uceksen.com/gizlilik`), branding (icon/logo/colours as in sandbox), statement descriptor `UCEKSEN.COM`, customer emails (recommended: Stripe receipts off), Adaptive Pricing on/off.
2. ✅ (setup part done 2026-11-13, see Currently working on) **Stripe live keys** into `~/.gizem-creds` (never pasted in chat):
   - `STRIPE_LIVE_SETUP_KEY_UCEKSEN` — a full secret key (or restricted with Products/Prices/Tax settings/Tax registrations/Webhook endpoints write), used **once by A** to mirror the sandbox: products + prices (€15 guide `txcd_10302000`, €100 consultation `txcd_20060048`, inclusive), Stripe Tax settings (head office, inclusive, default code) + NL registration, webhook endpoint `https://uceksen.com/api/webhooks/stripe` (2 events) → A sets `STRIPE_WEBHOOK_SECRET`. U can roll/delete it afterwards.
   - `STRIPE_LIVE_KEY_UCEKSEN` — the **restricted** key the Worker uses: Checkout Sessions write, Refunds write, Invoices read, nothing else → A sets `STRIPE_SECRET_KEY --env production`.
3. ✅ **Cloudflare Access** (2026-11-13): hostnames `uceksen.com/admin` and `www.uceksen.com/admin` added to app `uceksen`.
4. ✅ **www** (2026-11-13, by A via API after the user extended the token): DNS `www` AAAA `100::` proxied (placeholder) + redirect rule "Redirect from WWW to root" (`http_request_dynamic_redirect` entrypoint, 301 to `https://uceksen.com` + path, query kept). Verified. The Worker does not serve `www`.
5. **Google**: nothing to prepare. Redirect URI `https://uceksen.com/admin/google/callback` is registered; Gizem's "Üç Eksen" calendar exists.
6. **Resend**: nothing (A creates the production inbound webhook at the switch). Check the plan covers volume: free = 100/day, 3,000/month, shared by both environments.
7. **GitHub** (optional): repo → Settings → Environments → `production` → required reviewer = you, so a merge to `main` waits for one click before deploying.

**B. Switch (one sitting, ~30 min)**
1. **A** — mirror Stripe (A2), set both Stripe secrets; live price ids into `[env.production.vars]`; uncomment `routes` (`uceksen.com`) in `[env.production]`.
2. **A** — create the Resend webhook `https://uceksen.com/api/webhooks/resend` (`email.received`) → `RESEND_INBOUND_SECRET --env production`.
3. **U** — green light → A merges `staging` → `main` → CI deploys production on `uceksen.com` (custom domain creates DNS + certificate; existing MX/TXT stay).
4. **U** — on `https://uceksen.com/admin/`: upload the real guide PDF (`/admin/rehber`), set working hours/rules (`/admin/takvim`), Gizem connects Google (`gizemderinkok@gmail.com`), check booking + busy calendars. (Production D1/R2 start empty; nothing from staging carries over.)
5. **A** — backup of production D1 to R2 once data exists (Phase 8 job or manual export).

**C. Checks right after**
1. **A** — `/health` → `"environment":"production"`; robots.txt allows + sitemap; `/admin/` asks for Access; webhooks reject unsigned requests.
2. **U** — real guide purchase → delivery mail + download → refund in Stripe.
3. **U** — real consultation purchase → booking → Meet event in Gizem's calendar, `.ics` to the customer, nothing from Google → cancel (>48 h) → automatic refund.
4. **U** — contact form → admin reply → reply by email lands in the thread (production), not in staging.
5. **U** — share `https://uceksen.com` in WhatsApp/X: preview image shows.

**D. Later, not blocking**
- Cloudflare zone: AI-crawler / managed robots.txt settings, "Always use HTTPS".
- Google Search Console: verify `uceksen.com`, submit `sitemap.xml`.
- Remove the workers.dev hostname from Access and the workers.dev redirect URI from the Google client; staging can drop `workers_dev` too.
- 1 Feb 2027: launch prices end (see Known issues).

## Known issues

- Gmail threads staging `[TEST] …` mails and production mails with the same subject into one conversation, labelled with the first subject; open the thread to see the newest mail. (`DEV_EMAIL` is the same inbox as the admins'.)


- `GH_TOKEN` lacks the `read:org` scope; `gh auth status` warns. Harmless for this repo.
- Admin replies can't carry attachments yet (customers can attach on `/konusma`).
- Links in test emails sent before 2026-11-11 point at workers.dev (still works while `workers_dev = true`).
- Update emails carry the opt-out link in the body only (no `List-Unsubscribe` header yet).
- `max_per_week` is checked when slots are listed, not inside the booking statement: two people booking the last two free places of a week at the same moment could exceed it by one. Same-slot double booking is impossible.
- The customer joins Meet without being invited, so Gizem has to admit them ("ask to join"). Intentional: inviting would make Google email the customer.
- Intake form link in the confirmation email comes with Phase 7.
- **Go-live (Phase 9), Stripe — sandbox settings do not carry over to live:** activate the live account (KYC, bank), public details (incl. terms-of-service URL, support email), branding (icon, logo, colours), Stripe Tax (head office, inclusive default, NL registration), create both products/prices and put the live price ids in `wrangler.toml`, live webhook endpoint for `https://uceksen.com/api/webhooks/stripe` (same two events) → `STRIPE_WEBHOOK_SECRET`, restricted live key → `STRIPE_SECRET_KEY` (user installs both). Decide whether Stripe also emails its own receipt/invoice (our delivery email already links the invoice).
- **1 February 2027: the launch prices end — also update the JSON-LD offers (`priceValidUntil`, prices) and `src/content/llms.txt`.**
- **1 February 2027: the launch prices end — raise them for real** (new live Stripe prices €30 / €200 → `wrangler.toml`; remove the "Lansman fiyatı" notes; terms page). Announcing a future price and not applying it is misleading under consumer law. Moving the date is fine, but do it before it passes.
- Share previews (`og:image`) and canonicals point at `uceksen.com`, which doesn't resolve until go-live: link previews show no image before then. At go-live robots.txt switches to "allow" with `ENVIRONMENT=production`. Cloudflare's managed robots.txt (content signals) is prepended by Cloudflare — check the zone's AI-crawler settings then.
- `test:layout` runs locally only (needs Chrome + running dev server); not in CI.

## Open questions

- Adaptive Pricing: keep local-currency checkout (TRY for Turkish buyers; Stripe adds an FX margin for the buyer) or turn it off (dashboard → Settings → Adaptive Pricing, or per session `adaptive_pricing.enabled=false`)?

## Next step

User: Coupons + Promotion Codes write on the live worker key; post-switch steps (Blocked on user). Then Phase 7 (intake, reminders, summary) on `staging` → Phase 8. `main` only by merge with the user's green light.
