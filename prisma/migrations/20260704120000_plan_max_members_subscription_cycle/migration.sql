-- Platform subscription tiers: monthly base price + max members; gym selects billing cycle.
ALTER TABLE `plans`
  ADD COLUMN `maxMembers` INT NULL;

ALTER TABLE `gym_subscriptions`
  ADD COLUMN `billingCycle` VARCHAR(32) NOT NULL DEFAULT 'MONTHLY';
