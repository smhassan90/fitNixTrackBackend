-- Add optional phone number to trainers
ALTER TABLE `trainers`
  ADD COLUMN `phone` VARCHAR(40) NULL AFTER `name`;

CREATE INDEX `trainers_gymId_phone_idx` ON `trainers`(`gymId`, `phone`);
