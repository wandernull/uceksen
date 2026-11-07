-- Initial schema (SPEC §4).
-- All timestamps are UTC ISO-8601 strings with milliseconds and a trailing "Z".
-- Local wall-clock times (availability_rules, date_overrides) are "HH:mm" in settings.host_tz.

CREATE TABLE contacts (
  id          INTEGER PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT,
  phone       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE conversations (
  id               INTEGER PRIMARY KEY,
  contact_id       INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  subject          TEXT,
  state            TEXT NOT NULL DEFAULT 'new'
                   CHECK (state IN ('new', 'ours', 'theirs', 'awaiting_booking', 'completed', 'closed')),
  reply_token      TEXT NOT NULL UNIQUE,
  plus_token       TEXT NOT NULL UNIQUE,
  last_message_at  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_conversations_contact ON conversations(contact_id);
CREATE INDEX idx_conversations_last_message ON conversations(last_message_at);

CREATE TABLE messages (
  id                   INTEGER PRIMARY KEY,
  conversation_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction            TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  body_text            TEXT,
  body_html            TEXT,
  provider_message_id  TEXT,
  in_reply_to          TEXT,
  references_json      TEXT,
  author               TEXT NOT NULL CHECK (author IN ('customer', 'gizem', 'baran', 'system')),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_provider_id ON messages(provider_message_id);

CREATE TABLE unmatched_emails (
  id          INTEGER PRIMARY KEY,
  from_addr   TEXT,
  to_addr     TEXT,
  subject     TEXT,
  body_text   TEXT,
  raw_json    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE purchases (
  id                     INTEGER PRIMARY KEY,
  contact_id             INTEGER NOT NULL REFERENCES contacts(id),
  stripe_session_id      TEXT NOT NULL UNIQUE,
  stripe_payment_intent  TEXT,
  amount_cents           INTEGER NOT NULL,
  currency               TEXT NOT NULL,
  country                TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_purchases_contact ON purchases(contact_id);

CREATE TABLE download_tokens (
  id              INTEGER PRIMARY KEY,
  token           TEXT NOT NULL UNIQUE,
  purchase_id     INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  expires_at      TEXT NOT NULL,
  max_downloads   INTEGER NOT NULL DEFAULT 5,
  download_count  INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE guide_versions (
  id          INTEGER PRIMARY KEY,
  version     TEXT NOT NULL UNIQUE,
  r2_key      TEXT NOT NULL,
  is_current  INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- At most one current version.
CREATE UNIQUE INDEX idx_guide_versions_current ON guide_versions(is_current) WHERE is_current = 1;

CREATE TABLE availability_rules (
  id          INTEGER PRIMARY KEY,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE date_overrides (
  id          INTEGER PRIMARY KEY,
  date        TEXT NOT NULL,  -- "yyyy-MM-dd" in host_tz
  type        TEXT NOT NULL CHECK (type IN ('block', 'extra')),
  start_time  TEXT,           -- null on a block = whole day
  end_time    TEXT,
  note        TEXT
);
CREATE INDEX idx_date_overrides_date ON date_overrides(date);

CREATE TABLE booking_intents (
  id                 INTEGER PRIMARY KEY,
  token              TEXT NOT NULL UNIQUE,
  contact_id         INTEGER NOT NULL REFERENCES contacts(id),
  stripe_session_id  TEXT NOT NULL UNIQUE,
  expires_at         TEXT NOT NULL,
  used_at            TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE bookings (
  id                   INTEGER PRIMARY KEY,
  conversation_id      INTEGER REFERENCES conversations(id),
  contact_id           INTEGER NOT NULL REFERENCES contacts(id),
  booking_intent_id    INTEGER REFERENCES booking_intents(id),
  start_utc            TEXT NOT NULL UNIQUE,  -- the double-booking lock
  end_utc              TEXT NOT NULL,
  customer_tz          TEXT NOT NULL,
  state                TEXT NOT NULL DEFAULT 'confirmed'
                       CHECK (state IN ('confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show')),
  meet_url             TEXT,
  gcal_event_id        TEXT,
  intake_json          TEXT,
  intake_submitted_at  TEXT,
  reschedule_count     INTEGER NOT NULL DEFAULT 0,
  summary_sent_at      TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_bookings_contact ON bookings(contact_id);
CREATE INDEX idx_bookings_intent ON bookings(booking_intent_id);

-- Single row, id = 1. google_refresh_token_enc is AES-GCM ciphertext (see PROGRESS.md decisions).
CREATE TABLE settings (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  host_tz                   TEXT NOT NULL DEFAULT 'Europe/Istanbul',
  min_notice_hours          INTEGER NOT NULL DEFAULT 48,
  max_horizon_days          INTEGER NOT NULL DEFAULT 45,
  buffer_before_min         INTEGER NOT NULL DEFAULT 15,
  buffer_after_min          INTEGER NOT NULL DEFAULT 30,
  max_per_week              INTEGER NOT NULL DEFAULT 3,
  slot_times_json           TEXT NOT NULL DEFAULT '["10:00","14:00","16:00"]',
  google_refresh_token_enc  TEXT,
  google_calendar_id        TEXT,
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO settings (id) VALUES (1);
