import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeReceiptPackageCoverage,
  resolveReceiptAnchorDay,
} from './dateHelpers';

test('coverage uses joining day in paid month', () => {
  const membershipStart = new Date('2026-01-15T00:00:00.000Z');
  const coverage = computeReceiptPackageCoverage('2026-03', membershipStart, membershipStart);
  assert.equal(coverage?.startDate, '2026-03-15');
  assert.equal(coverage?.expiryDate, '2026-04-15');
});

test('first-month signup coverage spans joining month to next month', () => {
  const membershipStart = new Date('2026-01-15T00:00:00.000Z');
  const coverage = computeReceiptPackageCoverage('2026-01', membershipStart, membershipStart);
  assert.equal(coverage?.startDate, '2026-01-15');
  assert.equal(coverage?.expiryDate, '2026-02-15');
});

test('anchor day clamps to month end (e.g. Jan 31 → Feb 28)', () => {
  const membershipStart = new Date('2026-01-31T00:00:00.000Z');
  const coverage = computeReceiptPackageCoverage('2026-02', membershipStart, membershipStart);
  assert.equal(coverage?.startDate, '2026-02-28');
  assert.equal(coverage?.expiryDate, '2026-03-31');
});

test('post-reactivation months use reactive day, earlier months use joining day', () => {
  const membershipStart = new Date('2026-01-15T00:00:00.000Z');
  const billingResumeFrom = new Date('2026-05-20T00:00:00.000Z');

  assert.equal(
    resolveReceiptAnchorDay(membershipStart, billingResumeFrom, '2026-03'),
    15
  );
  assert.equal(
    resolveReceiptAnchorDay(membershipStart, billingResumeFrom, '2026-05'),
    20
  );

  const before = computeReceiptPackageCoverage('2026-03', membershipStart, billingResumeFrom);
  assert.equal(before?.startDate, '2026-03-15');
  assert.equal(before?.expiryDate, '2026-04-15');

  const after = computeReceiptPackageCoverage('2026-06', membershipStart, billingResumeFrom);
  assert.equal(after?.startDate, '2026-06-20');
  assert.equal(after?.expiryDate, '2026-07-20');
});
