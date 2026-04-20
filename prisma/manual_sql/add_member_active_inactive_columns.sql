-- Add member active/inactive lifecycle columns
ALTER TABLE members
  ADD COLUMN isActive BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN inactiveFrom DATETIME NULL,
  ADD COLUMN billingResumeFrom DATETIME NULL;

-- Backfill legacy rows so behavior is predictable
UPDATE members
SET isActive = TRUE
WHERE isActive IS NULL;
