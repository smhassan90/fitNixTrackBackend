import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDuesProjection,
  computePaceProjection,
  daysInCalendarMonth,
  lastCalendarDateOfMonth,
  resolvePnlDayOfMonth,
} from './pnlSummaryService';

test('daysInCalendarMonth handles 31-day and February', () => {
  assert.equal(daysInCalendarMonth('2026-07'), 31);
  assert.equal(daysInCalendarMonth('2026-02'), 28);
  assert.equal(daysInCalendarMonth('2024-02'), 29);
});

test('lastCalendarDateOfMonth pads the day', () => {
  assert.equal(lastCalendarDateOfMonth('2026-07'), '2026-07-31');
  assert.equal(lastCalendarDateOfMonth('2026-02'), '2026-02-28');
});

test('resolvePnlDayOfMonth uses elapsed days in current month, full month in the past, 0 in the future', () => {
  assert.equal(resolvePnlDayOfMonth('2026-07', '2026-07-14'), 14);
  assert.equal(resolvePnlDayOfMonth('2026-06', '2026-07-14'), 30);
  assert.equal(resolvePnlDayOfMonth('2026-08', '2026-07-14'), 0);
});

test('pace projection scales MTD income and expenses then adds unbooked recurring', () => {
  const pace = computePaceProjection({
    incomeSoFar: 86900,
    expensesSoFar: 18250,
    remainingRecurring: 76500,
    dayOfMonth: 14,
    daysInMonth: 31,
  });
  assert.equal(pace.projectedIncome, Math.round((86900 * 31) / 14 * 100) / 100);
  assert.equal(
    pace.projectedExpenses,
    Math.round(((18250 * 31) / 14 + 76500) * 100) / 100
  );
  assert.equal(pace.projectedNet, Math.round((pace.projectedIncome - pace.projectedExpenses) * 100) / 100);
  assert.equal(pace.dayOfMonth, 14);
  assert.equal(pace.daysInMonth, 31);
});

test('pace projection is zero when the month has not started', () => {
  const pace = computePaceProjection({
    incomeSoFar: 0,
    expensesSoFar: 0,
    remainingRecurring: 25000,
    dayOfMonth: 0,
    daysInMonth: 31,
  });
  assert.equal(pace.projectedIncome, 0);
  assert.equal(pace.projectedExpenses, 25000);
  assert.equal(pace.projectedNet, -25000);
});

test('dues projection adds unpaid dues and remaining recurring to MTD', () => {
  const dues = computeDuesProjection({
    incomeSoFar: 86900,
    expensesSoFar: 18250,
    expectedRemaining: 12000,
    remainingRecurring: 76500,
  });
  assert.equal(dues.expectedRemaining, 12000);
  assert.equal(dues.projectedIncome, 98900);
  assert.equal(dues.projectedExpenses, 94750);
  assert.equal(dues.projectedNet, 4150);
});
