# Üç Eksen — Technical Specification

**Version:** 1.0
**Date:** November 2026
**Domain (placeholder):** `uceksen.com` — replace throughout once the real domain is registered

> Documentation and code are in English. **All user-facing copy is Turkish** — customer pages, emails, form labels, error messages, and the admin interface. See `CLAUDE.md`.

---

## 1. Product

A site that sells two things to Turkish people expanding into Europe, and manages the customer relationship end to end.

| Product | Price | Delivery |
|---|---|---|
| Üç Eksen guide (PDF) | €15 (€29 from December) | Signed download link after payment |
| Durum Analizi (consulting) | €200 | 90-minute call + written summary |

**Core principle: no mailbox.** Nobody uses a personal email address. Every outgoing email is sent from `merhaba@uceksen.com` through Resend; every incoming email arrives via the Resend inbound webhook. The only management surface is `/admin`.

---

## 2. Scope

### In
- Marketing pages (home, guide, consulting, about, privacy, terms)
- Contact form → conversation model
- Two-way email: Resend outbound + inbound, properly threaded
- A unique link where the customer can read and reply to their conversation on the web
- Stripe guide sales, webhook, signed and expiring download links
- Booking module: availability rules, Google Calendar freebusy, slot selection, `.ics`, Meet link
- Pre-call intake form, reminders, written summary delivery
- `/admin`: conversations, sales, bookings, availability, guide versions

### Out (later versions)
- Analytics
- CRM
- VAT automation (Stripe Tax) — not needed below the €10,000 threshold
- Multi-user roles and permissions
- Team / round-robin scheduling

---

## 3. Architecture

**Stack**
- **Cloudflare Workers** — application (API + SSR)
- **Cloudflare Pages or Workers Assets** — static pages
- **Cloudflare D1** — database (SQLite)
- **Cloudflare R2** — PDF storage
- **Cloudflare Access** — `/admin` authentication
- **Stripe** — payments
- **Resend** — outbound and inbound email
- **Google Calendar API** — freebusy, events, Meet links

**Runtime:** TypeScript, Hono (or equivalent), deployed with Wrangler.
**Date/time:** Luxon. Everything stored in UTC, converted using IANA time zone names. No fixed offsets anywhere.

**Environments**

| | Domain | Stripe | Resend | D1/R2 |
|---|---|---|---|---|
| local | `localhost:8787` | test mode | **real** | miniflare (local) |
| staging | `staging.uceksen.com` | test mode | real | separate D1/R2 |
| production | `uceksen.com` | live | real | production D1/R2 |

---

## 4. Data model

```sql
-- People
contacts(
  id, email UNIQUE, name, phone,
  created_at, updated_at
)

-- Conversations
conversations(
  id, contact_id, subject,
  state,              -- new | ours | theirs | awaiting_booking | completed | closed
  reply_token UNIQUE, -- customer's web access
  plus_token UNIQUE,  -- matching key embedded in the reply-to address
  last_message_at, created_at
)

-- Messages
messages(
  id, conversation_id,
  direction,          -- in | out
  body_text, body_html,
  provider_message_id, in_reply_to, references_json,
  author,             -- customer | gizem | baran | system
  created_at
)

-- Incoming mail that matched no conversation
unmatched_emails(
  id, from_addr, to_addr, subject, body_text, raw_json, created_at
)

-- Guide sales
purchases(
  id, contact_id, stripe_session_id UNIQUE, stripe_payment_intent,
  amount_cents, currency, country,
  created_at
)

-- Download tokens
download_tokens(
  id, token UNIQUE, purchase_id,
  expires_at,         -- 7 days after purchase
  max_downloads,      -- default 5
  download_count,
  created_at
)

-- Guide versions
guide_versions(
  id, version,        -- "2.0"
  r2_key, is_current, created_at
)

-- Availability rules
availability_rules(
  id, weekday,          -- 0-6
  start_time, end_time, -- "10:00", "17:00" — in host_tz
  active, created_at
)

-- One-off exceptions
date_overrides(
  id, date, type,     -- block | extra
  start_time, end_time, note
)

-- Paid, but no slot chosen yet
booking_intents(
  id, token UNIQUE, contact_id,
  stripe_session_id UNIQUE,
  expires_at,         -- 60 days
  used_at, created_at
)

-- Bookings
bookings(
  id, conversation_id, contact_id, booking_intent_id,
  start_utc UNIQUE,   -- double-booking lock
  end_utc,
  customer_tz,
  state,              -- confirmed | rescheduled | cancelled | completed | no_show
  meet_url, gcal_event_id,
  intake_json, intake_submitted_at,
  reschedule_count,
  summary_sent_at,
  created_at, updated_at
)

-- System settings (single row)
settings(
  id, host_tz,        -- default "Europe/Istanbul"
  min_notice_hours,   -- 48
  max_horizon_days,   -- 45
  buffer_before_min,  -- 15
  buffer_after_min,   -- 30
  max_per_week,       -- 3
  slot_times_json,    -- ["10:00","14:00","16:00"]
  google_refresh_token,
  google_calendar_id,
  updated_at
)
```

