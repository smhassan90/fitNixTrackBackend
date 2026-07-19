import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import gymUsersRoutes from './gymUsers';
import { prisma } from '../lib/prisma';

type Restore = () => void;
const restores: Restore[] = [];

function mockMethod<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]) {
  const prev = obj[key];
  (obj as T)[key] = value;
  restores.push(() => {
    (obj as T)[key] = prev;
  });
}

afterEach(() => {
  while (restores.length) {
    const fn = restores.pop();
    if (fn) fn();
  }
});

function setupGymAuth(role: string, permissionKeys: string[] | null = null) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  restores.push(() => {
    process.env.JWT_SECRET = previousSecret;
  });
  mockMethod(prisma.user as any, 'findUnique', (async () => ({
    id: 1,
    email: 'gym@test.com',
    name: 'Gym Admin',
    role,
    permissionKeys,
    gymId: 10,
    isActive: true,
    tokenVersion: 0,
    gym: { name: 'Gym', tenantStatus: 'ACTIVE' },
  })) as any);
}

function gymToken(role: string) {
  return jwt.sign(
    { id: 1, gymId: 10, email: 'gym@test.com', role, principal: 'gym', tokenVersion: 0 },
    process.env.JWT_SECRET || 'test-secret'
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/gym', gymUsersRoutes);
  return app;
}

test('GET /api/gym/users returns list for GYM_ADMIN', async () => {
  setupGymAuth('GYM_ADMIN');
  mockMethod(prisma.user as any, 'findMany', (async () => [
    {
      id: 1,
      name: 'A',
      email: 'a@gym.com',
      phone: null,
      role: 'GYM_ADMIN',
      permissionKeys: null,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastLoginAt: null,
    },
  ]) as any);

  const res = await request(buildApp())
    .get('/api/gym/users')
    .set('Authorization', `Bearer ${gymToken('GYM_ADMIN')}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.users.length, 1);
  assert.equal(res.body.data.users[0].email, 'a@gym.com');
});

test('POST /api/gym/users forbidden for GYM_STAFF', async () => {
  setupGymAuth('GYM_STAFF');
  const res = await request(buildApp())
    .post('/api/gym/users')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`)
    .send({
      name: 'X',
      email: 'x@test.com',
      role: 'GYM_STAFF',
    });
  assert.equal(res.status, 403);
});

test('GET /api/gym/users allows staff with explicit manage-team permission', async () => {
  setupGymAuth('GYM_STAFF', ['gym.team.manage']);
  mockMethod(prisma.user as any, 'findMany', (async () => []) as any);

  const res = await request(buildApp())
    .get('/api/gym/users')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
});

test('GET /api/gym/permissions is available to every authenticated team member', async () => {
  setupGymAuth('GYM_STAFF', []);

  const res = await request(buildApp())
    .get('/api/gym/permissions')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(
    res.body.data.permissions.some((permission: { key: string }) =>
      permission.key.includes('import')
    ),
    false
  );
  assert.equal(res.body.data.alwaysAvailable[0].key, 'gym.attendance.read');
});

test('POST /api/gym/users returns temporaryPassword when password omitted', async () => {
  setupGymAuth('GYM_ADMIN');
  let created: unknown;
  mockMethod(prisma.user as any, 'findUnique', (async (args: { where?: { gymId_email?: unknown } }) => {
    if (args?.where && 'gymId_email' in (args.where as object)) {
      return null;
    }
    return {
      id: 1,
      email: 'gym@test.com',
      name: 'Gym Admin',
      role: 'GYM_ADMIN',
      permissionKeys: null,
      gymId: 10,
      isActive: true,
      tokenVersion: 0,
      gym: { name: 'Gym', tenantStatus: 'ACTIVE' },
    };
  }) as any);
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({ name: 'Gym' })) as any);
  mockMethod(prisma.user as any, 'create', (async (args: { data: unknown; select: unknown }) => {
    created = args.data;
    return {
      id: 2,
      name: 'New',
      email: 'new@test.com',
      phone: null,
      role: 'GYM_STAFF',
      permissionKeys: [],
      isActive: true,
      createdAt: new Date(),
      lastLoginAt: null,
    };
  }) as any);

  const res = await request(buildApp())
    .post('/api/gym/users')
    .set('Authorization', `Bearer ${gymToken('GYM_ADMIN')}`)
    .send({ name: 'New', email: 'new@test.com', role: 'GYM_STAFF' });

  assert.equal(res.status, 201);
  assert.ok((created as { password: string }).password);
  assert.ok(res.body.data.temporaryPassword);
  assert.equal(res.body.data.user.email, 'new@test.com');
});
