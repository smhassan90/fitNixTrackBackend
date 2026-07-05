-- CreateTable
CREATE TABLE `device_users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceConfigId` INTEGER NOT NULL,
    `deviceUserId` VARCHAR(191) NOT NULL,
    `deviceUserName` VARCHAR(191) NULL,
    `deviceBadgeId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `device_users_deviceConfigId_deviceUserId_key`(`deviceConfigId`, `deviceUserId`),
    INDEX `device_users_deviceConfigId_idx`(`deviceConfigId`),
    INDEX `device_users_deviceUserName_idx`(`deviceUserName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pending_attendance_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gymId` INTEGER NOT NULL,
    `deviceConfigId` INTEGER NOT NULL,
    `deviceUserId` VARCHAR(191) NOT NULL,
    `recordTime` DATETIME(3) NOT NULL,
    `type` INTEGER NULL,
    `state` INTEGER NULL,
    `deviceSerialNumber` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `pal_gymId_idx`(`gymId`),
    INDEX `pal_cfg_user_idx`(`deviceConfigId`, `deviceUserId`),
    UNIQUE INDEX `pal_cfg_user_time_uniq`(`deviceConfigId`, `deviceUserId`, `recordTime`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `device_users` ADD CONSTRAINT `device_users_deviceConfigId_fkey` FOREIGN KEY (`deviceConfigId`) REFERENCES `device_configs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pending_attendance_logs` ADD CONSTRAINT `pal_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pending_attendance_logs` ADD CONSTRAINT `pal_deviceConfigId_fkey` FOREIGN KEY (`deviceConfigId`) REFERENCES `device_configs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
