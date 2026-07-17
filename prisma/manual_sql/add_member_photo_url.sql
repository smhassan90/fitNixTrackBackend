-- Member portrait URL (run in MySQL Workbench if prisma migrate deploy is unavailable)
-- Safe to re-run: skips when column already exists.

SET @col_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'members'
    AND COLUMN_NAME = 'photoUrl'
);

SET @sql := IF(
  @col_exists = 0,
  'ALTER TABLE `members` ADD COLUMN `photoUrl` VARCHAR(2048) NULL AFTER `comments`',
  'SELECT ''photoUrl already exists'' AS info'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
