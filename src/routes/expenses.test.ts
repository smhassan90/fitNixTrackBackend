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

function expenseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    gymId: 10,
    categoryId: 1,
    amount: 25000,
    spentAt: new Date('2026-07-02T00:00:00.000Z'),
    paymentMethod: 'CASH',
    notes: 'July rent',
    createdById: 1,
    updatedById: null,
    createdAt: new Date('2026-07-02T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
    category: { id: 1, name: 'Rent', kind: 'FIXED', isActive: true },
    createdBy: { id: 1, name: 'Gym Admin' },
    updatedBy: null,
    ...overrides,
  };
}

test('POST /api/expenses creates a dated expense against an active head', async () => {
  setupGymAuth('GYM_STAFF', ['gym.expenses.manage']);
  mockMethod(prisma.expenseCategory as any, 'findFirst', (async () => ({
    id: 1,
    gymId: 10,
    name: 'Rent',
    kind: 'FIXED',
    isActive: true,
    deletedAt: null,
  })) as any);
  let createData: any;
  mockMethod(prisma.expenseEntry as any, 'create', (async (args: any) => {
    createData = args.data;
    return expenseRow({
      amount: args.data.amount,
      spentAt: args.data.spentAt,
      paymentMethod: args.data.paymentMethod,
      notes: args.data.notes,
    });
  }) as any);

  const res = await request(buildApp())
    .post('/api/expenses')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`)
    .send({
      categoryId: 1,
      amount: 25000,
      spentAt: '2026-07-02',
      paymentMethod: 'CASH',
      notes: ' July rent ',
    });

  assert.equal(res.status, 200);
  assert.equal(createData.gymId, 10);
  assert.equal(createData.createdById, 1);
  assert.equal(createData.spentAt.toISOString(), '2026-07-01T19:00:00.000Z');
  assert.equal(createData.notes, 'July rent');
  assert.equal(res.body.data.spentAt, '2026-07-02');
});

test('POST /api/expenses rejects inactive expense head', async () => {
  setupGymAuth('GYM_STAFF', ['gym.expenses.manage']);
  mockMethod(prisma.expenseCategory as any, 'findFirst', (async () => ({
    id: 1,
    gymId: 10,
    name: 'Old Head',
    kind: 'PETTY',
    isActive: false,
    deletedAt: new Date(),
  })) as any);

  const res = await request(buildApp())
    .post('/api/expenses')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`)
    .send({ categoryId: 1, amount: 100, spentAt: '2026-07-02' });

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /inactive head/i);
});

test('PATCH /api/expenses/:id updates amount and audit user', async () => {
  setupGymAuth('GYM_STAFF', ['gym.expenses.manage']);
  mockMethod(prisma.expenseEntry as any, 'findFirst', (async () => expenseRow()) as any);
  let updateData: any;
  mockMethod(prisma.expenseEntry as any, 'update', (async (args: any) => {
    updateData = args.data;
    return expenseRow({
      amount: args.data.amount,
      updatedById: args.data.updatedById,
      updatedBy: { id: 1, name: 'Gym Admin' },
    });
  }) as any);

  const res = await request(buildApp())
    .patch('/api/expenses/9')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`)
    .send({ amount: 26000 });

  assert.equal(res.status, 200);
  assert.equal(updateData.amount, 26000);
  assert.equal(updateData.updatedById, 1);
  assert.equal(res.body.data.amount, 26000);
});

test('DELETE /api/expenses/:id removes entry with delete permission', async () => {
  setupGymAuth('GYM_STAFF', ['gym.expenses.delete']);
  mockMethod(prisma.expenseEntry as any, 'findFirst', (async () => expenseRow()) as any);
  let deletedId: number | undefined;
  mockMethod(prisma.expenseEntry as any, 'delete', (async (args: any) => {
    deletedId = args.where.id;
    return { id: deletedId };
  }) as any);

  const res = await request(buildApp())
    .delete('/api/expenses/9')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`);

  assert.equal(res.status, 200);
  assert.equal(deletedId, 9);
});

test('DELETE /api/expenses/categories/:id soft-deactivates head', async () => {
  setupGymAuth('GYM_STAFF', ['gym.expenses.delete']);
  mockMethod(prisma.expenseCategory as any, 'findFirst', (async () => ({
    id: 1,
    gymId: 10,
    name: 'Rent',
    isActive: true,
    deletedAt: null,
  })) as any);
  let updateData: any;
  mockMethod(prisma.expenseCategory as any, 'update', (async (args: any) => {
    updateData = args.data;
    return {
      id: 1,
      gymId: 10,
      name: 'Rent',
      kind: 'FIXED',
      isRecurring: true,
      defaultAmount: 25000,
      isActive: false,
      sortOrder: 10,
      deletedAt: args.data.deletedAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }) as any);

  const res = await request(buildApp())
    .delete('/api/expenses/categories/1')
    .set('Authorization', `Bearer ${gymToken('GYM_STAFF')}`);

  assert.equal(res.status, 200);
  assert.equal(updateData.isActive, false);
  assert.ok(updateData.deletedAt instanceof Date);
  assert.equal(res.body.data.isActive, false);
});
