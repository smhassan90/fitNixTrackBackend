import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import gymRoutes from './gyms';
import { prisma } from '../../lib/prisma';

type Restore = () => void;
const restores: Restore[] = [];

function mockMethod<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]) {
  const prev = obj[key];
  (obj as T)[key] = value;
  restores.push(() => {
    (obj as T)[key] = prev;
  });
}

function appWithRole(role: 'SUPER_ADMIN' | 'PLATFORM_SUPPORT' = 'SUPER_ADMIN') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).platformUser = {
      id: 7,
      email: 'platform@test.com',
      name: 'Platform',
      role,
      tokenVersion: 0,
    };
    next();
  });
  app.use('/gyms', gymRoutes);
  return app;
}

afterEach(() => {
  while (restores.length) {
    const fn = restores.pop();
    if (fn) fn();
  }
});

test('records billing payment successfully', async () => {
  const queryQueue: any[] = [
    [], // generateUniqueReceiptNo uniqueness check
    [], // dedupe check
    [
      {
        id: BigInt(88),
        gymId: 10,
        amountPaid: 2500,
        currency: 'PKR',
        paidAt: new Date('2026-04-25'),
        method: 'CASH',
        notes: null,
        status: 'PAID',
        receiptNo: 'RCP-20260425-ABC123',
        createdAt: new Date(),
        createdBy: BigInt(7),
      },
    ], // fetch inserted row
  ];
  mockMethod(prisma as any, '$queryRaw', (async () => queryQueue.shift() ?? []) as any);
  mockMethod(prisma as any, '$executeRaw', (async () => 1) as any);
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({
    id: 10,
    name: 'Gym A',
    gymSubscription: {
      gymId: 10,
      plan: { billingCycle: 'MONTHLY' },
    },
  })) as any);
  mockMethod(prisma.gymSubscription as any, 'update', (async () => ({ id: 1 })) as any);
  mockMethod(prisma.platformAuditLog as any, 'create', (async () => ({ id: 1 })) as any);

  const app = appWithRole('SUPER_ADMIN');
  const res = await request(app).post('/gyms/10/billing/payments').send({
    amountPaid: 2500,
    currency: 'PKR',
    paidAt: '2026-04-25',
    method: 'CASH',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.gymId, 10);
  assert.equal(res.body.data.id, '88');
  assert.equal(res.body.data.createdBy, '7');
  assert.equal(res.body.data.status, 'PAID');
});

test('rejects invalid amount/date/method', async () => {
  const app = appWithRole('SUPER_ADMIN');
  const res = await request(app).post('/gyms/10/billing/payments').send({
    amountPaid: 0,
    currency: '',
    paidAt: '04-25-2026',
    method: 'INVALID',
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.success, false);
});

test('rejects non-super-admin role', async () => {
  const app = appWithRole('PLATFORM_SUPPORT');
  const res = await request(app).post('/gyms/10/billing/payments').send({
    amountPaid: 2500,
    currency: 'PKR',
    paidAt: '2026-04-25',
    method: 'CASH',
  });
  assert.equal(res.status, 403);
});

test('returns not found when gym does not exist', async () => {
  mockMethod(prisma.gym as any, 'findUnique', (async () => null) as any);
  const app = appWithRole('SUPER_ADMIN');
  const res = await request(app).post('/gyms/999/billing/payments').send({
    amountPaid: 2500,
    currency: 'PKR',
    paidAt: '2026-04-25',
    method: 'CASH',
  });
  assert.equal(res.status, 404);
});

test('avoids duplicate rapid-click insert by returning existing record', async () => {
  const dedupeRecord = {
    id: 99,
    gymId: 10,
    amountPaid: 2500,
    currency: 'PKR',
    paidAt: new Date('2026-04-25'),
    method: 'CASH',
    notes: null,
    status: 'PAID',
    receiptNo: 'RCP-20260425-DUP001',
    createdAt: new Date(),
    createdBy: 7,
  };
  mockMethod(prisma as any, '$queryRaw', (async () => [dedupeRecord]) as any);
  mockMethod(prisma as any, '$executeRaw', (async () => {
    throw new Error('should not insert for duplicate');
  }) as any);
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({
    id: 10,
    name: 'Gym A',
    gymSubscription: { gymId: 10, plan: { billingCycle: 'MONTHLY' } },
  })) as any);

  const app = appWithRole('SUPER_ADMIN');
  const res = await request(app).post('/gyms/10/billing/payments').send({
    amountPaid: 2500,
    currency: 'PKR',
    paidAt: '2026-04-25',
    method: 'CASH',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.receiptNo, 'RCP-20260425-DUP001');
});

test('gym details include billingHistory', async () => {
  const app = appWithRole('SUPER_ADMIN');
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({
    id: 10,
    name: 'Gym A',
    slug: 'gym-a',
    logoUrl: null,
    address: null,
    city: 'Karachi',
    country: 'Pakistan',
    phone: null,
    email: null,
    tenantStatus: 'ACTIVE',
    createdAt: new Date(),
    gymSubscription: { gymId: 10, planId: 1, status: 'ACTIVE', dueDate: new Date(), plan: { id: 1 } },
    _count: { members: 0, trainers: 0 },
  })) as any);
  mockMethod(prisma.payment as any, 'aggregate', (async () => ({ _sum: { amount: 0 } })) as any);
  mockMethod(prisma as any, '$queryRaw', (async () => [
    {
      id: BigInt(4),
      paidAt: new Date('2026-04-20'),
      amountPaid: 2500,
      status: 'PAID',
      notes: 'ok',
      receiptNo: 'RCP-20260420-AAAAAA',
      method: 'CASH',
      currency: 'PKR',
      createdAt: new Date(),
      createdBy: BigInt(7),
    },
  ]) as any);

  const res = await request(app).get('/gyms/10');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.billingHistory.length, 1);
  assert.equal(res.body.data.billingHistory[0].id, '4');
  assert.equal(res.body.data.billingHistory[0].createdBy, '7');
  assert.equal(res.body.data.billingHistory[0].amountPaid, 2500);
});
