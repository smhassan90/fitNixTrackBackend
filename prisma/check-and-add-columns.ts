/**
 * One-off: verify/add `users.permissionKeys` and `members.photoUrl`.
 * Usage: npx tsx prisma/check-and-add-columns.ts [--apply]
 */
import { prisma } from '../src/lib/prisma';

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint | number }>>(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    table,
    column
  );
  return Number(rows[0]?.cnt ?? 0) > 0;
}

async function main() {
  const apply = process.argv.includes('--apply');

  const checks: Array<{ table: string; column: string; ddl: string }> = [
    {
      table: 'users',
      column: 'permissionKeys',
      ddl: 'ALTER TABLE `users` ADD COLUMN `permissionKeys` JSON NULL AFTER `role`',
    },
    {
      table: 'members',
      column: 'photoUrl',
      ddl: 'ALTER TABLE `members` ADD COLUMN `photoUrl` VARCHAR(2048) NULL AFTER `comments`',
    },
    {
      table: 'gyms',
      column: 'timezone',
      ddl: "ALTER TABLE `gyms` ADD COLUMN `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC' AFTER `syncApiKey`",
    },
  ];

  for (const check of checks) {
    const exists = await columnExists(check.table, check.column);
    console.log(`${check.table}.${check.column}: ${exists ? 'EXISTS' : 'MISSING'}`);
    if (!exists && apply) {
      await prisma.$executeRawUnsafe(check.ddl);
      console.log(`  -> added ${check.table}.${check.column}`);
    }
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to add missing columns.');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
