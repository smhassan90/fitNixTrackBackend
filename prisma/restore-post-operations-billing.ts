/**
 * Restore post-operations members whose legitimate overdue was wiped when
 * billingResumeFrom was incorrectly set to the current month.
 *
 * Usage:
 *   npx tsx prisma/restore-post-operations-billing.ts --gym-id=3 --dry-run
 *   npx tsx prisma/restore-post-operations-billing.ts --gym-id=3
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
  console.log(
    `Gym ${gymId} — restore post-operations billing after wrong resume${dryRun ? ' (DRY RUN)' : ''}`
  );

  const { restorePostOperationsBillingAfterWrongResume } = await import(
    '../src/services/paymentService'
  );

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const result = await restorePostOperationsBillingAfterWrongResume(gymId, { dryRun });
      console.log(
        `Scanned ${result.scanned}, restored ${dryRun ? 'candidates' : ''}: ${result.restored}`
      );
      for (const m of result.members) {
        console.log(
          `  ${m.legacyMemberId ?? m.memberId} ${m.name} (joined ${m.membershipStart})`
        );
      }
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`Attempt ${attempt}/5 failed:`, e instanceof Error ? e.message : e);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw lastErr;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
