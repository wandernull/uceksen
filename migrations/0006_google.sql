-- Phase 6: Google Calendar.
-- settings.google_refresh_token_enc and google_calendar_id already exist (0001).
ALTER TABLE settings ADD COLUMN google_account TEXT;
ALTER TABLE settings ADD COLUMN google_connected_at TEXT;
-- Calendars whose busy time removes slots (JSON array of calendar ids).
ALTER TABLE settings ADD COLUMN google_busy_calendars_json TEXT NOT NULL DEFAULT '[]';

-- Sync state of the booking's Google event. NULL = Google not connected when it was booked.
ALTER TABLE bookings ADD COLUMN gcal_status TEXT CHECK (gcal_status IN ('synced', 'failed'));
ALTER TABLE bookings ADD COLUMN gcal_error TEXT;
