import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import membersRoutes from './members';
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

function setupAuth(role = 'GYM_ADMIN', permissionKeys: string[] | null = null) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  restores.push(() => {
    process.env.JWT_SECRET = previousSecret;
  });
  mockMethod(prisma.user as any, 'findUnique', (async () => ({
    id: 1,
    email: 'admin@gym.test',
    name: 'Admin',
    role,
    permissionKeys,
    gymId: 10,
    isActive: true,
    tokenVersion: 0,
    gym: { name: 'Gym', tenantStatus: 'ACTIVE' },
  })) as any);
  mockMethod(prisma.gym as any, 'findUnique', (async (args: any) => {
    if (args.select?.timezone) return { timezone: 'Asia/Karachi' };
    return { admissionFee: 1000, maxMemberDiscount: 500 };
  }) as any);
}

function token(role = 'GYM_ADMIN') {
  return jwt.sign(
    { id: 1, gymId: 10, email: 'admin@gym.test', role, principal: 'gym', tokenVersion: 0 },
    process.env.JWT_SECRET || 'test-secret'
  );
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/members', membersRoutes);
  return instance;
}

function memberResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 21,
    gymId: 10,
    legacyMemberId: 'M-21',
    name: 'Ali',
    phone: null,
    email: null,
    gender: 'Male',
    dateOfBirth: null,
    packageId: null,
    discount: null,
    membershipStart: new Date('2026-08-14T00:00:00.000Z'),
    membershipEnd: null,
    isActive: true,
    inactiveFrom: null,
    billingResumeFrom: null,
    admissionFeeWaived: false,
    admissionFeePaid: 1000,
    oneTimePaymentAmount: 1000,
    oneTimePaymentPaid: false,
    monthlyPaymentAmount: 0,
    package: null,
    trainers: [],
    ...overrides,
  };
}

test('POST /api/members creates a basic member and pending admission payment', async () => {
  setupAuth();
  mockMethod(prisma.gymSubscription as any, 'findUnique', (async () => null) as any);
  mockMethod(prisma.member as any, 'findFirst', (async () => null) as any);
  let createData: any;
  mockMethod(prisma.member as any, 'create', (async (args: any) => {
    createData = args.data;
    return memberResponse({
      name: args.data.name,
      legacyMemberId: args.data.legacyMemberId,
      membershipStart: args.data.membershipStart,
      trainers: [],
    });
  }) as any);
  let oneTimeData: any;
  mockMethod(prisma.oneTimePayment as any, 'create', (async (args: any) => {
    oneTimeData = args.data;
    return { id: 3, ...args.data };
  }) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => ({
    id: 3,
    memberId: 21,
    gymId: 10,
    admissionFee: 1000,
    packageFee: 0,
    trainerFee: 0,
    totalAmount: 1000,
    status: 'PENDING',
  })) as any);

  const res = await request(app())
    .post('/api/members')
    .set('Authorization', `Bearer ${token()}`)
    .send({ legacyMemberId: 'M-21', name: 'Ali', gender: 'Male' });

  assert.equal(res.status, 201);
  assert.equal(createData.gymId, 10);
  assert.equal(createData.legacyMemberId, 'M-21');
  assert.equal(createData.packageId, null);
  assert.deepEqual(createData.trainers.create, []);
  assert.equal(oneTimeData.status, 'PENDING');
  assert.equal(oneTimeData.totalAmount, 1000);
  assert.equal(res.body.data.oneTimePayment.status, 'PENDING');
});

