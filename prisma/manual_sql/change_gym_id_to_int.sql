-- Migration: Change Gym.id from String (CUID) to Int (Auto-increment)
-- This migration converts the gyms table and all related foreign keys

-- Step 1: Add new INT id column to gyms table
ALTER TABLE `gyms` ADD COLUMN `id_new` INT AUTO_INCREMENT UNIQUE;

-- Step 2: Populate the new id column with sequential numbers
SET @row_number = 0;
UPDATE `gyms` SET `id_new` = (@row_number := @row_number + 1) ORDER BY `createdAt`;

-- Step 3: Create a mapping table to track old_id -> new_id
CREATE TEMPORARY TABLE `gym_id_mapping` AS
SELECT `id` AS `old_id`, `id_new` AS `new_id` FROM `gyms`;

-- Step 4: Add new INT gymId columns to all tables with foreign keys
ALTER TABLE `users` ADD COLUMN `gymId_new` INT;
ALTER TABLE `members` ADD COLUMN `gymId_new` INT;
ALTER TABLE `trainers` ADD COLUMN `gymId_new` INT;
ALTER TABLE `packages` ADD COLUMN `gymId_new` INT;
ALTER TABLE `payments` ADD COLUMN `gymId_new` INT;
ALTER TABLE `attendance_records` ADD COLUMN `gymId_new` INT;
ALTER TABLE `device_configs` ADD COLUMN `gymId_new` INT;

-- Step 5: Update all foreign key columns with new INT values
UPDATE `users` u
INNER JOIN `gym_id_mapping` m ON u.`gymId` = m.`old_id`
SET u.`gymId_new` = m.`new_id`;

UPDATE `members` mem
INNER JOIN `gym_id_mapping` m ON mem.`gymId` = m.`old_id`
SET mem.`gymId_new` = m.`new_id`;

UPDATE `trainers` t
INNER JOIN `gym_id_mapping` m ON t.`gymId` = m.`old_id`
SET t.`gymId_new` = m.`new_id`;

UPDATE `packages` p
INNER JOIN `gym_id_mapping` m ON p.`gymId` = m.`old_id`
SET p.`gymId_new` = m.`new_id`;

UPDATE `payments` pay
INNER JOIN `gym_id_mapping` m ON pay.`gymId` = m.`old_id`
SET pay.`gymId_new` = m.`new_id`;

UPDATE `attendance_records` ar
INNER JOIN `gym_id_mapping` m ON ar.`gymId` = m.`old_id`
SET ar.`gymId_new` = m.`new_id`;

UPDATE `device_configs` dc
INNER JOIN `gym_id_mapping` m ON dc.`gymId` = m.`old_id`
SET dc.`gymId_new` = m.`new_id`;

-- Step 6: Drop old foreign key constraints (if they exist)
-- Note: MySQL doesn't support DROP CONSTRAINT IF EXISTS, so we'll use a stored procedure approach
-- For now, we'll drop them manually if they exist

-- Step 7: Drop old columns
ALTER TABLE `users` DROP COLUMN `gymId`;
ALTER TABLE `members` DROP COLUMN `gymId`;
ALTER TABLE `trainers` DROP COLUMN `gymId`;
ALTER TABLE `packages` DROP COLUMN `gymId`;
ALTER TABLE `payments` DROP COLUMN `gymId`;
ALTER TABLE `attendance_records` DROP COLUMN `gymId`;
ALTER TABLE `device_configs` DROP COLUMN `gymId`;

-- Step 8: Rename new columns
ALTER TABLE `users` CHANGE COLUMN `gymId_new` `gymId` INT NOT NULL;
ALTER TABLE `members` CHANGE COLUMN `gymId_new` `gymId` INT NOT NULL;
ALTER TABLE `trainers` CHANGE COLUMN `gymId_new` `gymId` INT NOT NULL;
ALTER TABLE `packages` CHANGE COLUMN `gymId_new` `gymId` INT NOT NULL;
ALTER TABLE `payments` CHANGE COLUMN `gymId_new` `gymId` INT NOT NULL;
ALTER TABLE `attendance_records` CHANGE COLUMN `gymId_new` `gymId` INT NOT NULL;
ALTER TABLE `device_configs` CHANGE COLUMN `gymId_new` `gymId` INT NOT NULL;

-- Step 9: Drop old id column and rename new one
ALTER TABLE `gyms` DROP PRIMARY KEY;
ALTER TABLE `gyms` DROP COLUMN `id`;
ALTER TABLE `gyms` CHANGE COLUMN `id_new` `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY;

-- Step 10: Recreate foreign key constraints
ALTER TABLE `users` ADD CONSTRAINT `users_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE;
ALTER TABLE `members` ADD CONSTRAINT `members_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE;
ALTER TABLE `trainers` ADD CONSTRAINT `trainers_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE;
ALTER TABLE `packages` ADD CONSTRAINT `packages_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE;
ALTER TABLE `attendance_records` ADD CONSTRAINT `attendance_records_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE;
ALTER TABLE `device_configs` ADD CONSTRAINT `device_configs_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE;

-- Step 11: Recreate indexes
ALTER TABLE `members` ADD INDEX `members_gymId_idx` (`gymId`);
ALTER TABLE `members` ADD INDEX `members_gymId_createdAt_idx` (`gymId`, `createdAt`);
ALTER TABLE `trainers` ADD INDEX `trainers_gymId_idx` (`gymId`);
ALTER TABLE `packages` ADD INDEX `packages_gymId_idx` (`gymId`);
ALTER TABLE `payments` ADD INDEX `payments_gymId_idx` (`gymId`);
ALTER TABLE `attendance_records` ADD INDEX `attendance_records_gymId_idx` (`gymId`);
ALTER TABLE `device_configs` ADD INDEX `device_configs_gymId_idx` (`gymId`);

-- Step 12: Recreate unique constraints
ALTER TABLE `attendance_records` ADD UNIQUE KEY `attendance_records_gymId_memberId_date_key` (`gymId`, `memberId`, `date`);
ALTER TABLE `device_configs` ADD UNIQUE KEY `device_configs_gymId_ipAddress_port_key` (`gymId`, `ipAddress`, `port`);

