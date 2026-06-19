/**
 * Restores plans/features columns and billing_payments table when DB drifted from schema.
 * Usage: npx tsx prisma/restore-dropped-columns.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run(sql: string, label: string) {
  try {
    await prisma.$executeRawUnsafe(sql);
    console.log(`OK: ${label}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Duplicate column|Duplicate key name|already exists|1050|1060|1061/i.test(msg)) {
      console.log(`SKIP (already applied): ${label}`);
      return;
    }
    console.error(`FAIL: ${label}`);
    throw e;
  }
}

async function main() {
  const statements: Array<[string, string]> = [
    [`ALTER TABLE plans ADD COLUMN code VARCHAR(64) NULL`, 'plans.code'],
    [`ALTER TABLE plans ADD COLUMN description TEXT NULL`, 'plans.description'],
    [`ALTER TABLE plans ADD COLUMN currency VARCHAR(10) NOT NULL DEFAULT 'PKR'`, 'plans.currency'],
    [`ALTER TABLE plans ADD COLUMN isActive TINYINT(1) NOT NULL DEFAULT 1`, 'plans.isActive'],
    [`ALTER TABLE plans ADD COLUMN sortOrder INT NOT NULL DEFAULT 0`, 'plans.sortOrder'],
    [`ALTER TABLE plans ADD COLUMN deletedAt DATETIME(3) NULL`, 'plans.deletedAt'],
    [
      `UPDATE plans SET code = CONCAT('PLAN_', id), currency = 'PKR', isActive = 1, sortOrder = id WHERE code IS NULL OR code = ''`,
      'plans backfill',
    ],
    [`ALTER TABLE plans ADD UNIQUE INDEX plans_code_key (code)`, 'plans.code unique'],
    [`ALTER TABLE features ADD COLUMN code VARCHAR(64) NULL`, 'features.code'],
    [`ALTER TABLE features ADD COLUMN description TEXT NULL`, 'features.description'],
    [`ALTER TABLE features ADD COLUMN isActive TINYINT(1) NOT NULL DEFAULT 1`, 'features.isActive'],
    [`ALTER TABLE features ADD COLUMN sortOrder INT NOT NULL DEFAULT 0`, 'features.sortOrder'],
    [`ALTER TABLE features ADD COLUMN deletedAt DATETIME(3) NULL`, 'features.deletedAt'],
    [`ALTER TABLE features ADD UNIQUE INDEX features_code_key (code)`, 'features.code unique'],
    [
      `CREATE TABLE billing_payments (
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
      )`,
      'billing_payments table',
    ],
  ];

  for (const [sql, label] of statements) {
    await run(sql, label);
  }

  console.log('\nDone. Verify with: npx prisma db pull --print | findstr code');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
