-- AlterTable
ALTER TABLE `members` ADD COLUMN `legacyMemberId` VARCHAR(64) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `members_gymId_legacyMemberId_key` ON `members`(`gymId`, `legacyMemberId`);

-- CreateIndex
CREATE INDEX `members_gymId_legacyMemberId_idx` ON `members`(`gymId`, `legacyMemberId`);
