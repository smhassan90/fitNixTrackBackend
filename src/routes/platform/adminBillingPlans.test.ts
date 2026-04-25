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

test('create/update/delete billing plan', async () => {
  const queryQueue: any[] = [
    [], // create dup check
    [{ id: 11, name: 'Basic', code: 'BASIC', description: null, price: 1000, currency: 'PKR', billingCycle: 'MONTHLY', isActive: true, sortOrder: 1, createdAt: new Date(), updatedAt: new Date(), deletedAt: null }],
    [{ id: 11 }], // patch exists
    [{ id: 11, name: 'Basic+', code: 'BASIC', description: null, price: 1200, currency: 'PKR', billingCycle: 'MONTHLY', isActive: true, sortOrder: 1, createdAt: new Date(), updatedAt: new Date(), deletedAt: null }],
    [{ id: 11, name: 'Basic+' }], // delete exists
    [{ count: BigInt(0) }], // delete in-use
  ];
  mockMethod(prisma as any, '$queryRaw', (async () => queryQueue.shift() ?? []) as any);
  mockMethod(prisma as any, '$executeRaw', (async () => 1) as any);
  mockMethod(prisma.platformAuditLog as any, 'create', (async () => ({ id: 1 })) as any);

  const app = appWithRole('SUPER_ADMIN');
  const createRes = await request(app).post('/admin/billing/plans').send({
    name: 'Basic',
    code: 'BASIC',
    price: 1000,
    currency: 'PKR',
    billingCycle: 'MONTHLY',
  });
  assert.equal(createRes.status, 201);
  const patchRes = await request(app).patch('/admin/billing/plans/11').send({ price: 1200, name: 'Basic+' });
  assert.equal(patchRes.status, 200, JSON.stringify(patchRes.body));
  const deleteRes = await request(app).delete('/admin/billing/plans/11');
  assert.equal(deleteRes.status, 200);
});

test('duplicate code validation + in-use protection + support role forbidden', async () => {
  mockMethod(prisma as any, '$queryRaw', (async () => [{ id: 55 }]) as any);
  const app = appWithRole('SUPER_ADMIN');
  const duplicate = await request(app).post('/admin/billing/plans').send({
    name: 'Basic',
    code: 'BASIC',
    price: 1000,
    currency: 'PKR',
    billingCycle: 'MONTHLY',
  });
  assert.equal(duplicate.status, 400);

  const queryQueue: any[] = [
    [{ id: 11, name: 'In Use Plan' }],
    [{ count: BigInt(2) }],
  ];
  mockMethod(prisma as any, '$queryRaw', (async () => queryQueue.shift() ?? []) as any);
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
