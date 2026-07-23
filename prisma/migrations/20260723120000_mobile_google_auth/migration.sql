-- CreateTable
CREATE TABLE `mobile_google_users` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `googleSub` VARCHAR(128) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `photoUrl` VARCHAR(2048) NULL,
    `tokenVersion` INTEGER NOT NULL DEFAULT 0,
    `lastLoginAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `mobile_google_users_googleSub_key`(`googleSub`),
    UNIQUE INDEX `mobile_google_users_email_key`(`email`),
    INDEX `mobile_google_users_email_idx`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `guest_workout_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `googleUserId` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `bodyParts` JSON NOT NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `guest_workout_logs_googleUserId_date_idx`(`googleUserId`, `date`),
    UNIQUE INDEX `guest_workout_day_uniq`(`googleUserId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `guest_workout_logs` ADD CONSTRAINT `guest_workout_logs_googleUserId_fkey` FOREIGN KEY (`googleUserId`) REFERENCES `mobile_google_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
