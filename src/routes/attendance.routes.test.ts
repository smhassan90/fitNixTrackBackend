import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import attendanceRoutes from './attendance';
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

function setupAuth(role: string, permissionKeys: string[] | null = null) {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret';
  restores.push(() => {
    process.env.JWT_SECRET = previousSecret;
  });
  mockMethod(prisma.user as any, 'findUnique', (async () => ({
    id: 1,
    email: 'staff@gym.test',
    name: 'Staff',
    role,
    permissionKeys,
    gymId: 10,
    isActive: true,
    tokenVersion: 0,
    gym: { name: 'Gym', tenantStatus: 'ACTIVE' },
  })) as any);
  mockMethod(prisma.gym as any, 'findUnique', (async () => ({ timezone: 'Asia/Karachi' })) as any);
}

function token(role: string) {
  return jwt.sign(
    { id: 1, gymId: 10, email: 'staff@gym.test', role, principal: 'gym', tokenVersion: 0 },
    process.env.JWT_SECRET || 'test-secret'
  );
}

test('POST /api/attendance/apply-policies is forbidden without gym.attendancePolicy.manage', async () => {
  setupAuth('GYM_STAFF', ['gym.members.read']);
  const app = express();
  app.use(express.json());
  app.use('/api/attendance', attendanceRoutes);

  const res = await request(app)
    .post('/api/attendance/apply-policies')
    .set('Authorization', `Bearer ${token('GYM_STAFF')}`);

  assert.equal(res.status, 403);
});
