-- Platform SaaS: gym tenant fields, subscriptions, platform users, audit logs
-- Run once against MySQL 5.7+ (JSON support). Safe to re-run only if you guard duplicates manually.

ALTER TABLE gyms
  ADD COLUMN slug VARCHAR(191) NULL UNIQUE,
  ADD COLUMN logoUrl VARCHAR(2048) NULL,
  ADD COLUMN city VARCHAR(191) NULL,
  ADD COLUMN country VARCHAR(191) NULL,
  ADD COLUMN tenantStatus ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE users
  ADD COLUMN tokenVersion INT NOT NULL DEFAULT 0;

CREATE TABLE plans (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(191) NOT NULL,
  price DOUBLE NOT NULL,
  billingCycle VARCHAR(32) NOT NULL,
  features JSON NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE gym_subscriptions (
  id INT NOT NULL AUTO_INCREMENT,
  gymId INT NOT NULL,
  planId INT NOT NULL,
  dueDate DATE NOT NULL,
  billingResumeFrom DATETIME(3) NULL,
  status ENUM('ACTIVE', 'TRIAL', 'PAST_DUE', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
  lastPaidAt DATETIME(3) NULL,
  notes TEXT NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY gym_subscriptions_gymId_key (gymId),
  KEY gym_subscriptions_planId_idx (planId),
  KEY gym_subscriptions_dueDate_idx (dueDate),
  CONSTRAINT gym_subscriptions_gymId_fkey FOREIGN KEY (gymId) REFERENCES gyms (id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT gym_subscriptions_planId_fkey FOREIGN KEY (planId) REFERENCES plans (id) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE platform_users (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(191) NOT NULL,
  email VARCHAR(191) NOT NULL,
  password VARCHAR(191) NOT NULL,
  role ENUM('SUPER_ADMIN', 'PLATFORM_SUPPORT') NOT NULL DEFAULT 'PLATFORM_SUPPORT',
  tokenVersion INT NOT NULL DEFAULT 0,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY platform_users_email_key (email)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE platform_audit_logs (
  id INT NOT NULL AUTO_INCREMENT,
  actorUserId INT NOT NULL,
  actorRole VARCHAR(32) NOT NULL,
  actionType VARCHAR(64) NOT NULL,
  targetGymId INT NULL,
  metadata JSON NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY platform_audit_logs_actorUserId_idx (actorUserId),
  KEY platform_audit_logs_targetGymId_idx (targetGymId),
  KEY platform_audit_logs_createdAt_idx (createdAt),
  CONSTRAINT platform_audit_logs_actorUserId_fkey FOREIGN KEY (actorUserId) REFERENCES platform_users (id) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO plans (name, price, billingCycle, features, createdAt, updatedAt)
SELECT 'Standard', 0, 'MONTHLY', CAST('{}' AS JSON), NOW(3), NOW(3)
FROM (SELECT 1 AS _) AS _seed
WHERE NOT EXISTS (SELECT 1 FROM plans);

INSERT INTO gym_subscriptions (gymId, planId, dueDate, status, createdAt, updatedAt)
SELECT g.id, p.id, DATE_ADD(CURDATE(), INTERVAL 30 DAY), 'ACTIVE', NOW(3), NOW(3)
FROM gyms g
CROSS JOIN (SELECT id FROM plans ORDER BY id ASC LIMIT 1) p
WHERE NOT EXISTS (SELECT 1 FROM gym_subscriptions s WHERE s.gymId = g.id);