test('POST /api/members assigns package and active trainers', async () => {
  setupAuth();
  mockMethod(prisma.gymSubscription as any, 'findUnique', (async () => null) as any);
  const packageData = { id: 4, gymId: 10, name: 'Gold', price: 6000, discount: 0, duration: '1 month' };
  const trainers = [
    { id: 2, gymId: 10, name: 'Wasim', charges: 1000, isActive: true },
    { id: 3, gymId: 10, name: 'Sara', charges: 500, isActive: true },
  ];
  mockMethod(prisma.package as any, 'findFirst', (async () => packageData) as any);
  mockMethod(prisma.trainer as any, 'findMany', (async () => trainers) as any);
  mockMethod(prisma.member as any, 'findFirst', (async (args: any) => {
    if (args.where?.legacyMemberId) return null;
    return {
      ...memberResponse({ packageId: 4, package: packageData, discount: 100 }),
      trainers: trainers.map((trainer) => ({ trainer })),
    };
  }) as any);
  let createData: any;
  mockMethod(prisma.member as any, 'create', (async (args: any) => {
    createData = args.data;
    return memberResponse({
      name: args.data.name,
      packageId: 4,
      package: packageData,
      discount: 100,
      membershipStart: args.data.membershipStart,
      oneTimePaymentAmount: 7400,
      monthlyPaymentAmount: 7400,
      trainers: trainers.map((trainer) => ({ trainer })),
    });
  }) as any);
  mockMethod(prisma.oneTimePayment as any, 'create', (async (args: any) => ({ id: 9, ...args.data })) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => ({
    id: 9,
    admissionFee: 1000,
    packageFee: 5900,
    trainerFee: 1500,
    totalAmount: 8400,
    status: 'PENDING',
  })) as any);
  mockMethod(prisma.payment as any, 'deleteMany', (async () => ({ count: 0 })) as any);
  mockMethod(prisma.payment as any, 'updateMany', (async () => ({ count: 0 })) as any);
  mockMethod(prisma.member as any, 'update', (async () => memberResponse()) as any);

  const res = await request(app())
    .post('/api/members')
    .set('Authorization', `Bearer ${token()}`)
    .send({
      legacyMemberId: 'M-22',
      name: 'Assigned Member',
      packageId: 4,
      trainerIds: [2, 3],
      discount: 100,
    });

  assert.equal(res.status, 201);
  assert.equal(createData.packageId, 4);
  assert.deepEqual(createData.trainers.create, [{ trainerId: 2 }, { trainerId: 3 }]);
  assert.deepEqual(res.body.data.trainers.map((t: any) => t.id), [2, 3]);
});

test('POST /api/members refuses inactive trainer assignment', async () => {
  setupAuth();
  mockMethod(prisma.gymSubscription as any, 'findUnique', (async () => null) as any);
  mockMethod(prisma.member as any, 'findFirst', (async () => null) as any);
  mockMethod(prisma.trainer as any, 'findMany', (async () => [
    { id: 2, gymId: 10, name: 'Inactive Coach', charges: 1000, isActive: false },
  ]) as any);

  const res = await request(app())
    .post('/api/members')
    .set('Authorization', `Bearer ${token()}`)
    .send({ legacyMemberId: 'M-23', name: 'Ali', trainerIds: [2] });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /inactive trainer/i);
});

test('PATCH /api/members/:id updates member fields', async () => {
  setupAuth();
  mockMethod(prisma.member as any, 'findFirst', (async () => memberResponse()) as any);
  let updateData: any;
  mockMethod(prisma.member as any, 'update', (async (args: any) => {
    updateData = args.data;
    return memberResponse({ name: args.data.name, phone: args.data.phone });
  }) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => null) as any);

  const res = await request(app())
    .patch('/api/members/21')
    .set('Authorization', `Bearer ${token()}`)
    .send({ name: 'Ali Updated', phone: '03000000000' });

  assert.equal(res.status, 200);
  assert.equal(updateData.name, 'Ali Updated');
  assert.equal(updateData.phone, '03000000000');
  assert.equal(res.body.data.name, 'Ali Updated');
});

