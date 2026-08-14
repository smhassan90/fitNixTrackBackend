import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import expenseRoutes from './expenses';
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
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({ timezone: 'Asia/Karachi' })) as any);
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
  app.use('/api/expenses', expenseRoutes);
  return app;
}

test('GET /api/expenses/categories is forbidden without gym.expenses.read', async () => {
  setupGymAuth('GYM_STAFF', []);
  const res = await request(buildApp())
    .get('/api/expenses/categories')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`);
  assert.equal(res.status, 403);
});

test('GET /api/expenses/categories succeeds with gym.expenses.read', async () => {
  setupGymAuth('GYM_STAFF', ['gym.expenses.read']);
  mockMethod(prisma.expenseCategory as any, 'count', (async () => 1) as any);
  mockMethod(prisma.expenseCategory as any, 'findMany', (async () => [
    {
      id: 1,
      gymId: 10,
      name: 'Rent',
      kind: 'FIXED',
      isRecurring: true,
      defaultAmount: 25000,
      isActive: true,
      sortOrder: 10,
      deletedAt: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    },
  ]) as any);

  const res = await request(buildApp())
    .get('/api/expenses/categories')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.categories[0].name, 'Rent');
});

test('POST /api/expenses is forbidden with read-only expense permission', async () => {
  setupGymAuth('GYM_STAFF', ['gym.expenses.read']);
  const res = await request(buildApp())
    .post('/api/expenses')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`)
    .send({ categoryId: 1, amount: 50, spentAt: '2026-07-02' });
  assert.equal(res.status, 403);
});

test('DELETE /api/expenses/:id is forbidden without gym.expenses.delete', async () => {
  setupGymAuth('GYM_STAFF', ['gym.expenses.manage']);
  const res = await request(buildApp())
    .delete('/api/expenses/9')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`);
  assert.equal(res.status, 403);
});

test('GYM_ADMIN can create an expense head', async () => {
  setupGymAuth('GYM_ADMIN');
  mockMethod(prisma.expenseCategory as any, 'findFirst', (async () => null) as any);
  mockMethod(prisma.expenseCategory as any, 'aggregate', (async () => ({ _max: { sortOrder: 100 } })) as any);
  mockMethod(prisma.expenseCategory as any, 'create', (async (args: { data: { name: string } }) => ({
    id: 12,
    gymId: 10,
    name: args.data.name,
    kind: 'PETTY',
    isRecurring: false,
    defaultAmount: null,
    isActive: true,
    sortOrder: 110,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  })) as any);

  const res = await request(buildApp())
    .post('/api/expenses/categories')
    .set('Authorization', `Bearer ${gymToken('GYM_ADMIN')}`)
    .send({ name: 'Ice' });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.name, 'Ice');
});
