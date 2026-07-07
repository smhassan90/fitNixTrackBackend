-- Adds the columns from migration 20260704120000_plan_max_members_subscription_cycle
-- to a live database where `prisma migrate deploy` was never run
-- (Vercel `vercel-build` only runs `prisma generate && tsc`).
--
-- Fixes: "Unknown column 'gym_subscriptions.billingCycle'"
--        (a.k.a. "column gymsubscription.billingcycle does not exist")
--
-- Run ONCE in MySQL (phpMyAdmin / MySQL Workbench / DBeaver / CLI).
-- MySQL 8 has no "ADD COLUMN IF NOT EXISTS": if a statement fails with
-- "Duplicate column name", the column already exists — skip it and continue.

ALTER TABLE `gym_subscriptions`
  ADD COLUMN `billingCycle` VARCHAR(32) NOT NULL DEFAULT 'MONTHLY';

ALTER TABLE `plans`
  ADD COLUMN `maxMembers` INT NULL;
