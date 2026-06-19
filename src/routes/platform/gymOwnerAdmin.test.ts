import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import gymOwnerAdminRoutes from './gymOwnerAdmin';
import { prisma } from '../../lib/prisma';

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

test('GET /:id/owner-admin returns null when gym has no admin', async () => {
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({ id: 1 })) as any);
  mockMethod(prisma.user as any, 'findFirst', (async () => null) as any);

  const app = express();
  app.use(withPlatformUser());
  app.use(gymOwnerAdminRoutes);

  const res = await request(app).get('/1/owner-admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.ownerAdmin, null);
});

test('POST /:id/owner-admin creates owner admin with generated password', async () => {
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({ id: 1, name: 'Fit Gym' })) as any);
  mockMethod(prisma.user as any, 'findFirst', (async () => null) as any);
  mockMethod(prisma.user as any, 'create', (async (data: any) => ({
    id: 10,
    name: data.data.name,
    email: data.data.email,
    phone: null,
    role: 'GYM_ADMIN',
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date(),
  })) as any);
  mockMethod(prisma.platformAuditLog as any, 'create', (async () => ({ id: 1 })) as any);

  const app = express();
  app.use(express.json());
  app.use(withPlatformUser());
  app.use(gymOwnerAdminRoutes);

  const res = await request(app).post('/1/owner-admin').send({
    name: 'Gym Owner',
    email: 'owner@example.com',
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.ownerAdmin.email, 'owner@example.com');
  assert.ok(res.body.data.generatedPassword);
});

test('POST /:id/owner-admin rejects when owner admin already exists', async () => {
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({ id: 1, name: 'Fit Gym' })) as any);
  mockMethod(prisma.user as any, 'findFirst', (async () => ({
    id: 10,
    name: 'Existing',
    email: 'owner@example.com',
    phone: null,
    role: 'GYM_ADMIN',
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date(),
  })) as any);

  const app = express();
  app.use(express.json());
  app.use(withPlatformUser());
  app.use(gymOwnerAdminRoutes);

  const res = await request(app).post('/1/owner-admin').send({
    name: 'Another Owner',
    email: 'other@example.com',
  });

  assert.equal(res.status, 409);
});

test('POST /:id/owner-admin/reset-password returns generated password', async () => {
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({ id: 1, name: 'Fit Gym' })) as any);
  mockMethod(prisma.user as any, 'findFirst', (async () => ({
    id: 10,
    name: 'Gym Owner',
    email: 'owner@example.com',
    password: 'old-hash',
    role: 'GYM_ADMIN',
    isActive: true,
  })) as any);
  mockMethod(prisma.user as any, 'update', (async () => ({
    id: 10,
    name: 'Gym Owner',
    email: 'owner@example.com',
    phone: null,
    role: 'GYM_ADMIN',
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date(),
  })) as any);
  mockMethod(prisma.platformAuditLog as any, 'create', (async () => ({ id: 1 })) as any);

  const app = express();
  app.use(express.json());
  app.use(withPlatformUser());
  app.use(gymOwnerAdminRoutes);

  const res = await request(app).post('/1/owner-admin/reset-password').send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.data.generatedPassword);
});
