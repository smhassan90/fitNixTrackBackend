-- Migration: Change attendance_records.id from String (CUID) to Int (autoincrement)
-- 
-- WARNING: This migration will:
-- 1. Drop all existing attendance records
-- 2. Change the id column from VARCHAR to INT AUTO_INCREMENT
--
-- If you want to preserve data, you'll need to:
-- 1. Export existing data
-- 2. Run this migration
-- 3. Re-import data (ids will be regenerated)
--
-- To preserve data, use the alternative migration below instead.

-- Option 1: Simple migration (DROPS ALL DATA)
-- Uncomment the following lines to execute:

/*
-- Drop foreign key constraints that reference attendance_records.id (if any)
-- Note: Check your schema for any tables that reference attendance_records.id

-- Drop the existing table
DROP TABLE IF EXISTS attendance_records;

-- Recreate with integer id
CREATE TABLE attendance_records (
  id INT AUTO_INCREMENT PRIMARY KEY,
  gymId VARCHAR(191) NOT NULL,
  memberId INT NOT NULL,
  date DATE NOT NULL,
  status ENUM('PRESENT', 'ABSENT', 'LATE') NOT NULL DEFAULT 'PRESENT',
  checkInTime DATETIME(3) NULL,
  checkOutTime DATETIME(3) NULL,
  deviceUserId VARCHAR(191) NULL,
  deviceSerialNumber VARCHAR(191) NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT attendance_records_gymId_fkey FOREIGN KEY (gymId) REFERENCES gyms(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT attendance_records_memberId_fkey FOREIGN KEY (memberId) REFERENCES members(id) ON DELETE CASCADE ON UPDATE CASCADE,
  UNIQUE KEY attendance_records_gymId_memberId_date_key (gymId, memberId, date),
  KEY attendance_records_gymId_idx (gymId),
  KEY attendance_records_memberId_idx (memberId),
  KEY attendance_records_date_idx (date),
  KEY attendance_records_deviceUserId_idx (deviceUserId),
  KEY attendance_records_checkInTime_idx (checkInTime)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
*/

-- Option 2: Preserve data migration (RECOMMENDED)
-- This preserves existing data by creating a new integer id column

-- Step 1: Add new integer id column (temporary name)
ALTER TABLE attendance_records 
ADD COLUMN new_id INT AUTO_INCREMENT UNIQUE FIRST;

-- Step 2: Update any foreign key references (if any tables reference attendance_records.id)
-- Check your database for tables that might reference attendance_records.id
-- Example: UPDATE other_table SET attendanceRecordId = (SELECT new_id FROM attendance_records WHERE id = other_table.attendanceRecordId);

-- Step 3: Drop old id column and rename new_id to id
ALTER TABLE attendance_records 
DROP PRIMARY KEY,
DROP COLUMN id,
CHANGE COLUMN new_id id INT AUTO_INCREMENT PRIMARY KEY FIRST;

-- After migration, run: npx prisma generate
-- This will regenerate Prisma Client with the new schema

