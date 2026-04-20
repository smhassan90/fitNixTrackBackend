-- Migration: Reset all tables to use Int auto-increment primary keys
-- WARNING: This will DELETE ALL DATA in all tables
-- Run this script to completely reset the database schema

-- Disable foreign key checks temporarily
SET FOREIGN_KEY_CHECKS = 0;

-- Drop all tables in reverse dependency order
DROP TABLE IF EXISTS `device_user_mappings`;
DROP TABLE IF EXISTS `device_configs`;
DROP TABLE IF EXISTS `member_trainers`;
DROP TABLE IF EXISTS `attendance_records`;
DROP TABLE IF EXISTS `payments`;
DROP TABLE IF EXISTS `packages`;
DROP TABLE IF EXISTS `trainers`;
DROP TABLE IF EXISTS `members`;
DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `gyms`;

-- Re-enable foreign key checks
SET FOREIGN_KEY_CHECKS = 1;

-- Note: After running this script, you should run:
-- 1. npx prisma migrate dev --name reset_all_tables_to_int_ids
--    OR
-- 2. npx prisma db push
--
-- This will recreate all tables with the new Int primary key schema

