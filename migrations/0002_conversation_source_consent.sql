-- Where a conversation started, and when the customer gave processing consent
-- (GDPR: keep proof of consent next to the data it covers).
ALTER TABLE conversations ADD COLUMN source TEXT;      -- danismanlik | hakkimizda | ...
ALTER TABLE conversations ADD COLUMN consent_at TEXT;  -- UTC ISO-8601
