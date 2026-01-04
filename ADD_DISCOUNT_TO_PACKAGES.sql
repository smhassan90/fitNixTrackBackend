-- Migration: Add discount field to packages table
-- Run this SQL manually on your database

ALTER TABLE packages 
ADD COLUMN discount FLOAT DEFAULT 0 AFTER price;

-- Verify the column was added
-- SELECT COLUMN_NAME, DATA_TYPE, COLUMN_DEFAULT 
-- FROM INFORMATION_SCHEMA.COLUMNS 
-- WHERE TABLE_SCHEMA = DATABASE() 
-- AND TABLE_NAME = 'packages' 
-- AND COLUMN_NAME = 'discount';

