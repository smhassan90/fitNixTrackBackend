import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import adminPackageFeatureRoutes from './adminPackageFeatures';
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
    (req as any).platformUser = { id: 5, email: 'platform@test.com', name: 'Platform', role, tokenVersion: 0 };
    next();
  });
  app.use(adminPackageFeatureRoutes);
  return app;
}

afterEach(() => {
  while (restores.length) {
    const fn = restores.pop();
    if (fn) fn();
  }
});

test('create/update/delete package feature', async () => {
  const queryQueue: any[] = [
    [], // create duplicate check
    [{ id: 10, name: 'Gym Access', code: 'GYM_ACCESS', description: null, isActive: true, sortOrder: 1 }],
    [{ id: 10 }], // patch existing
    [], // patch duplicate check
    [{ id: 10, name: 'Gym Access Updated', code: 'GYM_ACCESS', description: null, isActive: true, sortOrder: 1 }],
    [{ id: 10, name: 'Gym Access Updated' }], // delete existing
    [{ count: BigInt(0) }], // delete in-use check
  ];
  mockMethod(prisma as any, '$queryRaw', (async () => queryQueue.shift() ?? []) as any);
  mockMethod(prisma as any, '$executeRaw', (async () => 1) as any);
  mockMethod(prisma.platformAuditLog as any, 'create', (async () => ({ id: 1 })) as any);

  const app = appWithRole('SUPER_ADMIN');
  const createRes = await request(app).post('/admin/packages/features').send({ name: 'Gym Access', code: 'GYM_ACCESS' });
  assert.equal(createRes.status, 201);
  const patchRes = await request(app).patch('/admin/packages/features/10').send({ name: 'Gym Access Updated' });
  assert.equal(patchRes.status, 200);
  const deleteRes = await request(app).delete('/admin/packages/features/10');
  assert.equal(deleteRes.status, 200);
});

test('rbac + duplicate validation', async () => {
  mockMethod(prisma as any, '$queryRaw', (async () => [{ id: 1 }]) as any);
  const app = appWithRole('SUPER_ADMIN');
  const duplicate = await request(app).post('/admin/packages/features').send({ name: 'Gym Access' });
  assert.equal(duplicate.status, 400);

  const supportApp = appWithRole('PLATFORM_SUPPORT');
  const forbidden = await request(supportApp).post('/admin/packages/features').send({ name: 'X' });
  assert.equal(forbidden.status, 403);
});
