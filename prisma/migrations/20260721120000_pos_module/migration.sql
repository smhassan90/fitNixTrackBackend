-- Point of Sale (POS) module

CREATE TABLE `pos_categories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `productType` ENUM('NUTRIENT', 'ACCESSORY') NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `code` VARCHAR(64) NULL,
    `description` TEXT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pos_categories_code_key`(`code`),
    UNIQUE INDEX `pos_categories_productType_name_key`(`productType`, `name`),
    INDEX `pos_categories_productType_isActive_sortOrder_idx`(`productType`, `isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pos_subcategories` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `categoryId` INTEGER NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `code` VARCHAR(64) NULL,
    `description` TEXT NULL,
    `allowedForms` JSON NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pos_subcategories_code_key`(`code`),
    UNIQUE INDEX `pos_subcategories_categoryId_name_key`(`categoryId`, `name`),
    INDEX `pos_subcategories_categoryId_isActive_sortOrder_idx`(`categoryId`, `isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `gym_pos_subcategories` (
    `gymId` INTEGER NOT NULL,
    `subcategoryId` INTEGER NOT NULL,
    `enabledAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `gym_pos_subcategories_subcategoryId_idx`(`subcategoryId`),
    PRIMARY KEY (`gymId`, `subcategoryId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pos_products` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gymId` INTEGER NOT NULL,
    `subcategoryId` INTEGER NOT NULL,
    `productType` ENUM('NUTRIENT', 'ACCESSORY') NOT NULL,
    `form` ENUM('PACKAGED', 'SERVING') NOT NULL DEFAULT 'PACKAGED',
    `name` VARCHAR(255) NOT NULL,
    `sku` VARCHAR(64) NULL,
    `description` TEXT NULL,
    `imageUrl` VARCHAR(2048) NULL,
    `brand` VARCHAR(128) NULL,
    `price` DOUBLE NOT NULL,
    `discountType` ENUM('NONE', 'PERCENT', 'FLAT') NOT NULL DEFAULT 'NONE',
    `discountValue` DOUBLE NOT NULL DEFAULT 0,
    `calories` DOUBLE NULL,
    `proteinG` DOUBLE NULL,
    `carbsG` DOUBLE NULL,
    `fatG` DOUBLE NULL,
    `fiberG` DOUBLE NULL,
    `sugarG` DOUBLE NULL,
    `servingSizeG` DOUBLE NULL,
    `servingLabel` VARCHAR(64) NULL,
    `material` VARCHAR(128) NULL,
    `color` VARCHAR(64) NULL,
    `size` VARCHAR(64) NULL,
    `trackInventory` BOOLEAN NOT NULL DEFAULT true,
    `stockQuantity` INTEGER NOT NULL DEFAULT 0,
    `lowStockThreshold` INTEGER NOT NULL DEFAULT 5,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `deletedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pos_products_gymId_sku_key`(`gymId`, `sku`),
    INDEX `pos_products_gymId_subcategoryId_isActive_idx`(`gymId`, `subcategoryId`, `isActive`),
    INDEX `pos_products_gymId_productType_idx`(`gymId`, `productType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pos_sales` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gymId` INTEGER NOT NULL,
    `receiptNo` VARCHAR(64) NOT NULL,
    `status` ENUM('COMPLETED', 'VOIDED') NOT NULL DEFAULT 'COMPLETED',
    `subtotal` DOUBLE NOT NULL,
    `discountTotal` DOUBLE NOT NULL DEFAULT 0,
    `total` DOUBLE NOT NULL,
    `memberId` INTEGER NULL,
    `soldById` INTEGER NOT NULL,
    `notes` TEXT NULL,
    `soldAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `voidedAt` DATETIME(3) NULL,
    `voidedById` INTEGER NULL,
    `voidReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `pos_sales_receiptNo_key`(`receiptNo`),
    INDEX `pos_sales_gymId_soldAt_idx`(`gymId`, `soldAt`),
    INDEX `pos_sales_gymId_status_idx`(`gymId`, `status`),
    INDEX `pos_sales_memberId_idx`(`memberId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pos_stock_movements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `gymId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `type` ENUM('RESTOCK', 'SALE', 'ADJUSTMENT', 'RETURN') NOT NULL,
    `quantity` INTEGER NOT NULL,
    `stockAfter` INTEGER NOT NULL,
    `note` TEXT NULL,
    `saleId` INTEGER NULL,
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `pos_stock_movements_gymId_productId_idx`(`gymId`, `productId`),
    INDEX `pos_stock_movements_gymId_createdAt_idx`(`gymId`, `createdAt`),
    INDEX `pos_stock_movements_saleId_idx`(`saleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `pos_sale_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `saleId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `productName` VARCHAR(255) NOT NULL,
    `productType` ENUM('NUTRIENT', 'ACCESSORY') NOT NULL,
    `categoryId` INTEGER NOT NULL,
    `categoryName` VARCHAR(128) NOT NULL,
    `subcategoryId` INTEGER NOT NULL,
    `subcategoryName` VARCHAR(128) NOT NULL,
    `form` ENUM('PACKAGED', 'SERVING') NOT NULL,
    `quantity` INTEGER NOT NULL,
    `unitPrice` DOUBLE NOT NULL,
    `discountType` ENUM('NONE', 'PERCENT', 'FLAT') NOT NULL DEFAULT 'NONE',
    `discountValue` DOUBLE NOT NULL DEFAULT 0,
    `lineSubtotal` DOUBLE NOT NULL,
    `lineDiscount` DOUBLE NOT NULL DEFAULT 0,
    `lineTotal` DOUBLE NOT NULL,

    INDEX `pos_sale_items_saleId_idx`(`saleId`),
    INDEX `pos_sale_items_productId_idx`(`productId`),
    INDEX `pos_sale_items_subcategoryId_idx`(`subcategoryId`),
    INDEX `pos_sale_items_categoryId_idx`(`categoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `pos_subcategories` ADD CONSTRAINT `pos_subcategories_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `pos_categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `gym_pos_subcategories` ADD CONSTRAINT `gym_pos_subcategories_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `gym_pos_subcategories` ADD CONSTRAINT `gym_pos_subcategories_subcategoryId_fkey` FOREIGN KEY (`subcategoryId`) REFERENCES `pos_subcategories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `pos_products` ADD CONSTRAINT `pos_products_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `pos_products` ADD CONSTRAINT `pos_products_subcategoryId_fkey` FOREIGN KEY (`subcategoryId`) REFERENCES `pos_subcategories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `pos_sales` ADD CONSTRAINT `pos_sales_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `pos_sales` ADD CONSTRAINT `pos_sales_memberId_fkey` FOREIGN KEY (`memberId`) REFERENCES `members`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `pos_stock_movements` ADD CONSTRAINT `pos_stock_movements_gymId_fkey` FOREIGN KEY (`gymId`) REFERENCES `gyms`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `pos_stock_movements` ADD CONSTRAINT `pos_stock_movements_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `pos_products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `pos_stock_movements` ADD CONSTRAINT `pos_stock_movements_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `pos_sales`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `pos_sale_items` ADD CONSTRAINT `pos_sale_items_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `pos_sales`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `pos_sale_items` ADD CONSTRAINT `pos_sale_items_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `pos_products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
