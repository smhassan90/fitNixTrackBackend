import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import adminBillingPlanRoutes from './adminBillingPlans';
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
    (req as any).platformUser = { id: 1, email: 'admin@test.com', name: 'Admin', role, tokenVersion: 0 };
    next();
  });
  app.use(adminBillingPlanRoutes);
  return app;
}

afterEach(() => {
  while (restores.length) {
    const fn = restores.pop();
    if (fn) fn();
  }
});

const samplePlan = {
  id: 11,
  name: 'Basic',
  code: 'BASIC',
  description: null,
  price: 1000,
  currency: 'PKR',
  billingCycle: 'MONTHLY',
  maxMembers: 100,
  isActive: true,
  sortOrder: 1,
  features: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

test('create/update/delete billing plan', async () => {
  mockMethod(prisma.plan as any, 'findFirst', (async (args: any) => {
    if (args?.where?.code === 'BASIC' && !args?.where?.id) return null;
    if (args?.where?.id === 11) return { id: 11, name: 'Basic+' };
    return null;
  }) as any);
  mockMethod(
    prisma.plan as any,
    'create',
    (async () => ({ ...samplePlan })) as any
  );
  mockMethod(
    prisma.plan as any,
    'update',
    (async (args: any) => {
      if (args?.data?.deletedAt) return { ...samplePlan, isActive: false, deletedAt: new Date() };
      return { ...samplePlan, name: 'Basic+', price: 1200 };
    }) as any
  );
  mockMethod(prisma.gymSubscription as any, 'count', (async () => 0) as any);
  mockMethod(prisma.platformAuditLog as any, 'create', (async () => ({ id: 1 })) as any);

  const app = appWithRole('SUPER_ADMIN');
  const createRes = await request(app).post('/admin/billing/plans').send({
    name: 'Basic',
    code: 'BASIC',
    price: 1000,
    currency: 'PKR',
    billingCycle: 'MONTHLY',
    maxMembers: 100,
  });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.data.monthlyPrice, 1000);
  assert.equal('pricing' in createRes.body.data, false);
  assert.equal(createRes.body.data.maxMembers, 100);

  const patchRes = await request(app).patch('/admin/billing/plans/11').send({ price: 1200, name: 'Basic+' });
  assert.equal(patchRes.status, 200, JSON.stringify(patchRes.body));
  const deleteRes = await request(app).delete('/admin/billing/plans/11');
  assert.equal(deleteRes.status, 200);
});

test('duplicate code validation + in-use protection + support role forbidden', async () => {
  mockMethod(prisma.plan as any, 'findFirst', (async () => ({ id: 55 })) as any);
  const app = appWithRole('SUPER_ADMIN');
  const duplicate = await request(app).post('/admin/billing/plans').send({
    name: 'Basic',
    code: 'BASIC',
    price: 1000,
    currency: 'PKR',
    billingCycle: 'MONTHLY',
  });
  assert.equal(duplicate.status, 400);

  mockMethod(prisma.plan as any, 'findFirst', (async () => ({ id: 11, name: 'In Use Plan' })) as any);
  mockMethod(prisma.gymSubscription as any, 'count', (async () => 2) as any);
  const inUse = await request(app).delete('/admin/billing/plans/11');
  assert.equal(inUse.status, 409);
  assert.equal(inUse.body.error.code, 'PLAN_IN_USE');

  const supportApp = appWithRole('PLATFORM_SUPPORT');
  const forbidden = await request(supportApp).post('/admin/billing/plans').send({
    name: 'Basic',
    code: 'BASIC_2',
    price: 1000,
    currency: 'PKR',
    billingCycle: 'MONTHLY',
  });
  assert.equal(forbidden.status, 403);
});
