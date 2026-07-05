import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import billingRoutes from './billing';
import gymRoutes from './gyms';
import { prisma } from '../../lib/prisma';
import { locationCatalogService } from '../../services/locationCatalogService';

type RestoreFn = () => void;
const restores: RestoreFn[] = [];

function mockMethod<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]) {
  const oldValue = obj[key];
  (obj as T)[key] = value;
  restores.push(() => {
    (obj as T)[key] = oldValue;
  });
}

afterEach(() => {
  while (restores.length > 0) {
    const restore = restores.pop();
    if (restore) restore();
  }
});

function withPlatformUser(role: 'SUPER_ADMIN' | 'PLATFORM_SUPPORT' = 'SUPER_ADMIN') {
  return (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as any).platformUser = {
      id: 999,
      email: 'platform@example.com',
      name: 'Platform Admin',
      role,
      tokenVersion: 0,
    };
    next();
  };
}

test('GET /billing/plans?active=true returns active plan payload', async () => {
  mockMethod(prisma.plan as any, 'findMany', (async () => {
    return [
      {
        id: 1,
        name: 'Starter',
        code: 'STARTER',
        description: 'Best for gyms with up to 100 members',
        price: 2500,
        currency: 'PKR',
        billingCycle: 'MONTHLY',
        maxMembers: 100,
        isActive: true,
        sortOrder: 1,
        features: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      },
    ];
  }) as any);

  const app = express();
  app.use(withPlatformUser());
  app.use('/billing', billingRoutes);

  const res = await request(app).get('/billing/plans?active=true');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].code, 'STARTER');
  assert.equal(res.body.data[0].isActive, true);
  assert.equal(res.body.data[0].maxMembers, 100);
  assert.equal(res.body.data[0].monthlyPrice, 2500);
  assert.equal('pricing' in res.body.data[0], false);
});

test('POST /gyms creates gym with active plan', async () => {
  mockMethod(prisma.plan as any, 'findUnique', (async () => ({
    id: 1,
    name: 'Basic Monthly',
    code: 'BASIC_MONTHLY',
    price: 2500,
    isActive: true,
  })) as any);
  mockMethod(prisma.user as any, 'findUnique', (async () => null) as any);
  mockMethod(prisma.gym as any, 'findUnique', (async () => null) as any);
  mockMethod(prisma.platformAuditLog as any, 'create', (async () => ({ id: 1 })) as any);
  mockMethod(locationCatalogService as any, 'validateActiveGymLocation', (async ({ country, city }: any) => ({
    country,
    city,
  })) as any);

  mockMethod(
    prisma as any,
    '$transaction',
    (async (cb: (tx: any) => Promise<unknown>) => {
      const tx = {
        gym: {
          create: async ({ data }: any) => ({
            id: 101,
            name: data.name,
            slug: data.slug,
            tenantStatus: data.tenantStatus,
          }),
          update: async ({ data }: any) => ({
            id: 101,
            ...data,
          }),
        },
        gymSubscription: {
          create: async ({ data }: any) => ({ id: 202, ...data }),
        },
        user: {
          create: async ({ data }: any) => ({
            id: 303,
            email: data.email,
            name: data.name,
            role: data.role,
            gymId: data.gymId,
            createdAt: new Date(),
          }),
        },
      };
      return cb(tx);
    }) as any
  );

  const app = express();
  app.use(express.json());
  app.use(withPlatformUser('SUPER_ADMIN'));
  app.use('/gyms', gymRoutes);

  const payload = {
    name: 'Gym A',
    slug: 'gym-a',
    address: 'Main road',
    city: 'Karachi',
    country: 'Pakistan',
    ownerAdmin: {
      name: 'Owner',
      email: 'owner@gym-a.com',
      password: 'Password123',
      phone: '+923001234567',
    },
    planId: 1,
    dueDate: '2026-05-01',
    isActive: true,
  };

  const res = await request(app).post('/gyms').send(payload);
  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.gym.id, 101);
  assert.equal(res.body.data.gym.tenantStatus, 'ACTIVE');
});

test('GET /billing/dues serializes BigInt fields', async () => {
  mockMethod(prisma.gymSubscription as any, 'count', (async () => 1) as any);
  mockMethod(prisma.gymSubscription as any, 'findMany', (async () => [
    {
      gymId: 12,
      dueDate: new Date('2026-05-01'),
      status: 'ACTIVE',
      billingCycle: 'ANNUAL',
      gym: { id: 12, name: 'Gym B', slug: 'gym-b', tenantStatus: 'ACTIVE' },
      plan: { id: 2, name: 'Starter', price: 2500, billingCycle: 'MONTHLY', maxMembers: 100 },
    },
  ]) as any);
  mockMethod(prisma as any, '$queryRaw', (async () => [
    {
      gymId: 12,
      amountCollected: 3000,
      lastPaidAt: new Date('2026-04-25'),
      paymentHistoryCount: BigInt(3),
    },
  ]) as any);

  const app = express();
  app.use(withPlatformUser('SUPER_ADMIN'));
  app.use('/billing', billingRoutes);

  const res = await request(app).get('/billing/dues');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.items[0].paymentHistoryCount, '3');
  assert.equal(res.body.data.items[0].amountDue, 24000);
  assert.equal(res.body.data.items[0].billingCycle, 'ANNUAL');
  assert.equal(res.body.data.items[0].maxMembers, 100);
});
