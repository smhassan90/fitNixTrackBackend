-- Platform operator fields: active flag, fine-grained permissions JSON, last login timestamp.
ALTER TABLE `platform_users` ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE `platform_users` ADD COLUMN `permissionKeys` JSON NULL;
ALTER TABLE `platform_users` ADD COLUMN `lastLoginAt` DATETIME(3) NULL;
