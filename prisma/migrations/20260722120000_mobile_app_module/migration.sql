-- Mobile app module: workouts, orders, OTP, notifications

ALTER TABLE `members` ADD COLUMN `mobileTokenVersion` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `members` ADD COLUMN `mobileLastLoginAt` DATETIME(3) NULL;

ALTER TABLE `trainers` ADD COLUMN `mobileTokenVersion` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `trainers` ADD COLUMN `mobileLastLoginAt` DATETIME(3) NULL;

CREATE TABLE `workout_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gymId` INTEGER NOT NULL,
    `accountType` ENUM('MEMBER', 'TRAINER') NOT NULL,
    `memberId` INTEGER NULL,
    `trainerId` INTEGER NULL,
    `loggedByType` ENUM('MEMBER', 'TRAINER') NOT NULL,
    `loggedByMemberId` INTEGER NULL,
    `loggedByTrainerId` INTEGER NULL,
    `date` DATE NOT NULL,
    `bodyParts` JSON NOT NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `workout_member_day_uniq`(`gymId`, `memberId`, `date`),
    UNIQUE INDEX `workout_trainer_day_uniq`(`gymId`, `trainerId`, `date`),
    INDEX `workout_logs_gymId_date_idx`(`gymId`, `date`),
    INDEX `workout_logs_memberId_date_idx`(`memberId`, `date`),
    INDEX `workout_logs_trainerId_date_idx`(`trainerId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `mobile_orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gymId` INTEGER NOT NULL,
    `orderNo` VARCHAR(64) NOT NULL,
    `status` ENUM('PENDING', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `placedByType` ENUM('MEMBER', 'TRAINER') NOT NULL,
    `memberId` INTEGER NULL,
    `trainerId` INTEGER NULL,
    `subtotal` DOUBLE NOT NULL,
    `total` DOUBLE NOT NULL,
    `notes` TEXT NULL,
    `posSaleId` INTEGER NULL,
    `completedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `mobile_orders_orderNo_key`(`orderNo`),
    INDEX `mobile_orders_gymId_status_idx`(`gymId`, `status`),
    INDEX `mobile_orders_memberId_idx`(`memberId`),
    INDEX `mobile_orders_trainerId_idx`(`trainerId`),
    INDEX `mobile_orders_gymId_createdAt_idx`(`gymId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `mobile_order_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `productName` VARCHAR(255) NOT NULL,
    `productType` ENUM('NUTRIENT', 'ACCESSORY') NOT NULL,
    `quantity` INTEGER NOT NULL,
    `unitPrice` DOUBLE NOT NULL,
    `lineTotal` DOUBLE NOT NULL,
    `calories` DOUBLE NULL,
    `proteinG` DOUBLE NULL,
    `carbsG` DOUBLE NULL,
    `fatG` DOUBLE NULL,

    INDEX `mobile_order_items_orderId_idx`(`orderId`),
    INDEX `mobile_order_items_productId_idx`(`productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `mobile_otp_sessions` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gymId` INTEGER NOT NULL,
    `phone` VARCHAR(40) NOT NULL,
    `otpHash` VARCHAR(128) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mobile_otp_sessions_gymId_phone_idx`(`gymId`, `phone`),
    INDEX `mobile_otp_sessions_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `mobile_notifications` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gymId` INTEGER NOT NULL,
    `accountType` ENUM('MEMBER', 'TRAINER') NOT NULL,
    `memberId` INTEGER NULL,
    `trainerId` INTEGER NULL,
    `type` ENUM('PAYMENT_OVERDUE', 'PAYMENT_DUE_SOON', 'ORDER_READY', 'ORDER_COMPLETED', 'GENERAL') NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body` TEXT NOT NULL,
    `metadata` JSON NULL,
    `isRead` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mobile_notifications_gymId_memberId_isRead_idx`(`gymId`, `memberId`, `isRead`),
    INDEX `mobile_notifications_gymId_trainerId_isRead_idx`(`gymId`, `trainerId`, `isRead`),
    INDEX `mobile_notifications_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `mobile_push_tokens` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gymId` INTEGER NOT NULL,
    `accountType` ENUM('MEMBER', 'TRAINER') NOT NULL,
    `memberId` INTEGER NULL,
    `trainerId` INTEGER NULL,
    `deviceToken` VARCHAR(512) NOT NULL,
    `platform` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `mobile_push_tokens_gymId_accountType_memberId_trainerId_deviceToken_key`(`gymId`, `accountType`, `memberId`, `trainerId`, `deviceToken`),
    INDEX `mobile_push_tokens_memberId_idx`(`memberId`),
    INDEX `mobile_push_tokens_trainerId_idx`(`trainerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `workout_logs` ADD CONSTRAINT `workout_logs_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `workout_logs` ADD CONSTRAINT `workout_logs_memberId_fkey` FOREIGN KEY (`memberId`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `workout_logs` ADD CONSTRAINT `workout_logs_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `trainers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `workout_logs` ADD CONSTRAINT `workout_logs_loggedByTrainerId_fkey` FOREIGN KEY (`loggedByTrainerId`) REFERENCES `trainers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `mobile_orders` ADD CONSTRAINT `mobile_orders_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `mobile_orders` ADD CONSTRAINT `mobile_orders_memberId_fkey` FOREIGN KEY (`memberId`) REFERENCES `members`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `mobile_orders` ADD CONSTRAINT `mobile_orders_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `trainers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `mobile_order_items` ADD CONSTRAINT `mobile_order_items_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `mobile_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `mobile_otp_sessions` ADD CONSTRAINT `mobile_otp_sessions_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `mobile_notifications` ADD CONSTRAINT `mobile_notifications_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `mobile_notifications` ADD CONSTRAINT `mobile_notifications_memberId_fkey` FOREIGN KEY (`memberId`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `mobile_notifications` ADD CONSTRAINT `mobile_notifications_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `trainers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `mobile_push_tokens` ADD CONSTRAINT `mobile_push_tokens_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `mobile_push_tokens` ADD CONSTRAINT `mobile_push_tokens_memberId_fkey` FOREIGN KEY (`memberId`) REFERENCES `members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `mobile_push_tokens` ADD CONSTRAINT `mobile_push_tokens_trainerId_fkey` FOREIGN KEY (`trainerId`) REFERENCES `trainers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
