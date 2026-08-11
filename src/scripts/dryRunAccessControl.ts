/**
 * DB-backed dry-run for device access control (read-only).
 * Usage: npx tsx src/scripts/dryRunAccessControl.ts [deviceConfigId]
 */
import { prisma } from '../lib/prisma';
import { getDeviceAccessControlTargets } from '../services/deviceAccessControlService';

async function main() {
  const deviceConfigId = Number(process.argv[2] || 3);
  if (!Number.isFinite(deviceConfigId) || deviceConfigId <= 0) {
    throw new Error(`Invalid deviceConfigId: ${process.argv[2]}`);
  }

  const device = await prisma.deviceConfig.findUnique({
    where: { id: deviceConfigId },
    select: { id: true, gymId: true, name: true, ipAddress: true },
  });
  if (!device) {
    throw new Error(`Device config ${deviceConfigId} not found`);
  }

  const mappingCount = await prisma.deviceUserMapping.count({
    where: { deviceConfigId, isActive: true },
  });

  console.log('--- DB dry-run (no device writes) ---');
  console.log(`device id=${device.id} name=${device.name} gymId=${device.gymId} ip=${device.ipAddress}`);
  console.log(`active mappings=${mappingCount}`);

  const payload = await getDeviceAccessControlTargets(device.gymId, device.id, {
    activeGroup: '1',
    blockedGroup: '2',
  });

  console.log(`groups active=${payload.groups.active} blocked=${payload.groups.blocked}`);
  console.log(`blocked=${payload.blocked.length} allowed=${payload.allowed.length}`);

  const byReason = payload.blocked.reduce<Record<string, number>>((acc, row) => {
    acc[row.reason] = (acc[row.reason] || 0) + 1;
    return acc;
  }, {});
  console.log('blockedByReason', byReason);

  console.log('sample blocked (up to 10):');
  for (const row of payload.blocked.slice(0, 10)) {
    console.log(
      `  uid=${row.deviceUserId} memberId=${row.memberId} name=${row.memberName} reason=${row.reason}`
    );
  }
  console.log('sample allowed (up to 5):');
  for (const row of payload.allowed.slice(0, 5)) {
    console.log(`  uid=${row.deviceUserId} memberId=${row.memberId} name=${row.memberName}`);
  }

  // Sanity: no overlap
  const blockedIds = new Set(payload.blocked.map((b) => b.deviceUserId));
  const overlap = payload.allowed.filter((a) => blockedIds.has(a.deviceUserId));
  if (overlap.length) {
    throw new Error(`Overlap between blocked and allowed: ${overlap.map((o) => o.deviceUserId).join(',')}`);
  }
  console.log('sanity: no blocked/allowed overlap OK');
  console.log('DRY_RUN_DB_PASS');
}

main()
  .catch((err) => {
    console.error('DRY_RUN_DB_FAIL', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
