import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { createPlatformLocationsRouter } from './locations';
import { prisma } from '../../lib/prisma';

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

function buildApp(role: 'SUPER_ADMIN' | 'PLATFORM_SUPPORT' = 'SUPER_ADMIN') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).platformUser = {
      id: 10,
      email: 'admin@platform.test',
      name: 'Admin',
      role,
      tokenVersion: 0,
    };
    next();
  });

  const service = {
    async listActiveCountries() {
      return [{ id: 1, name: 'Pakistan', code: 'PK', isActive: true, sortOrder: 1 }];
    },
    async listActiveCitiesByCountryId(countryId: number) {
      if (countryId !== 1) return [];
      return [{ id: 1, countryId: 1, name: 'Karachi', isActive: true, sortOrder: 1 }];
    },
    async getCatalog() {
      return [
        {
          country: { id: 1, name: 'Pakistan', code: 'PK', isActive: true, sortOrder: 1 },
          cities: [{ id: 1, countryId: 1, name: 'Karachi', isActive: true, sortOrder: 1 }],
        },
      ];
    },
    async createCountry(payload: any) {
      return { id: 2, ...payload };
    },
    async updateCountry(id: number, payload: any) {
      return { id, ...payload };
    },
    async createCity(payload: any) {
      return { id: 2, ...payload };
    },
    async updateCity(id: number, payload: any) {
      return { id, ...payload };
    },
    async validateActiveGymLocation(input: { country: string; city: string }) {
      return input;
    },
  };

  app.use(
    createPlatformLocationsRouter({
      service: service as any,
      auditWriter: async () => undefined,
    })
  );
  return app;
}

test('GET location listing endpoints returns data', async () => {
  const app = buildApp();
  const countries = await request(app).get('/locations/countries');
  const cities = await request(app).get('/locations/countries/1/cities');
  const catalog = await request(app).get('/locations/catalog');

  assert.equal(countries.status, 200);
  assert.equal(countries.body.success, true);
  assert.equal(countries.body.data[0].name, 'Pakistan');

  assert.equal(cities.status, 200);
  assert.equal(cities.body.data[0].name, 'Karachi');

  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.data[0].country.name, 'Pakistan');
});

test('SUPER_ADMIN can mutate countries and cities', async () => {
  const app = buildApp('SUPER_ADMIN');
  const createCountry = await request(app).post('/admin/locations/countries').send({ name: 'Turkey' });
  const patchCountry = await request(app).patch('/admin/locations/countries/2').send({ isActive: false });
  const createCity = await request(app).post('/admin/locations/cities').send({
    countryId: 1,
    name: 'Lahore',
  });
  const patchCity = await request(app).patch('/admin/locations/cities/2').send({ isActive: false });

  assert.equal(createCountry.status, 201);
  assert.equal(patchCountry.status, 200);
  assert.equal(createCity.status, 201);
  assert.equal(patchCity.status, 200);
});

test('PLATFORM_SUPPORT cannot mutate locations', async () => {
  const app = buildApp('PLATFORM_SUPPORT');
  const response = await request(app).post('/admin/locations/countries').send({ name: 'Turkey' });
  assert.equal(response.status, 403);
});

test('SUPER_ADMIN can delete city/country and in-use checks block delete', async () => {
  const app = buildApp('SUPER_ADMIN');
  const queryQueue: any[] = [
    [{ id: 10, name: 'Karachi', countryId: 1 }],
    [{ id: 1, name: 'Pakistan' }],
    [{ id: 1, name: 'Pakistan' }],
  ];
  mockMethod(prisma as any, '$queryRaw', (async () => queryQueue.shift() ?? []) as any);
  mockMethod(prisma as any, '$executeRaw', (async () => 1) as any);
  mockMethod(prisma.gym as any, 'count', (async () => 0) as any);

  const cityDelete = await request(app).delete('/admin/locations/cities/10');
  assert.equal(cityDelete.status, 200);
  const countryDelete = await request(app).delete('/admin/locations/countries/1');
  assert.equal(countryDelete.status, 200);

  const inUseApp = buildApp('SUPER_ADMIN');
  const inUseQueue: any[] = [[{ id: 1, name: 'Pakistan' }]];
  mockMethod(prisma as any, '$queryRaw', (async () => inUseQueue.shift() ?? []) as any);
  mockMethod(prisma.gym as any, 'count', (async () => 3) as any);
  const blocked = await request(inUseApp).delete('/admin/locations/countries/1');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'COUNTRY_IN_USE');
});
