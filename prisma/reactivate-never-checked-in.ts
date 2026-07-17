/**
 * Reactivate members wrongly auto-deactivated by absence policy because they
 * had never checked in on this system (common right after CSV import).
 *
 * Usage:
 *   npx tsx prisma/reactivate-never-checked-in.ts --gym-id=3 --dry-run
 *   npx tsx prisma/reactivate-never-checked-in.ts --gym-id=3
 */
import dotenv from 'dotenv';
dotenv.config();

const base = process.env.DATABASE_URL ?? '';
if (!/connect_timeout=/.test(base)) {
  process.env.DATABASE_URL = `${base}${base.includes('?') ? '&' : '?'}connect_timeout=60&pool_timeout=60`;
}

function parseArgs() {
  const gymArg = process.argv.find((a) => a.startsWith('--gym-id='));
  const gymId = gymArg ? parseInt(gymArg.split('=')[1], 10) : 3;
  const dryRun = process.argv.includes('--dry-run');
  return { gymId, dryRun };
}

async function main() {
  const { gymId, dryRun } = parseArgs();
  const { PrismaClient } = await import('@prisma/client');
  const { syncMissingNextMonthlyInstallment, markOverduePayments } = await import(
    '../src/services/paymentService'
  );
  const prisma = new PrismaClient();

  console.log(
    `Gym ${gymId} — reactivate never-checked-in members${dryRun ? ' (DRY RUN)' : ''}`
  );

  try {
    const inactive = await prisma.member.findMany({
      where: { gymId, isActive: false },
      select: {
        id: true,
        legacyMemberId: true,
        name: true,
        inactiveFrom: true,
        membershipStart: true,
      },
    });

    const withCheckIn = new Set(
      (
        await prisma.attendanceRecord.findMany({
          where: {
            gymId,
            memberId: { in: inactive.map((m) => m.id) },
            checkInTime: { not: null },
          },
          select: { memberId: true },
          distinct: ['memberId'],
        })
      ).map((r) => r.memberId)
    );

    // Never checked in, and not imported as inactive on join day
    const candidates = inactive.filter((m) => {
      if (withCheckIn.has(m.id)) return false;
      if (!m.inactiveFrom || !m.membershipStart) return true;
      const inactiveDay = m.inactiveFrom.toISOString().slice(0, 10);
      const joinDay = m.membershipStart.toISOString().slice(0, 10);
      return inactiveDay !== joinDay;
    });

    console.log(
      `Inactive: ${inactive.length}, never-checked-in candidates: ${candidates.length}`
    );

    if (dryRun) {
      for (const m of candidates.slice(0, 30)) {
        console.log(`  WOULD reactivate ${m.legacyMemberId ?? m.id} ${m.name}`);
      }
      if (candidates.length > 30) console.log(`  ... +${candidates.length - 30} more`);
      return;
    }

    let done = 0;
    for (const m of candidates) {
      await prisma.member.update({
        where: { id: m.id },
        data: { isActive: true, inactiveFrom: null },
      });
      await syncMissingNextMonthlyInstallment(m.id, gymId);
      done++;
      if (done % 25 === 0) console.log(`  ... ${done}/${candidates.length}`);
    }
    await markOverduePayments(gymId);

    const active = await prisma.member.count({ where: { gymId, isActive: true } });
    console.log(`Reactivated ${done}. Active members now: ${active}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
