import test from 'node:test';
import assert from 'node:assert/strict';
import { posGymReportQuerySchema } from './pos';

test('pos reports summary accepts YYYY-MM-DD from/to', () => {
  const parsed = posGymReportQuerySchema.parse({
    query: {
      groupBy: 'category',
      from: '2026-07-22',
      to: '2026-07-22',
    },
  });
  assert.equal(parsed.query.from, '2026-07-22');
  assert.equal(parsed.query.to, '2026-07-22');
  assert.equal(parsed.query.groupBy, 'category');
});

test('pos reports summary accepts ISO datetime from/to', () => {
  const parsed = posGymReportQuerySchema.parse({
    query: {
      groupBy: 'day',
      from: '2026-07-22T00:00:00.000Z',
      to: '2026-07-22T23:59:59.999Z',
    },
  });
  assert.equal(parsed.query.from, '2026-07-22T00:00:00.000Z');
  assert.equal(parsed.query.to, '2026-07-22T23:59:59.999Z');
});

test('pos reports summary allows omitting from/to', () => {
  const parsed = posGymReportQuerySchema.parse({
    query: { groupBy: 'product' },
  });
  assert.equal(parsed.query.from, undefined);
  assert.equal(parsed.query.to, undefined);
  assert.equal(parsed.query.groupBy, 'product');
});
