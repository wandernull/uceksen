-- Phase 10: reminders. intake_json, intake_submitted_at and summary_sent_at already exist (0005).
-- Set when the 24-hour reminder is claimed; cleared when the booking moves to a new time.
ALTER TABLE bookings ADD COLUMN reminder_sent_at TEXT;