---

## 5. Flows

### 5.1 Contact form

1. Visitor fills in: name, email, phone (optional), situation summary, consent checkbox
2. If the honeypot field is not empty, return 200 silently and store nothing
3. Upsert `contacts` by email, create `conversations`, create the first `messages` row (`direction=in`)
4. Generate `reply_token` and `plus_token` (cryptographically random, 32 characters)
5. Send the customer an acknowledgement email that **quotes back what they wrote in the form** — this makes the email thread complete from message one
6. Notify admin by email

### 5.2 Email in and out

**Outbound (reply from admin)**
- Create a `messages` row (`direction=out`)
- Send via Resend:
  - `From: Üç Eksen <merhaba@uceksen.com>`
  - `Reply-To: merhaba+{plus_token}@uceksen.com`
  - `In-Reply-To` and `References`: the `provider_message_id` of the last message in the conversation
  - Footer line linking to `https://uceksen.com/konusma/{reply_token}`
- Store the returned `message_id` on the row

**Inbound (Resend webhook)**
1. Verify the webhook signature
2. Find the conversation: first by `In-Reply-To` against stored `provider_message_id` values; if that fails, by the `plus_token` in the `To` address
3. If still unmatched → write to `unmatched_emails` and notify admin
4. **Strip quoted text.** Keep the raw body in `raw_json`, store the cleaned version in `body_text`
5. Create a `messages` row (`direction=in`), set `conversations.state = 'ours'`
6. Notify admin

**Reply via web**
- `/konusma/{reply_token}` shows the full conversation and a reply box
- A reply is stored as `messages` (`direction=in`) and handled like an inbound email
- File attachments are accepted on this path and stored in R2

### 5.3 Guide sales

1. `/rehber` → Stripe Checkout (€15, tax-inclusive price). Set `consent_collection.terms_of_service = required` with the terms URL — in the EU the withdrawal-right waiver is only valid with this consent. Add `metadata.project = "uceksen"` to the session.
2. On `checkout.session.completed`:
   - Verify the signature
   - Upsert `contacts`, create `purchases`
   - Create a `download_tokens` row: 7 days, 5 downloads
   - Send the delivery email with the download link and invoice details
3. `GET /d/{token}`:
   - Check the token exists, has not expired, has downloads remaining
   - Find the `guide_versions` row where `is_current`
   - Increment `download_count`
   - Generate a short-lived presigned R2 URL and 302 to it
4. `/indir` — the customer enters their purchase email and receives a fresh token by email. Rate limit: 3 per hour per IP.

**Version updates:** when a new PDF is uploaded and `is_current` is moved, existing tokens serve the new file. An admin action notifies all purchasers.

### 5.4 Consulting and booking

**Order: payment first, booking second.**

1. `/danismanlik` → Stripe Checkout (€200). Same terms consent and `metadata.project`.
2. Webhook → create `booking_intents` (token, valid 60 days)
3. Success URL → `/randevu/{token}` — the same link is also emailed
4. Booking page:
   - Read the customer's time zone from the browser; allow changing it
   - Compute slots (see 5.5)
   - Select a slot → `POST /api/randevu`
5. Server:
   - INSERT into `bookings` with the `start_utc` unique constraint — **this is the lock**
   - On conflict → "that slot was just taken" and refresh the page
   - On success → Google Calendar `events.insert`:
     - Calendar: `settings.google_calendar_id` (the separate "Üç Eksen" calendar)
     - `attendees`: **empty** — Google sends nobody anything
     - `conferenceData.createRequest` → take `hangoutLink`, store in `meet_url`
   - Mark `booking_intents.used_at`
6. Emails:
   - To the customer: confirmation plus a **system-generated `.ics`** (`METHOD:PUBLISH`, `ORGANIZER;CN=Üç Eksen:mailto:merhaba@uceksen.com`, Meet link in both `LOCATION` and `DESCRIPTION`), the intake form link, and the reschedule/cancel link
   - To admin: notification
7. Intake form: 5–6 questions, stored in `intake_json`
8. Reminder 24 hours before (Cron Trigger). If the intake form is empty, remind about it.
9. After the call, admin writes the summary → it lands in the conversation thread and is emailed

