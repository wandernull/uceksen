# CLAUDE.md

These rules apply in every session. They are binding and are not relaxed for convenience.

## Project

**Üç Eksen** — a site that sells a guide (€15 PDF) and consulting sessions (€200, 90 min) to Turkish people expanding into Europe, and manages the whole customer relationship in one place.

References:
- `SPEC.md` — technical specification. What gets built. Check here first whenever you are unsure.
- `PROGRESS.md` — live project state. Where things stand.
- `design/` — UI prototype and design system.

Core principle: **no mailbox.** Every outgoing email is sent from `merhaba@uceksen.com` through Resend; every incoming email arrives via the Resend inbound webhook. The only management surface is `/admin`.

## Language

- **Code, comments, commit messages, documentation, test names, and everything you write back to the user: English.**
- **All user-facing UI copy: Turkish.** This covers customer-facing pages, emails, error messages, form labels, and the `/admin` interface. The product is Turkish; do not translate it.
- Existing Turkish copy in `design/` is final content. Carry it over verbatim.
- When you add new screens, write their copy in Turkish, matching the tone of the existing pages: plain, direct, no marketing language.

## Continuity — every session

This project spans weeks. The user may step away for a long time and come back. State lives in the repo, not in context.

**First action of every session:** read `PROGRESS.md`. It tells you where work stopped, what is blocked on the user, and which decisions were made. When the user says "continue", find the answer in the file — do not ask.

**Update `PROGRESS.md` at these moments:**
- Starting a phase — set status to in-progress, fill in what you are working on
- Finishing a phase — mark it done, record the commit hash, update completed work
- Before waiting on the user — set status to blocked, write exactly what they need to do
- Whenever you make a decision that deviates from or extends `SPEC.md` — record it with the reasoning
- Whenever you leave a problem unsolved — record it under known issues

Updates must be substantive. The user should understand the state from this file alone.

**Commit discipline:** one commit at the end of each phase, message format `phase N: <short summary>`. Never combine two phases in one commit. Commits are the real restore points; `PROGRESS.md` is the human-readable summary.

When context starts getting tight, update `PROGRESS.md` first, then continue.

## How to work

- **Phase by phase.** Follow the order in `SPEC.md` section 9. Do not start a phase before finishing the previous one.
- **At the end of every phase:** run the tests, show the results, summarise what you did, wait for the user's approval.
- **Stop where you are supposed to stop.** `SPEC.md` section 11 lists the steps only the user can perform. When you reach one, state what is needed and wait. Do not proceed on assumption.
- **No surprises.** If user involvement is needed somewhere not on that list, say so first and wait.
- If you need to change an architectural decision, explain the reasoning and get approval first.

## Security

- No API key, secret, or token ever enters the repo. Local: `.dev.vars`. Remote: `wrangler secret put`. `.gitignore` must be correct from the first commit.
- Stripe runs in **test mode only** during the build. The user sets the live key themselves.
- Stripe and Resend webhooks do nothing until the **signature is verified**.
- All tokens are cryptographically random, at least 32 characters.
- `/admin` is protected by Cloudflare Access. Do not write a separate password mechanism in the application.
- Form endpoints have rate limiting and a honeypot field.

## Email in development

Resend is **real** in development; it is not mocked.

Therefore: while `ENVIRONMENT !== "production"`, the recipient of **every** outgoing email is forcibly rewritten to the `DEV_EMAIL` variable. The intended recipient is written into the email body for reference.

**This guard is never bypassed, never disabled, never "temporarily removed for testing".** Sending real mail to seed-data addresses is unacceptable.

**Staging switch (user decision, 2026-11-12):** `MAIL_GUARD` in `wrangler.toml`. `"off"` lets staging (`ENVIRONMENT = "staging"` only) send to real recipients; local and tests are always guarded. Currently **on** (restored 2026-11-12). Only the user turns it off. Do not add any other way around the guard.

## Time

- All date and time handling uses **Luxon**.
- Everything is stored in **UTC**.
- Time zones are referenced by **IANA name** (`Europe/Istanbul`), never by fixed offset (`+03:00`).
- Write tests covering DST transition dates.
- Default host time zone is `Europe/Istanbul`, changeable via `settings.host_tz`. Changing it does not affect existing bookings.

## Booking

- **The double-booking lock lives in the database:** a unique constraint on `bookings.start_utc`. Write to the database first; only on success write to Google Calendar. Never the other way round.
- The customer is **never added as an attendee** on the Google Calendar event. Google must send the customer nothing.
- The system generates the customer's `.ics` itself: `METHOD:PUBLISH`, `ORGANIZER;CN=Üç Eksen:mailto:merhaba@uceksen.com`.
- The Meet link is created through Google Calendar `conferenceData` and embedded in the `.ics`.
- Slots are computed on every page load. No caching.

## Design

- `design/styles.css` is the design system. Colour tokens, the type scale, and existing components are **not changed**.
- Typefaces: Archivo (display), Source Serif 4 (body), IBM Plex Mono (labels and figures).
- Light and dark themes are token-based: every colour is defined on `:root`, and the `prefers-color-scheme` and `[data-theme]` blocks only redefine tokens. Never put a theme-specific colour literal inside a component rule.
- New screens use the same language.
- Every page works at phone width: no horizontal scroll, at least 16px side gutter, visible keyboard focus.

## Code

- TypeScript, strict.
- Set up the file and folder structure properly from the start; no bulk reorganisation later.
- Comments sparse, but clear where it matters.
- Write tests in every phase. Minimum coverage: slot computation (time zones and DST), double-booking race, download token limits, inbound email matching and quote stripping, webhook signature verification.

## About the user

The user is technical and does not want padding. Write short and direct. If you think something is wrong, say so plainly.

## Credentials

This project uses `~/.gizem-creds`. Cloudflare account: `ef35eded2f130806ec2824e2920866ee` (workers.dev subdomain `gizemderinkok`). GitHub account: whatever `gh auth status` reports for that token (currently `wandernull`).
