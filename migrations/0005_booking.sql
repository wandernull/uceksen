-- Phase 5: consulting payment and booking (without Google).

-- The double-booking lock stays a UNIQUE constraint on start_utc, but only among
-- live bookings: a cancelled booking must free its slot. SQLite cannot change a
-- column constraint in place, so the table is rebuilt (nothing references it yet).
CREATE TABLE bookings_new (
  id                   INTEGER PRIMARY KEY,
  conversation_id      INTEGER REFERENCES conversations(id),
  contact_id           INTEGER NOT NULL REFERENCES contacts(id),
  booking_intent_id    INTEGER REFERENCES booking_intents(id),
  start_utc            TEXT NOT NULL,
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
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  cancelled_at         TEXT,
  cancelled_by         TEXT CHECK (cancelled_by IN ('customer', 'admin')),
  -- 'refunded' | 'not_eligible' | 'failed'; NULL while not cancelled
  refund_status        TEXT CHECK (refund_status IN ('refunded', 'not_eligible', 'failed')),
  stripe_refund_id     TEXT
);
INSERT INTO bookings_new (id, conversation_id, contact_id, booking_intent_id, start_utc, end_utc, customer_tz, state, meet_url,
                          gcal_event_id, intake_json, intake_submitted_at, reschedule_count, summary_sent_at, created_at, updated_at)
  SELECT id, conversation_id, contact_id, booking_intent_id, start_utc, end_utc, customer_tz, state, meet_url,
         gcal_event_id, intake_json, intake_submitted_at, reschedule_count, summary_sent_at, created_at, updated_at
    FROM bookings;
DROP TABLE bookings;
ALTER TABLE bookings_new RENAME TO bookings;
-- The lock: one live booking per start time.
CREATE UNIQUE INDEX idx_bookings_start_live ON bookings(start_utc) WHERE state IN ('confirmed', 'rescheduled');
CREATE INDEX idx_bookings_contact ON bookings(contact_id);
CREATE INDEX idx_bookings_intent ON bookings(booking_intent_id);
CREATE INDEX idx_bookings_start ON bookings(start_utc);

-- Payment details on the intent (it is the consulting "purchase").
ALTER TABLE booking_intents ADD COLUMN conversation_id INTEGER REFERENCES conversations(id);
ALTER TABLE booking_intents ADD COLUMN stripe_payment_intent TEXT;
ALTER TABLE booking_intents ADD COLUMN amount_cents INTEGER;
ALTER TABLE booking_intents ADD COLUMN currency TEXT;
ALTER TABLE booking_intents ADD COLUMN country TEXT;
ALTER TABLE booking_intents ADD COLUMN stripe_invoice_id TEXT;
ALTER TABLE booking_intents ADD COLUMN invoice_url TEXT;
CREATE INDEX idx_booking_intents_conversation ON booking_intents(conversation_id);

-- Admins open the payment step per conversation (the consulting flow starts with a request).
ALTER TABLE conversations ADD COLUMN consult_offered_at TEXT;

-- Outgoing messages about a booking carry its .ics (built when the email is sent).
ALTER TABLE messages ADD COLUMN booking_id INTEGER REFERENCES bookings(id);
