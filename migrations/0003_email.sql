-- Phase 3: email in and out.

-- Outgoing: Resend's id is known at send time; the RFC Message-ID (assigned by SES,
-- needed for In-Reply-To matching) is fetched afterwards into provider_message_id.
ALTER TABLE messages ADD COLUMN resend_id TEXT;
-- 'pending' | 'sent' | 'failed' for outgoing rows; NULL for incoming.
ALTER TABLE messages ADD COLUMN send_status TEXT CHECK (send_status IN ('pending', 'sent', 'failed'));
ALTER TABLE messages ADD COLUMN send_error TEXT;
-- How the message arrived or left: 'form' | 'email' | 'web' | 'admin'.
ALTER TABLE messages ADD COLUMN via TEXT;
-- Incoming email: actual sender address, and the body before quote stripping.
ALTER TABLE messages ADD COLUMN from_addr TEXT;
ALTER TABLE messages ADD COLUMN body_raw TEXT;

-- Idempotency for webhook retries: one row per inbound Message-ID.
CREATE UNIQUE INDEX idx_messages_inbound_provider_id ON messages(provider_message_id)
  WHERE direction = 'in' AND provider_message_id IS NOT NULL;

ALTER TABLE unmatched_emails ADD COLUMN provider_message_id TEXT;
CREATE UNIQUE INDEX idx_unmatched_provider_id ON unmatched_emails(provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Files attached to incoming messages (web reply form or inbound email), stored in R2.
CREATE TABLE attachments (
  id            INTEGER PRIMARY KEY,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  r2_key        TEXT NOT NULL UNIQUE,
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_attachments_message ON attachments(message_id);
