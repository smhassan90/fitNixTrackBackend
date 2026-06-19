-- Restore columns/tables dropped by an earlier `prisma db push`.
-- Run ONCE in MySQL (phpMyAdmin / DBeaver / CLI).
-- If a statement fails with "Duplicate column" or "Duplicate key name", skip it and continue.

-- 1) plans
ALTER TABLE plans ADD COLUMN code VARCHAR(64) NULL;
ALTER TABLE plans ADD COLUMN description TEXT NULL;
ALTER TABLE plans ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'PKR';
ALTER TABLE plans ADD COLUMN isActive TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE plans ADD COLUMN sortOrder INT NOT NULL DEFAULT 0;
ALTER TABLE plans ADD COLUMN deletedAt DATETIME(3) NULL;

UPDATE plans
SET
  code = CONCAT('PLAN_', id),
  currency = 'PKR',
  isActive = 1,
  sortOrder = id
WHERE code IS NULL OR code = '';

ALTER TABLE plans ADD UNIQUE INDEX plans_code_key (code);

-- 2) features
ALTER TABLE features ADD COLUMN code VARCHAR(64) NULL;
ALTER TABLE features ADD COLUMN description TEXT NULL;
ALTER TABLE features ADD COLUMN isActive TINYINT(1) NOT NULL DEFAULT 1;
ALTER TABLE features ADD COLUMN sortOrder INT NOT NULL DEFAULT 0;
ALTER TABLE features ADD COLUMN deletedAt DATETIME(3) NULL;

ALTER TABLE features ADD UNIQUE INDEX features_code_key (code);

-- 3) billing_payments
CREATE TABLE billing_payments (
  id INT NOT NULL AUTO_INCREMENT,
  gymId INT NOT NULL,
  amountPaid DOUBLE NOT NULL,
  currency VARCHAR(10) NOT NULL,
  paidAt DATE NOT NULL,
  method VARCHAR(32) NOT NULL,
  notes TEXT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PAID',
  receiptNo VARCHAR(64) NOT NULL,
  createdBy INT NOT NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updatedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY billing_payments_receiptNo_key (receiptNo),
  KEY billing_payments_gymId_idx (gymId),
  KEY billing_payments_paidAt_idx (paidAt),
  CONSTRAINT billing_payments_gymId_fkey FOREIGN KEY (gymId) REFERENCES gyms(id) ON DELETE CASCADE
);
