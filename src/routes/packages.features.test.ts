import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import packagesRoutes from './packages';
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

test('GET /api/packages/features returns active features', async () => {
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
    isActive: true,
    tokenVersion: 0,
    gym: { name: 'Gym', tenantStatus: 'ACTIVE' },
  })) as any);
  mockMethod(prisma as any, '$queryRaw', (async () => [
    { id: 1, name: 'Gym Access', code: 'GYM_ACCESS', description: null, isActive: true, sortOrder: 1, createdAt: new Date(), updatedAt: new Date() },
    { id: 2, name: 'Cardio Equipment', code: 'CARDIO_EQUIPMENT', description: null, isActive: true, sortOrder: 2, createdAt: new Date(), updatedAt: new Date() },
  ]) as any);

  const token = jwt.sign(
    { id: 1, gymId: 10, email: 'gym@test.com', role: 'GYM_ADMIN', principal: 'gym', tokenVersion: 0 },
    process.env.JWT_SECRET
  );

  const app = express();
  app.use(express.json());
  app.use('/api/packages', packagesRoutes);
  const res = await request(app).get('/api/packages/features').set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.features.length, 2);
});

test('POST /api/packages/features creates feature for GYM_ADMIN', async () => {
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
    isActive: true,
    tokenVersion: 0,
    gym: { name: 'Gym', tenantStatus: 'ACTIVE' },
  })) as any);

  const queryQueue: any[] = [
    [], // duplicate check
    [
      {
        id: 9,
        name: 'Sauna',
        code: 'SAUNA',
        description: null,
        isActive: true,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  ];
  mockMethod(prisma as any, '$queryRaw', (async () => queryQueue.shift() ?? []) as any);
  mockMethod(prisma as any, '$executeRaw', (async () => 1) as any);

  const token = jwt.sign(
    { id: 1, gymId: 10, email: 'gym@test.com', role: 'GYM_ADMIN', principal: 'gym', tokenVersion: 0 },
    process.env.JWT_SECRET
  );

  const app = express();
  app.use(express.json());
  app.use('/api/packages', packagesRoutes);
  const res = await request(app)
    .post('/api/packages/features')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'Sauna', code: 'SAUNA' });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.feature.name, 'Sauna');
});
