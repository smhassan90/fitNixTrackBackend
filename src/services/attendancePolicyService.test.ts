import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAutoCheckoutForOpenSessions,
  markMembersInactiveAfterAbsence,
} from './attendancePolicyService';
import { prisma } from '../lib/prisma';
import { runWithGymContext } from '../utils/gymContext';

type Restore = () => void;
const restores: Restore[] = [];

function mockMethod<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]) {
  const previous = obj[key];
  (obj as any)[key] = value;
  restores.push(() => {
    (obj as any)[key] = previous;
  });
}

afterEach(() => {
  while (restores.length) restores.pop()?.();
});

test('auto-checkout closes sessions older than the configured hours', async () => {
  const now = Date.now();
  const stale = new Date(now - 7 * 60 * 60 * 1000);
  const recent = new Date(now - 2 * 60 * 60 * 1000);
  mockMethod(prisma.attendanceRecord as any, 'findMany', (async () => [
    { id: 1, checkInTime: stale },
    { id: 2, checkInTime: recent },
  ]) as any);
  const closed: Array<{ id: number; checkOutTime: Date }> = [];
  mockMethod(prisma.attendanceRecord as any, 'update', (async (args: any) => {
    closed.push({ id: args.where.id, checkOutTime: args.data.checkOutTime });
    return { id: args.where.id };
  }) as any);

  const count = await applyAutoCheckoutForOpenSessions(10, 6);

  assert.equal(count, 1);
  assert.equal(closed.length, 1);
  assert.equal(closed[0].id, 1);
  assert.equal(closed[0].checkOutTime.getTime(), stale.getTime() + 6 * 60 * 60 * 1000);
});

test('absence policy skips never-checked-in members and clears future unpaid dues', async () => {
  mockMethod(prisma.member as any, 'findMany', (async () => [{ id: 21 }, { id: 22 }]) as any);
  mockMethod(prisma.attendanceRecord as any, 'groupBy', (async () => [
    { memberId: 21, _max: { checkInTime: new Date('2026-01-01T00:00:00.000Z') } },
  ]) as any);
  let deactivatedId: number | undefined;
  let deletedWhere: any;
  mockMethod(prisma as any, '$transaction', (async (callback: any) => {
    const tx = {
      member: {
        update: async (args: any) => {
          deactivatedId = args.where.id;
          return { id: deactivatedId, isActive: false };
        },
      },
      payment: {
        deleteMany: async (args: any) => {
          deletedWhere = args.where;
          return { count: 2 };
        },
      },
    };
    return callback(tx);
  }) as any);

  const marked = await runWithGymContext(
    { gymId: 10, timezone: 'Asia/Karachi' },
    () => markMembersInactiveAfterAbsence(10, 14)
  );

  assert.equal(marked, 1);
  assert.equal(deactivatedId, 21);
  assert.equal(deletedWhere.memberId, 21);
  assert.deepEqual(deletedWhere.status.in, ['PENDING', 'OVERDUE']);
  assert.ok(deletedWhere.dueDate.gte instanceof Date);
});
