-- Per-gym IANA timezone (e.g. Asia/Karachi). Set at gym creation from platform admin.
ALTER TABLE `gyms`
  ADD COLUMN `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC' AFTER `syncApiKey`;
