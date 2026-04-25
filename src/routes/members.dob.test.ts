import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import membersRoutes from './members';
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

function setupAuth() {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  restores.push(() => {
    process.env.JWT_SECRET = previousSecret;
  });
  mockMethod(prisma.user as any, 'findUnique', (async () => ({
    id: 1,
    email: 'gym@test.com',
    name: 'Gym Admin',
    role: 'GYM_ADMIN',
    gymId: 10,
    tokenVersion: 0,
    gym: { name: 'Gym', tenantStatus: 'ACTIVE' },
  })) as any);
}

function gymToken() {
  return jwt.sign(
    { id: 1, gymId: 10, email: 'gym@test.com', role: 'GYM_ADMIN', principal: 'gym', tokenVersion: 0 },
    process.env.JWT_SECRET || 'test-secret'
  );
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/members', membersRoutes);
  return app;
}

test('update member with YYYY-MM-DD DOB persists and returns ISO string', async () => {
  setupAuth();
  mockMethod(prisma as any, '$queryRawUnsafe', (async () => []) as any);
  mockMethod(prisma.member as any, 'findFirst', (async () => ({
    id: 5,
    gymId: 10,
    membershipStart: new Date('2026-01-01T00:00:00.000Z'),
    packageId: null,
  })) as any);
  let capturedDob: Date | null = null;
  mockMethod(prisma.member as any, 'update', (async (args: any) => {
    capturedDob = args.data.dateOfBirth;
    return {
      id: 5,
      gymId: 10,
      name: 'Ali',
      dateOfBirth: args.data.dateOfBirth,
      trainers: [],
      admissionFeeWaived: false,
      admissionFeePaid: 0,
      oneTimePaymentAmount: 0,
      oneTimePaymentPaid: false,
      monthlyPaymentAmount: 0,
    };
  }) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => null) as any);

  const app = buildApp();
  const res = await request(app)
    .put('/api/members/5')
    .set('Authorization', `Bearer ${gymToken()}`)
    .send({ dateOfBirth: '1990-05-15' });

  assert.equal(res.status, 200);
  assert.ok(capturedDob !== null);
  assert.equal((capturedDob as Date).toISOString(), '1990-05-15T00:00:00.000Z');
  assert.equal(res.body.data.dateOfBirth, '1990-05-15T00:00:00.000Z');
});

test('update member with ISO DOB persists and returns ISO string', async () => {
  setupAuth();
  mockMethod(prisma as any, '$queryRawUnsafe', (async () => []) as any);
  mockMethod(prisma.member as any, 'findFirst', (async () => ({
    id: 5,
    gymId: 10,
    membershipStart: new Date('2026-01-01T00:00:00.000Z'),
    packageId: null,
  })) as any);
  let capturedDob: Date | null = null;
  mockMethod(prisma.member as any, 'update', (async (args: any) => {
    capturedDob = args.data.dateOfBirth;
    return {
      id: 5,
      gymId: 10,
      name: 'Ali',
      dateOfBirth: args.data.dateOfBirth,
      trainers: [],
      admissionFeeWaived: false,
      admissionFeePaid: 0,
      oneTimePaymentAmount: 0,
      oneTimePaymentPaid: false,
      monthlyPaymentAmount: 0,
    };
  }) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => null) as any);

  const app = buildApp();
  const iso = '1990-05-15T09:30:00.000Z';
  const res = await request(app)
    .put('/api/members/5')
    .set('Authorization', `Bearer ${gymToken()}`)
    .send({ dateOfBirth: iso });

  assert.equal(res.status, 200);
  assert.ok(capturedDob !== null);
  assert.equal((capturedDob as Date).toISOString(), iso);
  assert.equal(res.body.data.dateOfBirth, iso);
});

test('invalid DOB returns 422 with body.dateOfBirth', async () => {
  setupAuth();
  const app = buildApp();
  const res = await request(app)
    .put('/api/members/5')
    .set('Authorization', `Bearer ${gymToken()}`)
    .send({ dateOfBirth: '15-05-1990' });

  assert.equal(res.status, 422);
  assert.equal(res.body.success, false);
  const paths = (res.body.error?.details || []).map((d: any) => d.path);
  assert.ok(paths.includes('body.dateOfBirth'));
});

test('list endpoint returns dateOfBirth as string/null', async () => {
  setupAuth();
  mockMethod(prisma as any, '$queryRawUnsafe', (async () => []) as any);
  mockMethod(prisma.member as any, 'count', (async () => 2) as any);
  mockMethod(prisma.member as any, 'findMany', (async () => [
    {
      id: 1,
      gymId: 10,
      name: 'A',
      dateOfBirth: new Date('1990-05-15T00:00:00.000Z'),
      trainers: [],
      package: null,
      _count: { members: 0, trainers: 0 },
      admissionFeeWaived: false,
      admissionFeePaid: 0,
      oneTimePaymentAmount: 0,
      oneTimePaymentPaid: false,
      monthlyPaymentAmount: 0,
    },
    {
      id: 2,
      gymId: 10,
      name: 'B',
      dateOfBirth: null,
      trainers: [],
      package: null,
      _count: { members: 0, trainers: 0 },
      admissionFeeWaived: false,
      admissionFeePaid: 0,
      oneTimePaymentAmount: 0,
      oneTimePaymentPaid: false,
      monthlyPaymentAmount: 0,
    },
  ]) as any);

  const app = buildApp();
  const res = await request(app).get('/api/members').set('Authorization', `Bearer ${gymToken()}`);

  assert.equal(res.status, 200);
  const members = res.body.data.members;
  assert.equal(typeof members[0].dateOfBirth, 'string');
  assert.equal(members[0].dateOfBirth, '1990-05-15T00:00:00.000Z');
  assert.equal(members[1].dateOfBirth, null);
  assert.equal(typeof members[0].dateOfBirth, 'string');
});
