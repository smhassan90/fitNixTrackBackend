-- Attendance policy settings on gyms (auto checkout + absence inactive)
-- Run in MySQL Workbench if prisma migrate is unavailable

ALTER TABLE `gyms`
  ADD COLUMN `autoCheckoutHours` INT NOT NULL DEFAULT 6 AFTER `admissionFee`;

ALTER TABLE `gyms`
  ADD COLUMN `absenceInactiveDays` INT NULL AFTER `autoCheckoutHours`;
