-- Fee collection ledger: immutable record when a member payment is marked paid.

CREATE TABLE IF NOT EXISTS fee_collections (
  id INT NOT NULL AUTO_INCREMENT,
  gymId INT NOT NULL,
  memberId INT NOT NULL,
  amount DOUBLE NOT NULL,
  collectedAt DATETIME(3) NOT NULL,
  billingMonth VARCHAR(7) NULL,
  category ENUM('MONTHLY_FEE', 'SIGNUP_FEE', 'ADMISSION_ONLY') NOT NULL,
  description VARCHAR(255) NOT NULL,
  sourceType ENUM('MONTHLY_PAYMENT', 'ONE_TIME_PAYMENT') NOT NULL,
  sourceId INT NOT NULL,
  createdAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY fee_collections_sourceType_sourceId_key (sourceType, sourceId),
  KEY fee_collections_gymId_idx (gymId),
  KEY fee_collections_memberId_idx (memberId),
  KEY fee_collections_gymId_collectedAt_idx (gymId, collectedAt),
  KEY fee_collections_gymId_billingMonth_idx (gymId, billingMonth),
  CONSTRAINT fee_collections_gymId_fkey FOREIGN KEY (gymId) REFERENCES gyms(id) ON DELETE CASCADE,
  CONSTRAINT fee_collections_memberId_fkey FOREIGN KEY (memberId) REFERENCES members(id) ON DELETE CASCADE
);

-- Backfill signup / one-time collections
INSERT INTO fee_collections (gymId, memberId, amount, collectedAt, billingMonth, category, description, sourceType, sourceId, createdAt)
SELECT
  otp.gymId,
  otp.memberId,
  otp.totalAmount,
  COALESCE(otp.paidDate, otp.updatedAt),
  DATE_FORMAT(m.membershipStart, '%Y-%m'),
  CASE
    WHEN otp.totalAmount <= otp.admissionFee + 0.01 THEN 'ADMISSION_ONLY'
    ELSE 'SIGNUP_FEE'
  END,
  CASE
    WHEN otp.totalAmount <= otp.admissionFee + 0.01 THEN CONCAT('Admission fee — ', m.name)
    ELSE CONCAT('Signup payment (admission + first month) — ', m.name)
  END,
  'ONE_TIME_PAYMENT',
  otp.id,
  NOW(3)
FROM one_time_payments otp
INNER JOIN members m ON m.id = otp.memberId
WHERE otp.status = 'PAID'
  AND NOT EXISTS (
    SELECT 1 FROM fee_collections fc
    WHERE fc.sourceType = 'ONE_TIME_PAYMENT' AND fc.sourceId = otp.id
  );

-- Backfill monthly collections (skip month-1 rows already covered by signup one-time)
INSERT INTO fee_collections (gymId, memberId, amount, collectedAt, billingMonth, category, description, sourceType, sourceId, createdAt)
SELECT
  p.gymId,
  p.memberId,
  p.amount,
  COALESCE(p.paidDate, p.updatedAt),
  p.month,
  'MONTHLY_FEE',
  CONCAT('Monthly membership fee (', p.month, ') — ', m.name),
  'MONTHLY_PAYMENT',
  p.id,
  NOW(3)
FROM payments p
INNER JOIN members m ON m.id = p.memberId
WHERE p.status = 'PAID'
  AND NOT EXISTS (
    SELECT 1 FROM fee_collections fc
    WHERE fc.sourceType = 'MONTHLY_PAYMENT' AND fc.sourceId = p.id
  )
  AND NOT (
    m.oneTimePaymentPaid = 1
    AND m.membershipStart IS NOT NULL
    AND p.month = DATE_FORMAT(m.membershipStart, '%Y-%m')
    AND EXISTS (
      SELECT 1 FROM one_time_payments otp
      WHERE otp.memberId = p.memberId
        AND otp.status = 'PAID'
        AND otp.totalAmount > otp.admissionFee + 0.01
    )
  );
