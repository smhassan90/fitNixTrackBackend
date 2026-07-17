/**
 * Thorough payment integrity audit for gym after historical-signup repair.
 *
 * Usage:
 *   npx tsx prisma/audit-payment-integrity.ts --gym-id=3
 */
import dotenv from 'dotenv';
dotenv.config();

const base = process.env.DATABASE_URL ?? '';
if (!/connect_timeout=/.test(base)) {
  process.env.DATABASE_URL = `${base}${base.includes('?') ? '&' : '?'}connect_timeout=60&pool_timeout=60`;
}

function parseArgs() {
  const gymArg = process.argv.find((a) => a.startsWith('--gym-id='));
  return { gymId: gymArg ? parseInt(gymArg.split('=')[1], 10) : 3 };
}

async function main() {
  const { gymId } = parseArgs();
  const { PrismaClient } = await import('@prisma/client');
  const {
    syncMissingNextMonthlyInstallment,
    selectPhantomGapUnpaidPayments,
    startOfCurrentGymMonth,
    isPreOperationsAdmission,
  } = await import('../src/services/paymentService');
  const { formatMonth } = await import('../src/utils/dateHelpers');

  const prisma = new PrismaClient();
  const resumeFrom = startOfCurrentGymMonth();
  const issues: string[] = [];
  const warnings: string[] = [];

  try {
    console.log(`Gym ${gymId} — payment integrity audit`);
    console.log(`Current gym month start: ${resumeFrom.toISOString().slice(0, 10)}`);

    const members = await prisma.member.findMany({
      where: { gymId, oneTimePaymentPaid: true, membershipStart: { not: null } },
      select: {
        id: true,
        legacyMemberId: true,
        name: true,
        isActive: true,
        membershipStart: true,
        billingResumeFrom: true,
      },
    });

    let phantomRemaining = 0;
    let highOverdue = 0;
    let signupSeedNoResume = 0;

    for (const m of members) {
      if (!m.membershipStart) continue;
      const payments = await prisma.payment.findMany({
        where: { memberId: m.id, gymId },
        select: { id: true, month: true, status: true, dueDate: true },
        orderBy: { dueDate: 'asc' },
      });

      const { gapUnpaid } = selectPhantomGapUnpaidPayments({
        membershipStart: m.membershipStart,
        payments,
        resumeFrom,
      });
      if (gapUnpaid.length > 0) {
        phantomRemaining++;
        issues.push(
          `PHANTOM_GAP ${m.legacyMemberId ?? m.id} ${m.name}: ${gapUnpaid.length} unpaid gap rows (${gapUnpaid.map((p) => p.month).join(',')})`
        );
      }

      const overdue = payments.filter((p) => p.status === 'OVERDUE');
      if (overdue.length >= 6) {
        highOverdue++;
        warnings.push(
          `HIGH_OVERDUE ${m.legacyMemberId ?? m.id} ${m.name}: ${overdue.length} overdue (${overdue.map((p) => p.month).join(',')})`
        );
      }

      const paid = payments.filter((p) => p.status === 'PAID');
      const month1 = formatMonth(m.membershipStart);
      if (
        isPreOperationsAdmission(m.membershipStart) &&
        paid.length === 1 &&
        paid[0].month === month1 &&
        !m.billingResumeFrom
      ) {
        signupSeedNoResume++;
        warnings.push(
          `SEED_ONLY_NO_RESUME ${m.legacyMemberId ?? m.id} ${m.name}: pre-ops admission month paid, no billingResumeFrom`
        );
      }
    }

    console.log('\n--- Re-sync regression check ---');
    for (const legacy of ['125', '126', '109', '21']) {
      const m = await prisma.member.findFirst({
        where: { gymId, legacyMemberId: legacy },
        select: { id: true, legacyMemberId: true, name: true, membershipStart: true, billingResumeFrom: true },
      });
      if (!m) continue;
      const before = await prisma.payment.groupBy({
        by: ['status'],
        where: { memberId: m.id, gymId },
        _count: true,
      });
      await syncMissingNextMonthlyInstallment(m.id, gymId);
      const after = await prisma.payment.groupBy({
        by: ['status'],
        where: { memberId: m.id, gymId },
        _count: true,
      });
      const beforeOverdue = before.find((x) => x.status === 'OVERDUE')?._count ?? 0;
      const afterOverdue = after.find((x) => x.status === 'OVERDUE')?._count ?? 0;
      const beforePending = before.find((x) => x.status === 'PENDING')?._count ?? 0;
      const afterPending = after.find((x) => x.status === 'PENDING')?._count ?? 0;
      const payments = await prisma.payment.findMany({
        where: { memberId: m.id, gymId },
        orderBy: { dueDate: 'asc' },
        select: { month: true, status: true },
      });
      console.log(
        `  ${legacy} ${m.name}: overdue ${beforeOverdue}→${afterOverdue}, pending ${beforePending}→${afterPending}`
      );
      console.log(`    resume=${m.billingResumeFrom?.toISOString().slice(0, 10) ?? 'null'} payments=${payments.map((p) => `${p.month}:${p.status}`).join(',')}`);
      if (afterOverdue > beforeOverdue + 1) {
        issues.push(
          `SYNC_REGRESSION ${legacy} ${m.name}: overdue grew ${beforeOverdue} → ${afterOverdue} after sync`
        );
      }
      if (legacy === '126' && afterOverdue > 0) {
        issues.push(`126 should stay at 0 overdue after sync`);
      }
      if (legacy === '109' && afterOverdue < 3) {
        warnings.push(`109 expected several overdue months after restore, has ${afterOverdue}`);
      }
    }

    console.log('\n--- Expected shape checks (125 / 126) ---');
    for (const legacy of ['125', '126']) {
      const m = await prisma.member.findFirst({
        where: { gymId, legacyMemberId: legacy },
        select: {
          id: true,
          name: true,
          isActive: true,
          billingResumeFrom: true,
        },
      });
      if (!m) {
        issues.push(`MISSING member ${legacy}`);
        continue;
      }
      const payments = await prisma.payment.findMany({
        where: { memberId: m.id, gymId },
        orderBy: { dueDate: 'asc' },
        select: { month: true, status: true },
      });
      console.log(
        `  ${legacy} ${m.name}: active=${m.isActive} resume=${m.billingResumeFrom?.toISOString().slice(0, 10) ?? 'null'} → ${payments.map((p) => `${p.month}:${p.status}`).join(', ')}`
      );
      if (!m.isActive) issues.push(`${legacy} should be active`);
      if (legacy === '126') {
        const overdue = payments.filter((p) => p.status === 'OVERDUE');
        if (overdue.length > 0) {
          issues.push(`126 should have 0 overdue, has ${overdue.map((p) => p.month).join(',')}`);
        }
        if (!payments.some((p) => p.month === '2025-01' && p.status === 'PAID')) {
          issues.push('126 missing admission month PAID');
        }
      }
      if (legacy === '125') {
        if (payments.some((p) => p.month === '2025-02' && p.status !== 'PAID')) {
          issues.push('125 still has phantom 2025-02 unpaid');
        }
        if (!payments.some((p) => p.month === '2026-06' && p.status === 'OVERDUE')) {
          warnings.push('125 expected 2026-06 OVERDUE (legitimate) — missing or paid');
        }
      }
    }

    console.log('\n--- Summary ---');
    console.log(`Members scanned: ${members.length}`);
    console.log(`Phantom gaps remaining: ${phantomRemaining}`);
    console.log(`Members with >=6 overdue: ${highOverdue}`);
    console.log(`Signup-seed-only without resume: ${signupSeedNoResume}`);
    console.log(`Issues: ${issues.length}`);
    console.log(`Warnings: ${warnings.length}`);
    for (const i of issues) console.log(`  ISSUE: ${i}`);
    for (const w of warnings.slice(0, 50)) console.log(`  WARN: ${w}`);
    if (warnings.length > 50) console.log(`  ... ${warnings.length - 50} more warnings`);

    if (issues.length > 0) {
      process.exitCode = 1;
    } else {
      console.log('\nPASS: no critical payment integrity issues found');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
