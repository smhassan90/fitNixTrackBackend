import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { manualCheckIn, manualCheckOut } from './manualAttendanceService';
import { prisma } from '../lib/prisma';

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

function mockResolvedMember(isActive = true) {
  let call = 0;
  mockMethod(prisma.member as any, 'findFirst', (async () => {
    call += 1;
    if (call === 1) return { id: 21 };
    return { id: 21, gymId: 10, name: 'Ali', isActive };
  }) as any);
}

test('manualCheckIn creates attendance and returns overdue alert', async () => {
  mockResolvedMember(true);
  mockMethod(prisma.attendanceRecord as any, 'findUnique', (async () => null) as any);
  const checkInTime = new Date('2026-08-14T05:00:00.000Z');
  let createData: any;
  mockMethod(prisma.attendanceRecord as any, 'create', (async (args: any) => {
    createData = args.data;
    return {
      id: 50,
      memberId: 21,
      checkInTime,
      member: {
        id: 21,
        legacyMemberId: 'M-21',
        name: 'Ali',
        phone: '03000000000',
        email: null,
      },
    };
  }) as any);
  mockMethod(prisma.payment as any, 'findMany', (async () => [{
    memberId: 21,
    status: 'OVERDUE',
    dueDate: new Date('2026-07-15T00:00:00.000Z'),
    amount: 3000,
    month: '2026-07',
  }]) as any);

  const result = await manualCheckIn(10, 21, checkInTime);

  assert.equal(createData.gymId, 10);
  assert.equal(createData.memberId, 21);
  assert.equal(createData.status, 'PRESENT');
  assert.equal(createData.date.toISOString(), '2026-08-14T00:00:00.000Z');
  assert.equal(result.attendanceRecordId, '50');
  assert.equal(result.overdueAlerts.length, 1);
  assert.equal(result.overdueAlerts[0].overdueAmount, 3000);
  assert.equal(result.overdueAlerts[0].memberNumber, 'M-21');
});

test('manualCheckIn blocks inactive members', async () => {
  mockResolvedMember(false);
  await assert.rejects(
    () => manualCheckIn(10, 21, new Date('2026-08-14T05:00:00.000Z')),
    /inactive member/i
  );
});

test('manualCheckIn rejects duplicate open check-in', async () => {
  mockResolvedMember(true);
  mockMethod(prisma.attendanceRecord as any, 'findUnique', (async () => ({
    id: 50,
    checkInTime: new Date('2026-08-14T05:00:00.000Z'),
    checkOutTime: null,
  })) as any);

  await assert.rejects(
    () => manualCheckIn(10, 21, new Date('2026-08-14T06:00:00.000Z')),
    /already checked in/i
  );
});

test('manualCheckOut records checkout after check-in', async () => {
  mockResolvedMember(true);
  const checkInTime = new Date('2026-08-14T05:00:00.000Z');
  const checkOutTime = new Date('2026-08-14T07:00:00.000Z');
  mockMethod(prisma.attendanceRecord as any, 'findUnique', (async () => ({
    id: 50,
    memberId: 21,
    checkInTime,
    checkOutTime: null,
  })) as any);
  let updateData: any;
  mockMethod(prisma.attendanceRecord as any, 'update', (async (args: any) => {
    updateData = args.data;
    return { id: 50, checkInTime, checkOutTime: args.data.checkOutTime };
  }) as any);

  const result = await manualCheckOut(10, 21, checkOutTime);

  assert.equal(updateData.checkOutTime.toISOString(), checkOutTime.toISOString());
  assert.equal(result.checkOutTime?.toISOString(), checkOutTime.toISOString());
});

test('manualCheckOut rejects checkout before check-in', async () => {
  mockResolvedMember(true);
  mockMethod(prisma.attendanceRecord as any, 'findUnique', (async () => ({
    id: 50,
    memberId: 21,
    checkInTime: new Date('2026-08-14T07:00:00.000Z'),
    checkOutTime: null,
  })) as any);

  await assert.rejects(
    () => manualCheckOut(10, 21, new Date('2026-08-14T06:00:00.000Z')),
    /before check-in/i
  );
});

test('manualCheckOut rejects member not checked in today', async () => {
  mockResolvedMember(true);
  mockMethod(prisma.attendanceRecord as any, 'findUnique', (async () => null) as any);

  await assert.rejects(
    () => manualCheckOut(10, 21, new Date('2026-08-14T06:00:00.000Z')),
    /not checked in/i
  );
});
