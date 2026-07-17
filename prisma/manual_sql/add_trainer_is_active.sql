-- Trainer active/inactive status
-- Run in MySQL Workbench if prisma migrate is unavailable

ALTER TABLE `trainers`
  ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT TRUE AFTER `endTime`;

CREATE INDEX `trainers_gymId_isActive_idx` ON `trainers` (`gymId`, `isActive`);
