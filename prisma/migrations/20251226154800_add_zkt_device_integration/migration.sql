-- AlterTable
ALTER TABLE `attendance_records` ADD COLUMN `checkInTime` DATETIME(3) NULL,
    ADD COLUMN `checkOutTime` DATETIME(3) NULL,
    ADD COLUMN `deviceUserId` VARCHAR(191) NULL,
    ADD COLUMN `deviceSerialNumber` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `attendance_records_deviceUserId_idx` ON `attendance_records`(`deviceUserId`);

-- CreateIndex
CREATE INDEX `attendance_records_checkInTime_idx` ON `attendance_records`(`checkInTime`);

-- CreateTable
CREATE TABLE `device_configs` (
    `id` VARCHAR(191) NOT NULL,
    `gymId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `ipAddress` VARCHAR(191) NOT NULL,
    `port` INTEGER NOT NULL DEFAULT 4370,
    `serialNumber` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `lastSyncAt` DATETIME(3) NULL,
    `syncInterval` INTEGER NOT NULL DEFAULT 300,
    `deviceUserId` VARCHAR(191) NULL,
    `devicePassword` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `device_configs_gymId_ipAddress_port_key`(`gymId`, `ipAddress`, `port`),
    INDEX `device_configs_gymId_idx`(`gymId`),
    INDEX `device_configs_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `device_user_mappings` (
    `id` VARCHAR(191) NOT NULL,
    `deviceConfigId` VARCHAR(191) NOT NULL,
    `memberId` INTEGER NOT NULL,
    `deviceUserId` VARCHAR(191) NOT NULL,
    `deviceUserName` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `device_user_mappings_deviceConfigId_deviceUserId_key`(`deviceConfigId`, `deviceUserId`),
    UNIQUE INDEX `device_user_mappings_deviceConfigId_memberId_key`(`deviceConfigId`, `memberId`),
    INDEX `device_user_mappings_deviceConfigId_idx`(`deviceConfigId`),
    INDEX `device_user_mappings_memberId_idx`(`memberId`),
    INDEX `device_user_mappings_deviceUserId_idx`(`deviceUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `device_configs` ADD CONSTRAINT `device_configs_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_user_mappings` ADD CONSTRAINT `device_user_mappings_deviceConfigId_fkey` FOREIGN KEY (`deviceConfigId`) REFERENCES `device_configs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `device_user_mappings` ADD CONSTRAINT `device_user_mappings_memberId_fkey` FOREIGN KEY (`memberId`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

