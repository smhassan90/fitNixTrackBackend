import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import trainersRoutes from './trainers';
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
  instance.use('/api/trainers', trainersRoutes);
  return instance;
}

test('POST /api/trainers creates and normalizes a trainer', async () => {
  setupAuth();
  let createData: any;
  mockMethod(prisma.trainer as any, 'create', (async (args: any) => {
    createData = args.data;
    return { id: 7, ...args.data, _count: { members: 0 } };
  }) as any);

  const res = await request(app())
    .post('/api/trainers')
    .set('Authorization', `Bearer ${token()}`)
    .send({
      name: 'Wasim',
      phone: ' 03001234567 ',
      email: 'WASIM@EXAMPLE.COM',
      charges: 2000,
      startTime: '08:00',
      endTime: '16:00',
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.data.name, 'Wasim');
  assert.equal(createData.gymId, 10);
  assert.equal(createData.phone, '03001234567');
  assert.equal(createData.email, 'wasim@example.com');
  assert.equal(createData.isActive, true);
});

test('PATCH /api/trainers/:id updates only supplied fields', async () => {
  setupAuth();
  mockMethod(prisma.trainer as any, 'findFirst', (async () => ({
    id: 7,
    gymId: 10,
    name: 'Old',
    isActive: true,
  })) as any);
  let updateData: any;
  mockMethod(prisma.trainer as any, 'update', (async (args: any) => {
    updateData = args.data;
    return { id: 7, gymId: 10, name: args.data.name, charges: args.data.charges, _count: { members: 0 } };
  }) as any);

  const res = await request(app())
    .patch('/api/trainers/7')
    .set('Authorization', `Bearer ${token()}`)
    .send({ name: 'Updated', charges: 2500 });

  assert.equal(res.status, 200);
  assert.deepEqual(updateData, { name: 'Updated', charges: 2500 });
  assert.equal(res.body.data.name, 'Updated');
});

test('DELETE /api/trainers/:id deletes an unassigned trainer', async () => {
  setupAuth();
  mockMethod(prisma.trainer as any, 'findFirst', (async () => ({
    id: 7,
    gymId: 10,
    _count: { members: 0 },
  })) as any);
  let deletedId: number | undefined;
  mockMethod(prisma.trainer as any, 'delete', (async (args: any) => {
    deletedId = args.where.id;
    return { id: deletedId };
  }) as any);

  const res = await request(app())
    .delete('/api/trainers/7')
    .set('Authorization', `Bearer ${token()}`);

  assert.equal(res.status, 200);
  assert.equal(deletedId, 7);
});

test('DELETE /api/trainers/:id refuses a trainer assigned to members', async () => {
  setupAuth();
  mockMethod(prisma.trainer as any, 'findFirst', (async () => ({
    id: 7,
    gymId: 10,
    _count: { members: 2 },
  })) as any);

  const res = await request(app())
    .delete('/api/trainers/7')
    .set('Authorization', `Bearer ${token()}`);

  assert.equal(res.status, 400);
  assert.match(res.body.error.message, /assigned members/i);
});

test('trainer create rejects invalid working time before DB write', async () => {
  setupAuth();
  let wrote = false;
  mockMethod(prisma.trainer as any, 'create', (async () => {
    wrote = true;
  }) as any);

  const res = await request(app())
    .post('/api/trainers')
    .set('Authorization', `Bearer ${token()}`)
    .send({ name: 'Bad Time', startTime: '8am' });

  assert.equal(res.status, 422);
  assert.equal(wrote, false);
});

test('staff without gym.trainers.manage cannot create a trainer', async () => {
  setupAuth('GYM_STAFF', ['gym.trainers.read']);
  const res = await request(app())
    .post('/api/trainers')
    .set('Authorization', `Bearer ${token('GYM_STAFF')}`)
    .send({ name: 'Blocked' });

  assert.equal(res.status, 403);
});
