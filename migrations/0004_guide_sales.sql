-- Phase 4: guide sales.

-- Each purchase gets its own conversation: the delivery email is its first message,
-- so a customer's reply to it threads like any other email and shows up in /admin.
ALTER TABLE purchases ADD COLUMN conversation_id INTEGER REFERENCES conversations(id);
ALTER TABLE purchases ADD COLUMN stripe_invoice_id TEXT;
ALTER TABLE purchases ADD COLUMN invoice_url TEXT;
-- Checkout's terms consent (includes the withdrawal-right waiver): 1 = accepted.
ALTER TABLE purchases ADD COLUMN terms_accepted INTEGER NOT NULL DEFAULT 0 CHECK (terms_accepted IN (0, 1));

CREATE INDEX idx_download_tokens_purchase ON download_tokens(purchase_id);

ALTER TABLE guide_versions ADD COLUMN size INTEGER;

-- "Unsubscribe" from guide update emails (promised on /gizlilik).
ALTER TABLE contacts ADD COLUMN guide_updates_optout_at TEXT;

-- Which purchasers were told about which guide version. Lets the admin send the
-- notice in small batches and never twice to the same person.
CREATE TABLE guide_update_notices (
  id                INTEGER PRIMARY KEY,
  guide_version_id  INTEGER NOT NULL REFERENCES guide_versions(id) ON DELETE CASCADE,
  contact_id        INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (guide_version_id, contact_id)
);
