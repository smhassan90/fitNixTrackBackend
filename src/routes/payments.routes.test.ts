import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import paymentsRoutes from './payments';
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

function setupAuth() {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  restores.push(() => {
    process.env.JWT_SECRET = previousSecret;
  });
  mockMethod(prisma.user as any, 'findUnique', (async () => ({
    id: 1,
    email: 'admin@gym.test',
    name: 'Admin',
    role: 'GYM_ADMIN',
    permissionKeys: null,
    gymId: 10,
    isActive: true,
    tokenVersion: 0,
    gym: { name: 'Fit Gym', tenantStatus: 'ACTIVE' },
  })) as any);
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({ timezone: 'Asia/Karachi' })) as any);
}

function token() {
  return jwt.sign(
    { id: 1, gymId: 10, email: 'admin@gym.test', role: 'GYM_ADMIN', principal: 'gym', tokenVersion: 0 },
    process.env.JWT_SECRET || 'test-secret'
  );
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/payments', paymentsRoutes);
  return instance;
}

test('POST /api/payments persists YYYY-MM-DD due date exactly', async () => {
  setupAuth();
  let findCount = 0;
  mockMethod(prisma.member as any, 'findFirst', (async () => ({ id: 21, gymId: 10, name: 'Ali' })) as any);
  mockMethod(prisma.payment as any, 'findFirst', (async () => {
    findCount += 1;
    return null;
  }) as any);
  let createdData: any;
  mockMethod(prisma.payment as any, 'create', (async (args: any) => {
    createdData = args.data;
    return {
      id: 5,
      ...args.data,
      paidDate: null,
      member: { id: 21, name: 'Ali', legacyMemberId: 'M-21' },
    };
  }) as any);

  const res = await request(app())
    .post('/api/payments')
    .set('Authorization', `Bearer ${token()}`)
    .send({ memberId: 21, month: '2026-08', amount: 3000, dueDate: '2026-08-31' });

  assert.equal(res.status, 201);
  assert.equal(findCount, 1);
  assert.equal(createdData.dueDate.toISOString(), '2026-08-31T00:00:00.000Z');
  assert.equal(createdData.status, 'PENDING');
  assert.equal(new Date(res.body.data.dueDate).toISOString(), '2026-08-31T00:00:00.000Z');
});

test('POST /api/payments rejects malformed due date', async () => {
  setupAuth();
  const res = await request(app())
    .post('/api/payments')
    .set('Authorization', `Bearer ${token()}`)
    .send({ memberId: 21, month: '2026-08', amount: 3000, dueDate: '31-08-2026' });

  assert.equal(res.status, 422);
  assert.ok(res.body.error.details.some((d: any) => d.path === 'body.dueDate'));
});

test('GET /api/payments/:id/receipt returns complete monthly receipt', async () => {
  setupAuth();
  mockMethod(prisma.payment as any, 'findFirst', (async () => ({
    id: 5,
    gymId: 10,
    memberId: 21,
    month: '2026-08',
    amount: 3000,
    status: 'PAID',
    dueDate: new Date('2026-08-15T00:00:00.000Z'),
    paidDate: new Date('2026-08-14T00:00:00.000Z'),
    member: {
      id: 21,
      legacyMemberId: 'M-21',
      name: 'Ali',
      email: null,
      phone: '03000000000',
      cnic: null,
      membershipStart: new Date('2026-01-15T00:00:00.000Z'),
      membershipEnd: null,
      monthlyPaymentAmount: 3000,
      discount: 0,
      isActive: true,
      package: {
        id: 4,
        name: 'Gold',
        duration: '12 months',
        price: 36000,
        discount: 0,
        features: [{ feature: { name: 'Gym Access' } }],
      },
      trainers: [],
    },
    gym: {
      id: 10,
      name: 'Fit Gym',
      logoUrl: null,
      address: 'Main Road',
      city: 'Karachi',
      country: 'Pakistan',
      phone: null,
      email: null,
    },
  })) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => null) as any);

  const res = await request(app())
    .get('/api/payments/5/receipt')
    .set('Authorization', `Bearer ${token()}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.data.member.memberNumber, 'M-21');
  assert.equal(res.body.data.payment.amount, 3000);
  assert.equal(res.body.data.package.startDate, '2026-08-15');
  assert.equal(res.body.data.package.expiryDate, '2026-09-15');
  assert.equal(res.body.data.gym.name, 'Fit Gym');
});

test('GET /api/payments/one-time/:id/receipt returns signup receipt', async () => {
  setupAuth();
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => ({
    id: 9,
    gymId: 10,
    memberId: 21,
    admissionFee: 1000,
    packageFee: 3000,
    trainerFee: 500,
    totalAmount: 4500,
    status: 'PAID',
    paidDate: new Date('2026-08-14T00:00:00.000Z'),
    createdAt: new Date('2026-08-14T00:00:00.000Z'),
    member: {
      id: 21,
      legacyMemberId: 'M-21',
      name: 'Ali',
      email: null,
      phone: null,
      cnic: null,
      membershipStart: new Date('2026-08-14T00:00:00.000Z'),
      membershipEnd: null,
      monthlyPaymentAmount: 3500,
      discount: 0,
      isActive: true,
      package: {
        id: 4,
        name: 'Gold',
        duration: '1 month',
        price: 3000,
        discount: 0,
        features: [{ feature: { name: 'Gym Access' } }],
      },
      trainers: [{ trainer: { id: 2, name: 'Wasim', charges: 500 } }],
    },
    gym: {
      id: 10,
      name: 'Fit Gym',
      logoUrl: null,
      address: null,
      city: null,
      country: null,
      phone: null,
      email: null,
    },
  })) as any);

  const res = await request(app())
    .get('/api/payments/one-time/9/receipt')
    .set('Authorization', `Bearer ${token()}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.data.payment.amount, 4500);
  assert.equal(res.body.data.signupPayment.totalAmount, 4500);
  assert.equal(res.body.data.member.memberNumber, 'M-21');
  assert.equal(res.body.data.package.startDate, '2026-08-14');
});