test('DELETE /api/members/:id deletes a gym-scoped member', async () => {
  setupAuth();
  mockMethod(prisma as any, '$queryRawUnsafe', (async () => []) as any);
  mockMethod(prisma.member as any, 'findFirst', (async () => ({ id: 21, photoUrl: null })) as any);
  let deletedId: number | undefined;
  mockMethod(prisma.member as any, 'delete', (async (args: any) => {
    deletedId = args.where.id;
    return { id: deletedId };
  }) as any);

  const res = await request(app())
    .delete('/api/members/21')
    .set('Authorization', `Bearer ${token()}`);

  assert.equal(res.status, 200);
  assert.equal(deletedId, 21);
});

test('deactivating member marks inactive and deletes future unpaid installments', async () => {
  setupAuth();
  mockMethod(prisma as any, '$queryRawUnsafe', (async () => []) as any);
  const active = memberResponse();
  const inactive = memberResponse({
    isActive: false,
    inactiveFrom: new Date('2026-08-15T00:00:00.000Z'),
  });
  let findCount = 0;
  mockMethod(prisma.member as any, 'findFirst', (async () => (++findCount === 1 ? active : inactive)) as any);
  let deletedWhere: any;
  const tx = {
    member: { update: async () => inactive },
    payment: {
      deleteMany: async (args: any) => {
        deletedWhere = args.where;
        return { count: 2 };
      },
    },
  };
  mockMethod(prisma as any, '$transaction', (async (callback: any) => callback(tx)) as any);

  const res = await request(app())
    .patch('/api/members/21/deactivate')
    .set('Authorization', `Bearer ${token()}`)
    .send({ effectiveDate: '2026-08-15' });

  assert.equal(res.status, 200);
  assert.equal(res.body.data.isActive, false);
  assert.deepEqual(deletedWhere.status.in, ['PENDING', 'OVERDUE']);
  assert.equal(deletedWhere.memberId, 21);
  assert.equal(deletedWhere.dueDate.gte.toISOString(), '2026-08-15T00:00:00.000Z');
});

test('staff without gym.members.manage cannot create a member', async () => {
  setupAuth('GYM_STAFF', ['gym.members.read']);
  const res = await request(app())
    .post('/api/members')
    .set('Authorization', `Bearer ${token('GYM_STAFF')}`)
    .send({ name: 'Blocked' });

  assert.equal(res.status, 403);
});

test('staff with manage but not delete cannot delete a member', async () => {
  setupAuth('GYM_STAFF', ['gym.members.manage']);
  const res = await request(app())
    .delete('/api/members/21')
    .set('Authorization', `Bearer ${token('GYM_STAFF')}`);

  assert.equal(res.status, 403);
});

test('create member fails when plan active-member limit is reached', async () => {
  setupAuth();
  mockMethod(prisma.member as any, 'findFirst', (async () => null) as any);
  mockMethod(prisma.gymSubscription as any, 'findUnique', (async () => ({
    gymId: 10,
    plan: { id: 2, code: 'STARTER', name: 'Starter', maxMembers: 1, isActive: true },
  })) as any);
  mockMethod(prisma.member as any, 'count', (async () => 1) as any);

  const res = await request(app())
    .post('/api/members')
    .set('Authorization', `Bearer ${token()}`)
    .send({ legacyMemberId: 'M-99', name: 'Over Limit' });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /Active member limit/i);
});

test('create member rejects discount above gym cap', async () => {
  setupAuth();
  mockMethod(prisma.gymSubscription as any, 'findUnique', (async () => null) as any);
  mockMethod(prisma.member as any, 'findFirst', (async () => null) as any);

  const res = await request(app())
    .post('/api/members')
    .set('Authorization', `Bearer ${token()}`)
    .send({ legacyMemberId: 'M-24', name: 'Ali', discount: 900 });

  assert.equal(res.status, 400);
  const paths = (res.body.error?.details || []).map((d: any) => d.path);
  assert.ok(paths.includes('body.discount'));
});

