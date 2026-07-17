/**
 * Repair false overdue months created by historical signup mark-paid + seedMonthly.
 *
 * Pattern: admission/join month is PAID (from signup), then every later month through
 * today was invented as OVERDUE — even when the gym was not open yet.
 *
 * Usage:
 *   npx tsx prisma/repair-historical-signup-overdue.ts --gym-id=3 --dry-run
 *   npx tsx prisma/repair-historical-signup-overdue.ts --gym-id=3
 */
import dotenv from 'dotenv';

dotenv.config();

function parseArgs() {
  const gymArg = process.argv.find((a) => a.startsWith('--gym-id='));
  const gymId = gymArg ? parseInt(gymArg.split('=')[1], 10) : 3;
  const dryRun = process.argv.includes('--dry-run');
  return { gymId, dryRun };
}

function withTimeout(url: string): string {
  if (/connect_timeout=/.test(url)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}connect_timeout=60&pool_timeout=60`;
}

async function main() {
  const { gymId, dryRun } = parseArgs();
  process.env.DATABASE_URL = withTimeout(process.env.DATABASE_URL ?? '');

  console.log(
    `Gym ${gymId} — repair historical signup overdue backfill${dryRun ? ' (DRY RUN)' : ''}`
  );

  // Import after DATABASE_URL is patched so shared prisma picks up timeouts.
  const { repairHistoricalSignupOverdueBackfill } = await import(
    '../src/services/paymentService'
  );

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const result = await repairHistoricalSignupOverdueBackfill(gymId, {
        dryRun,
        reactivateAutoInactive: true,
      });

      console.log(
        `Scanned ${result.scanned}, repair ${dryRun ? 'candidates' : 'done'}: ${result.repaired}, reactivated: ${result.reactivated}, skipped: ${result.skipped}`
      );

      for (const m of result.members) {
        const id = m.legacyMemberId ?? m.memberId;
        console.log(
          `  ${id} ${m.name} — remove ${m.overdueRemoved} gap unpaid` +
            (m.reactivated ? ', reactivate' : '')
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
