/**
 * Mark all PENDING signup one-time payments as PAID using historical dates
 * (member admission / join date), so fee reports are not inflated for today.
 *
 * Usage:
 *   npx tsx prisma/backfill-pending-signup-payments.ts --gym-id=3
 *   npx tsx prisma/backfill-pending-signup-payments.ts --gym-id=3 --dry-run
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { markSignupOneTimePaidAtDate } from '../src/services/paymentService';

const prisma = new PrismaClient();

function parseArgs() {
  const gymArg = process.argv.find((a) => a.startsWith('--gym-id='));
  const gymId = gymArg ? parseInt(gymArg.split('=')[1], 10) : 3;
  const dryRun = process.argv.includes('--dry-run');
  return { gymId, dryRun };
}

async function main() {
  const { gymId, dryRun } = parseArgs();
  console.log(`Gym ${gymId} — backfill pending signup one-time payments${dryRun ? ' (DRY RUN)' : ''}`);

  const pending = await prisma.oneTimePayment.findMany({
    where: { gymId, status: 'PENDING' },
    include: {
      member: {
        select: {
          id: true,
          legacyMemberId: true,
          name: true,
          membershipStart: true,
        },
      },
    },
    orderBy: { id: 'asc' },
  });

  console.log(`Found ${pending.length} pending signup payment(s)`);

  if (pending.length === 0) {
    if (!dryRun) {
      const synced = await prisma.$executeRaw`
        UPDATE members m
        INNER JOIN one_time_payments o ON o.memberId = m.id AND o.gymId = m.gymId
        SET m.oneTimePaymentPaid = 1, m.updatedAt = NOW(3)
        WHERE m.gymId = ${gymId}
          AND m.oneTimePaymentPaid = 0
          AND o.status = 'PAID'
      `;
      if (synced > 0) {
        console.log(`Synced oneTimePaymentPaid flag on ${synced} member(s)`);
      }
    }
    const staleMembers = await prisma.member.count({
      where: { gymId, oneTimePaymentPaid: false },
    });
    console.log(`Members with oneTimePaymentPaid=false: ${staleMembers}`);
    return;
  }

  let fixed = 0;
  let failed = 0;

  for (const row of pending) {
    const label = `${row.member.legacyMemberId ?? row.memberId} ${row.member.name}`;
    const paidOn = row.member.membershipStart?.toISOString().slice(0, 10) ?? '(from first monthly paid)';

    if (dryRun) {
      console.log(`  WOULD mark PAID: ${label} — Rs ${row.totalAmount} on ${paidOn}`);
      fixed++;
      continue;
    }

    try {
      const result = await markSignupOneTimePaidAtDate(row.id, gymId, {
        seedMonthly: true,
      });
      if (result) {
        console.log(
          `  OK: ${label} — Rs ${row.totalAmount} marked PAID on ${result.paidDate.toISOString().slice(0, 10)}`
        );
        fixed++;
      }
    } catch (e) {
      failed++;
      console.error(`  FAIL: ${label} —`, e instanceof Error ? e.message : e);
    }
  }

  // Sync members who are PAID in one_time_payments but flag still false
  if (!dryRun) {
    const synced = await prisma.$executeRaw`
      UPDATE members m
      INNER JOIN one_time_payments o ON o.memberId = m.id AND o.gymId = m.gymId
      SET m.oneTimePaymentPaid = 1, m.updatedAt = NOW(3)
      WHERE m.gymId = ${gymId}
        AND m.oneTimePaymentPaid = 0
        AND o.status = 'PAID'
    `;
    if (synced > 0) {
      console.log(`Synced oneTimePaymentPaid flag on ${synced} member(s)`);
    }
  }

  const remaining = await prisma.oneTimePayment.count({
    where: { gymId, status: 'PENDING' },
  });

  console.log(`\nDone. Fixed: ${fixed}, Failed: ${failed}, Remaining PENDING: ${remaining}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