**Reschedule / cancel:** `/randevu/{token}/degistir`. Reschedule allowed up to 24 hours before, maximum twice. Cancel with full refund (Stripe refund API) up to 48 hours before; no refund after that. Both update the Google event.

### 5.5 Availability computation

```
candidates = availability_rules (in host_tz) + date_overrides(type=extra)
           ∩ slot_times (fixed start times)
subtract   − date_overrides(type=block)
           − Google freebusy (gizem + baran calendars, single query)
           − existing bookings (state ∈ confirmed, rescheduled)
           − buffers (15 min before, 30 min after)
filter     − anything before now + min_notice_hours
           − anything after now + max_horizon_days
           − weeks where max_per_week is already reached
```

Computed on every page load; never cached.
`settings.host_tz` is changeable from admin. A change **does not affect existing bookings** (they are fixed in UTC); it only affects future slot generation.

### 5.6 Stripe account

This project runs in its **own isolated Stripe account** under the organisation: its own API keys, its own webhook endpoint, its own signing secret. Other brands' events do not reach this account, and vice versa.

No brand-level webhook filtering is therefore required. Two standard rules still apply:

- The handler silently ignores event types it does not recognise and returns `200` (resilience against Stripe adding new event types)
- Products, prices, and checkout sessions carry `metadata.project = "uceksen"` for reporting and any future separation need

The statement descriptor is already correct at account level.

---

## 6. Integrations and environment variables

```
# Cloudflare (bindings in wrangler.toml)
DB                        # D1
BUCKET                    # R2
ENVIRONMENT               # local | staging | production

# Stripe
STRIPE_SECRET_KEY         # restricted key, test mode during the build
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_GUIDE
STRIPE_PRICE_CONSULT

# Resend
RESEND_API_KEY
RESEND_INBOUND_SECRET     # webhook signature verification
MAIL_FROM                 # "Üç Eksen <merhaba@uceksen.com>"
MAIL_DOMAIN               # uceksen.com

# Google
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI

# Application
APP_URL
ADMIN_EMAILS              # comma-separated, matches the Cloudflare Access policy
DEV_EMAIL                 # outside production, ALL outgoing mail is redirected here
```

**Key handling**
- Keys **never** enter the repo. Local: `.dev.vars` (gitignored). Remote: `wrangler secret put`
- Stripe: restricted key, minimum necessary permissions. The **user** installs the live key
- Cloudflare: scoped token — only the relevant zone plus Workers, D1, R2
- `.env`, `.dev.vars`, `*.key` must be in `.gitignore`

---

## 7. Interface

The design system already exists. Prototype files are in `design/`: `index.html`, `rehber.html`, `danismanlik.html`, `hakkimizda.html`, `gizlilik.html`, `satis-kosullari.html`, `styles.css`.

**Do not change**
- Colour and typography tokens in `styles.css`
- Existing components: the three-axis band, the two-path cards, the price box, the scope split
- Typefaces: Archivo (display), Source Serif 4 (body), IBM Plex Mono (labels and figures)
- The light/dark theme structure: every colour is a token on `:root`; `prefers-color-scheme` and `[data-theme]` blocks only redefine tokens

**New screens use the same language, with Turkish copy**
- `/konusma/{token}` — message thread, reply box, file attachment
- `/randevu/{token}` — calendar and slot selection, time zone picker
- `/randevu/{token}/onform` — pre-call intake form
- `/admin` — conversation list and detail, sales, bookings, availability, guide versions

**Everywhere:** no horizontal scroll at phone width, at least 16px side gutter, visible keyboard focus.

---

## 8. Security and privacy

- `/admin` is protected by Cloudflare Access. No separate in-app password
- All tokens are cryptographically random, at least 32 characters, unguessable
- Stripe and Resend webhook **signatures are verified**; unverified requests are rejected
- Rate limiting on form endpoints
- Personal data retention must match the privacy page: contact records 12 months, customer records 2 years, financial records 7 years. Write a scheduled job that purges expired records
- Card data never touches the system; it stays on Stripe's hosted Checkout
- D1 backup: weekly export to R2

---

## 9. Phases

Each phase ends in a testable state. At the end of a phase: run the tests, report, and wait for approval where required.

### Phase 0 — Skeleton
Repo, TypeScript, Hono, Wrangler configuration, D1 and R2 creation, migration tooling, `local`/`staging`/`production` environments, health endpoint.
**Test:** `wrangler dev` starts, `/health` returns 200, staging deploy succeeds.

### Phase 1 — Static pages
Move the prototype files into the project, set up routing for all six pages.
**Test:** all pages render, no horizontal scroll at phone width, light and dark themes correct.

