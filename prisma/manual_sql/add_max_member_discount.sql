-- Max member discount setting on gyms (configurable from portal settings)
-- Run in MySQL Workbench if prisma migrate is unavailable

ALTER TABLE `gyms`
  ADD COLUMN `maxMemberDiscount` DOUBLE NULL DEFAULT 100 AFTER `admissionFee`;
