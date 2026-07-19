-- Granular gym team permissions.
-- Run this in MySQL Workbench when `prisma migrate deploy` is unavailable.
-- Safe to re-run. Null means the user keeps legacy role-based access until edited.

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'users'
    AND COLUMN_NAME = 'permissionKeys'
);

SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE `users` ADD COLUMN `permissionKeys` JSON NULL AFTER `role`',
  'SELECT ''permissionKeys already exists'' AS info'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