### Phase 2 — Form and admin
Contact form, `contacts`/`conversations`/`messages`, honeypot, rate limiting, `/admin` conversation list and detail.
**Test:** a submitted form appears in admin; a request with the honeypot filled is not stored.
**⏸ User step:** configure the Cloudflare Access policy.

### Phase 3 — Email
Resend domain verification (DNS records written via the Cloudflare API), outbound sending, thread headers, inbound webhook, quote stripping, `unmatched_emails`, `/konusma/{token}`.
**Test:** a reply sent from admin arrives; replying from a real mailbox lands back in the thread with quoted text stripped; the `DEV_EMAIL` guard works.
**⏸ User step:** approve the MX record change.

### Phase 4 — Guide sales
Stripe product and price, Checkout, webhook, `purchases`, `download_tokens`, `/d/{token}`, `/indir`, PDF upload to R2, `guide_versions`.
**Test:** test-card purchase, delivery email, working download, 6th download rejected, expired token rejected.

### Phase 5 — Booking, without Google
`availability_rules`, `date_overrides`, `settings`, slot computation, `/randevu/{token}`, the `bookings` unique lock, `.ics` generation, confirmation emails, reschedule and cancel.
**Test:** two concurrent requests for the same slot — one is rejected. Slots render correctly across time zones. Tested on a DST transition date. The `.ics` opens correctly in Apple Calendar and Google Calendar.

### Phase 6 — Google Calendar
OAuth flow, refresh token storage, freebusy query, `events.insert` with no attendees, `conferenceData` Meet link, event updates on reschedule and cancel.
**Test:** an event added manually to the calendar removes that slot. A booking creates the event and the Meet link. Google sends the customer nothing.
**⏸ User step:** connect Google from admin and grant consent.

### Phase 7 — Intake, reminders, summary
Pre-call intake form, 24-hour reminder via Cron Trigger, written summary delivery from admin.
**Test:** a record with a back-dated time triggers the reminder. The summary lands in the thread and is emailed.

### Phase 8 — Cleanup and resilience
Retention purge job, weekly D1 backup, error logging, 404/500 pages, `robots.txt`, sitemap.
**Test:** the backup file appears in R2; the purge job removes expired records.

### Phase 9 — Go live
**Entirely the user's work.** Switch Stripe to live, install the live key and webhook secret, make and refund one real purchase, finalise DNS.

---

## 10. What the user prepares

Not everything is needed up front. Each item must be ready by the phase that first needs it. Before starting a phase, check its requirements; if something is missing, stop and ask.

### To start (Phases 0–2)

1. **Cloudflare account** + scoped API token (Workers, D1, R2)
2. **Prototype files** — in `design/`, shipped with this bundle

With those two, Phases 0, 1 and 2 complete. The site runs on `*.workers.dev`; no domain needed.

### End of Phase 2

3. **Admin email addresses** — for the Cloudflare Access policy

### Before Phase 3 (email)

4. **Domain** registered, nameservers pointed at Cloudflare, zone active
5. **DNS permission** added to the Cloudflare API token, including that zone
6. **Resend account** + API key
7. **Company details**: legal name, address, KvK and BTW numbers — to fill the bracketed fields in `gizlilik.html` and `satis-kosullari.html`
8. **`DEV_EMAIL`** — the address all development mail is redirected to

### Before Phase 4 (guide sales)

9. **Stripe account**, isolated for this project, **KYC complete**, bank account connected
10. **Stripe test-mode restricted key**
11. **Final PDF of the guide**

### Before Phase 6 (Google Calendar)

12. **GCP project:** Calendar API enabled, OAuth consent screen set to **"In production"**, OAuth client ID and secret, redirect URIs configured
13. **A separate Google calendar named "Üç Eksen"**

### Before Phase 9 (go live)

14. **Stripe live key and webhook secret** — do not give these to the agent; the user installs them

---

## 11. Where work stops

The points where the agent must wait for the user. There are no others.

| # | Phase | What is needed | Time |
|---|---|---|---|
| 1 | Start | The Phase 0–2 preparation items | — |
| 2 | End of Phase 2 | Configure the Cloudflare Access policy and verify admin login | 10 min |
| 3 | Start of Phase 3 | Approve pointing MX at Resend — this changes mail routing for the whole domain | 5 min |
| 4 | Phase 6 | Grant Google OAuth consent from admin, in the browser, once | 5 min |
| 5 | Phase 9 | Go live: Stripe live key, webhook secret, one real purchase test | 30 min |

Phases 4 and 5 have no pauses; they run end to end on test mode and local data.
