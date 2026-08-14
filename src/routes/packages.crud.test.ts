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
  const previous = obj[key];
  (obj as any)[key] = value;
  restores.push(() => {
    (obj as any)[key] = previous;
  });
}

afterEach(() => {
  while (restores.length) restores.pop()?.();
});

function setupAuth(role = 'GYM_ADMIN', permissionKeys: string[] | null = null) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  restores.push(() => {
    process.env.JWT_SECRET = previousSecret;
  });
  mockMethod(prisma.user as any, 'findUnique', (async () => ({
    id: 1,
    email: 'admin@gym.test',
    name: 'Admin',
    role,
    permissionKeys,
    gymId: 10,
    isActive: true,
    tokenVersion: 0,
    gym: { name: 'Gym', tenantStatus: 'ACTIVE' },
  })) as any);
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({ timezone: 'Asia/Karachi' })) as any);
}

function token(role = 'GYM_ADMIN') {
  return jwt.sign(
    { id: 1, gymId: 10, email: 'admin@gym.test', role, principal: 'gym', tokenVersion: 0 },
    process.env.JWT_SECRET || 'test-secret'
  );
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/packages', packagesRoutes);
  return instance;
}

test('POST /api/packages creates package and assigns selected features', async () => {
  setupAuth();
  let createdData: any;
  let featureLinks: any[] = [];
  mockMethod(prisma.package as any, 'create', (async (args: any) => {
    createdData = args.data;
    return { id: 8 };
  }) as any);
  mockMethod((prisma as any).feature, 'findMany', (async () => [{ id: 1 }, { id: 2 }]) as any);
  mockMethod((prisma as any).packageFeature, 'createMany', (async (args: any) => {
    featureLinks = args.data;
    return { count: args.data.length };
  }) as any);
  mockMethod(prisma.package as any, 'findFirst', (async () => ({
    id: 8,
    gymId: 10,
    name: 'Gold',
    price: 12000,
    discount: 500,
    duration: '12 months',
    features: [
      { feature: { name: 'Gym Access' } },
      { feature: { name: 'Cardio' } },
    ],
  })) as any);

  const res = await request(app())
    .post('/api/packages')
    .set('Authorization', `Bearer ${token()}`)
    .send({
      name: 'Gold',
      price: 12000,
      discount: 500,
      duration: '12 months',
      featureIds: [1, 2],
    });

  assert.equal(res.status, 201);
  assert.equal(createdData.gymId, 10);
  assert.deepEqual(featureLinks, [
    { packageId: 8, featureId: 1 },
    { packageId: 8, featureId: 2 },
  ]);
  assert.deepEqual(res.body.data.features, ['Gym Access', 'Cardio']);
});

test('PUT /api/packages/:id updates package and replaces feature assignments', async () => {
  setupAuth();
  mockMethod(prisma.package as any, 'findFirst', (async () => ({ id: 8, gymId: 10 })) as any);
  let deletedLinksFor: number | undefined;
  mockMethod((prisma as any).packageFeature, 'deleteMany', (async (args: any) => {
    deletedLinksFor = args.where.packageId;
    return { count: 2 };
  }) as any);
  let updateData: any;
  mockMethod(prisma.package as any, 'update', (async (args: any) => {
    updateData = args.data;
    return {
      id: 8,
      gymId: 10,
      name: args.data.name,
      price: args.data.price,
      duration: '12 months',
      features: [{ feature: { name: 'Sauna' } }],
    };
  }) as any);

  const res = await request(app())
    .put('/api/packages/8')
    .set('Authorization', `Bearer ${token()}`)
    .send({ name: 'Gold Plus', price: 15000, featureIds: [9] });

  assert.equal(res.status, 200);
  assert.equal(deletedLinksFor, 8);
  assert.deepEqual(updateData.features, { create: [{ featureId: 9 }] });
  assert.equal(res.body.data.name, 'Gold Plus');
  assert.deepEqual(res.body.data.features, ['Sauna']);
});

test('DELETE /api/packages/:id deletes an unassigned package and its links', async () => {
  setupAuth();
  mockMethod(prisma as any, '$queryRaw', (async () => [{ id: 8, memberCount: 0 }]) as any);
  let deletedLinksFor: number | undefined;
  mockMethod((prisma as any).packageFeature, 'deleteMany', (async (args: any) => {
    deletedLinksFor = args.where.packageId;
    return { count: 1 };
  }) as any);
  let executed = false;
  mockMethod(prisma as any, '$executeRaw', (async () => {
    executed = true;
    return 1;
  }) as any);

  const res = await request(app())
    .delete('/api/packages/8')
    .set('Authorization', `Bearer ${token()}`);

  assert.equal(res.status, 200);
  assert.equal(deletedLinksFor, 8);
  assert.equal(executed, true);
});

test('DELETE /api/packages/:id refuses a package assigned to a member', async () => {
  setupAuth();
  mockMethod(prisma as any, '$queryRaw', (async () => [{ id: 8, memberCount: 1 }]) as any);

  const res = await request(app())
    .delete('/api/packages/8')
    .set('Authorization', `Bearer ${token()}`);

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /assigned to members/i);
});

test('package create rejects unsupported duration', async () => {
  setupAuth();
  const res = await request(app())
    .post('/api/packages')
    .set('Authorization', `Bearer ${token()}`)
    .send({ name: 'Invalid', price: 1000, duration: '2 months' });

  assert.equal(res.status, 422);
});

test('staff with only gym.packages.read cannot create a package', async () => {
  setupAuth('GYM_STAFF', ['gym.packages.read']);
  const res = await request(app())
    .post('/api/packages')
    .set('Authorization', `Bearer ${token('GYM_STAFF')}`)
    .send({ name: 'Gold', price: 1000, duration: '1 month' });

  assert.equal(res.status, 403);
});