test('create member rejects a package from another gym', async () => {
  setupAuth();
  mockMethod(prisma.gymSubscription as any, 'findUnique', (async () => null) as any);
  mockMethod(prisma.member as any, 'findFirst', (async () => null) as any);
  mockMethod(prisma.package as any, 'findFirst', (async () => null) as any);

  const res = await request(app())
    .post('/api/members')
    .set('Authorization', `Bearer ${token()}`)
    .send({ legacyMemberId: 'M-25', name: 'Ali', packageId: 99 });

  assert.equal(res.status, 404);
  assert.match(res.body.error.message, /Package/i);
});

test('PATCH /api/members/:id replaces trainers and refreshes open installment amounts', async () => {
  setupAuth();
  mockMethod(prisma.member as any, 'findFirst', (async (args: any) => {
    if (args.include?.package || args.include?.trainers) {
      return {
        id: 21,
        gymId: 10,
        discount: 0,
        package: { id: 4, price: 3000, discount: 0, duration: '1 month' },
        trainers: [{ trainer: { charges: 500 } }],
      };
    }
    return memberResponse({ packageId: 4 });
  }) as any);
  mockMethod(prisma.trainer as any, 'findMany', (async () => [
    { id: 8, gymId: 10, name: 'New Coach', charges: 500, isActive: true },
  ]) as any);
  let updateData: any;
  mockMethod(prisma.member as any, 'update', (async (args: any) => {
    if (args.data.trainers) updateData = args.data;
    return memberResponse({
      trainers: [{ trainer: { id: 8, name: 'New Coach', charges: 500 } }],
    });
  }) as any);
  let refreshedOpen: any;
  mockMethod(prisma.payment as any, 'updateMany', (async (args: any) => {
    refreshedOpen = args;
    return { count: 1 };
  }) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => null) as any);

  const res = await request(app())
    .patch('/api/members/21')
    .set('Authorization', `Bearer ${token()}`)
    .send({ trainerIds: [8] });

  assert.equal(res.status, 200);
  assert.deepEqual(updateData.trainers, {
    deleteMany: {},
    create: [{ trainerId: 8 }],
  });
  assert.deepEqual(refreshedOpen.where.status.in, ['PENDING', 'OVERDUE']);
});

test('PATCH /api/members/:id regenerates unpaid installments when package changes', async () => {
  setupAuth();
  mockMethod(prisma.member as any, 'findFirst', (async (args: any) => {
    if (args.include?.trainers) {
      return {
        id: 21,
        gymId: 10,
        discount: 0,
        package: { id: 5, price: 9000, discount: 0, duration: '3 months' },
        trainers: [],
        membershipStart: new Date('2026-08-14T00:00:00.000Z'),
        membershipEnd: null,
        billingResumeFrom: null,
        isActive: true,
      };
    }
    return memberResponse({ packageId: 4 });
  }) as any);
  mockMethod(prisma.package as any, 'findFirst', (async () => ({
    id: 5,
    gymId: 10,
    price: 9000,
    discount: 0,
    duration: '3 months',
  })) as any);
  mockMethod(prisma.member as any, 'update', (async (args: any) =>
    memberResponse({ packageId: args.data.packageId, package: { id: 5, name: 'Platinum' } })
  ) as any);
  let deletedUnpaid: any;
  mockMethod(prisma.payment as any, 'deleteMany', (async (args: any) => {
    deletedUnpaid = args.where;
    return { count: 2 };
  }) as any);
  mockMethod(prisma.payment as any, 'findFirst', (async () => null) as any);
  mockMethod(prisma.payment as any, 'create', (async (args: any) => ({ id: 11, ...args.data })) as any);
  mockMethod(prisma.payment as any, 'updateMany', (async () => ({ count: 0 })) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => null) as any);

  const res = await request(app())
    .patch('/api/members/21')
    .set('Authorization', `Bearer ${token()}`)
    .send({ packageId: 5 });

  assert.equal(res.status, 200);
  assert.deepEqual(deletedUnpaid.status.in, ['PENDING', 'OVERDUE']);
  assert.equal(deletedUnpaid.memberId, 21);
});
