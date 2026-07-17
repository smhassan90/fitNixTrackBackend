import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeSignupOneTimeFees,
  computeMonthlyPackageFee,
  computeMemberMonthlyInstallmentAmount,
  normalizeOneTimePaymentBreakdown,
  isBeforeCurrentGymMonth,
  isPreOperationsAdmission,
  startOfCurrentGymMonth,
  resolveNextSyncDueAfterLastPaid,
  selectPhantomGapUnpaidPayments,
  getGymOperationsStartDate,
} from './paymentService';
import { formatMonth, getBillingAnchorDayUTC, parseDate } from '../utils/dateHelpers';

test('computeSignupOneTimeFees uses first month package not full annual price', () => {
  const fees = computeSignupOneTimeFees({
    admissionFeePaid: 1000,
    packageData: { price: 12000, discount: 0, duration: '12 months' },
    trainers: [{ charges: 500 }],
    memberDiscount: 0,
  });

  assert.equal(computeMonthlyPackageFee({ price: 12000, discount: 0, duration: '12 months' }), 1000);
  assert.equal(fees.packageFee, 1000);
  assert.equal(fees.trainerFee, 500);
  assert.equal(fees.firstMonthRecurring, 1500);
  assert.equal(fees.totalAmount, 2500);
  assert.equal(fees.monthlyInstallmentAmount, 1500);
});

test('computeSignupOneTimeFees applies member discount on recurring portion', () => {
  const fees = computeSignupOneTimeFees({
    admissionFeePaid: 500,
    packageData: { price: 6000, discount: 0, duration: '1 month' },
    trainers: [{ charges: 200 }],
    memberDiscount: 100,
  });

  assert.equal(fees.firstMonthRecurring, 6100);
  assert.equal(fees.totalAmount, 6600);
  assert.equal(fees.packageFee, 5900);
  assert.equal(fees.admissionFee + fees.packageFee + fees.trainerFee, fees.totalAmount);
  assert.equal(
    computeMemberMonthlyInstallmentAmount(
      { price: 6000, discount: 0, duration: '1 month' },
      [{ charges: 200 }],
      100
    ),
    6100
  );
});

test('computeSignupOneTimeFees line items always sum to totalAmount', () => {
  const fees = computeSignupOneTimeFees({
    admissionFeePaid: 1000,
    packageData: { price: 12000, discount: 0, duration: '12 months' },
    trainers: [{ charges: 500 }],
    memberDiscount: 200,
  });

  assert.equal(fees.admissionFee + fees.packageFee + fees.trainerFee, fees.totalAmount);
});

test('normalizeOneTimePaymentBreakdown fixes legacy packageFee without discount', () => {
  const normalized = normalizeOneTimePaymentBreakdown({
    admissionFee: 500,
    packageFee: 6000,
    trainerFee: 200,
    totalAmount: 6600,
  });

  assert.equal(normalized.packageFee, 5900);
  assert.equal(
    normalized.admissionFee + normalized.packageFee + normalized.trainerFee,
    normalized.totalAmount
  );
});

test('computeSignupOneTimeFees admission only when no package or trainer', () => {
  const fees = computeSignupOneTimeFees({
    admissionFeePaid: 800,
    packageData: null,
    trainers: [],
    memberDiscount: 0,
  });

  assert.equal(fees.totalAmount, 800);
  assert.equal(fees.firstMonthRecurring, 0);
  assert.equal(fees.monthlyInstallmentAmount, 0);
});

test('isPreOperationsAdmission uses GYM_OPERATIONS_START default 2026-01-01', () => {
  assert.equal(getGymOperationsStartDate().toISOString().slice(0, 10), '2026-01-01');
  assert.equal(isPreOperationsAdmission(parseDate('2025-01-29')), true);
  assert.equal(isPreOperationsAdmission(parseDate('2025-12-31')), true);
  assert.equal(isPreOperationsAdmission(parseDate('2026-01-01')), false);
  assert.equal(isPreOperationsAdmission(parseDate('2026-01-22')), false);
});

test('isBeforeCurrentGymMonth distinguishes historical vs current month', () => {
  const now = parseDate('2026-07-17');
  assert.equal(isBeforeCurrentGymMonth(parseDate('2025-01-29'), now), true);
  assert.equal(isBeforeCurrentGymMonth(parseDate('2026-06-01'), now), true);
  assert.equal(isBeforeCurrentGymMonth(parseDate('2026-07-01'), now), false);
});

test('startOfCurrentGymMonth returns first of gym month', () => {
  assert.equal(startOfCurrentGymMonth(parseDate('2026-07-17')).toISOString().slice(0, 10), '2026-07-01');
});

test('resolveNextSyncDueAfterLastPaid jumps for pre-operations signup-seed only', () => {
  const membershipStart = parseDate('2025-01-29');
  const anchorDay = getBillingAnchorDayUTC(membershipStart);
  const now = parseDate('2026-07-17');

  const next = resolveNextSyncDueAfterLastPaid({
    lastPaidDueDate: membershipStart,
    membershipStart,
    billingResumeFrom: null,
    anchorDay,
    now,
  });

  assert.equal(formatMonth(next), '2026-07');
});

test('resolveNextSyncDueAfterLastPaid does NOT jump for 2026 joiner with only month1 paid', () => {
  const membershipStart = parseDate('2026-01-22');
  const anchorDay = getBillingAnchorDayUTC(membershipStart);
  const now = parseDate('2026-07-17');

  const next = resolveNextSyncDueAfterLastPaid({
    lastPaidDueDate: membershipStart,
    membershipStart,
    billingResumeFrom: null,
    anchorDay,
    now,
  });

  // Legitimate chain: next month after Jan is February, not July.
  assert.equal(formatMonth(next), '2026-02');
});

test('resolveNextSyncDueAfterLastPaid respects explicit billingResumeFrom', () => {
  const membershipStart = parseDate('2025-01-29');
  const anchorDay = getBillingAnchorDayUTC(membershipStart);
  const now = parseDate('2026-07-17');

  const next = resolveNextSyncDueAfterLastPaid({
    lastPaidDueDate: membershipStart,
    membershipStart,
    billingResumeFrom: parseDate('2026-03-01'),
    anchorDay,
    now,
  });

  assert.equal(formatMonth(next), '2026-03');
});

test('resolveNextSyncDueAfterLastPaid keeps normal chain after recent paid month', () => {
  const membershipStart = parseDate('2025-01-29');
  const anchorDay = getBillingAnchorDayUTC(membershipStart);
  const now = parseDate('2026-07-17');

  const next = resolveNextSyncDueAfterLastPaid({
    lastPaidDueDate: parseDate('2026-05-29'),
    membershipStart,
    billingResumeFrom: null,
    anchorDay,
    now,
  });

  assert.equal(formatMonth(next), '2026-06');
});

test('selectPhantomGapUnpaidPayments Sufiyan (2025) removes pre-current unpaid', () => {
  const membershipStart = parseDate('2025-01-29');
  const resumeFrom = parseDate('2026-07-01');
  const payments = [
    { id: 1, status: 'PAID', dueDate: parseDate('2025-01-29') },
    { id: 2, status: 'OVERDUE', dueDate: parseDate('2025-02-28') },
    { id: 3, status: 'OVERDUE', dueDate: parseDate('2025-03-29') },
    { id: 4, status: 'OVERDUE', dueDate: parseDate('2026-06-29') },
    { id: 5, status: 'PENDING', dueDate: parseDate('2026-07-29') },
  ];

  const { gapUnpaid, setBillingResume } = selectPhantomGapUnpaidPayments({
    membershipStart,
    payments,
    resumeFrom,
  });

  assert.equal(setBillingResume, true);
  assert.deepEqual(
    gapUnpaid.map((p) => p.id),
    [2, 3, 4]
  );
});

test('selectPhantomGapUnpaidPayments Sarwar keeps 2026 overdue, drops 2025 phantom', () => {
  const membershipStart = parseDate('2025-01-29');
  const payments = [
    { id: 1, status: 'PAID', dueDate: parseDate('2025-01-29') },
    { id: 2, status: 'OVERDUE', dueDate: parseDate('2025-02-28') },
    { id: 3, status: 'PAID', dueDate: parseDate('2026-02-28') },
    { id: 4, status: 'PAID', dueDate: parseDate('2026-03-29') },
    { id: 7, status: 'OVERDUE', dueDate: parseDate('2026-06-29') },
    { id: 8, status: 'PENDING', dueDate: parseDate('2026-07-29') },
  ];

  const { gapUnpaid, setBillingResume } = selectPhantomGapUnpaidPayments({
    membershipStart,
    payments,
    resumeFrom: parseDate('2026-07-01'),
  });

  assert.equal(setBillingResume, false);
  assert.deepEqual(
    gapUnpaid.map((p) => p.id),
    [2]
  );
});

test('selectPhantomGapUnpaidPayments does not wipe 2026 joiner overdue', () => {
  const membershipStart = parseDate('2026-01-22');
  const payments = [
    { id: 1, status: 'PAID', dueDate: parseDate('2026-01-22') },
    { id: 2, status: 'OVERDUE', dueDate: parseDate('2026-02-22') },
    { id: 3, status: 'OVERDUE', dueDate: parseDate('2026-03-22') },
    { id: 4, status: 'PENDING', dueDate: parseDate('2026-07-22') },
  ];

  const { gapUnpaid, setBillingResume } = selectPhantomGapUnpaidPayments({
    membershipStart,
    payments,
    resumeFrom: parseDate('2026-07-01'),
    now: parseDate('2026-07-17'),
  });

  assert.equal(setBillingResume, false);
  assert.equal(gapUnpaid.length, 0);
});

test('selectPhantomGapUnpaidPayments uses month key when due day is after join day', () => {
  // Join day 1st, due on 31st of same month — must not treat Jan paid as "later paid".
  const membershipStart = parseDate('2025-01-01');
  const payments = [
    { id: 1, status: 'PAID', dueDate: parseDate('2025-01-31') },
    { id: 2, status: 'OVERDUE', dueDate: parseDate('2025-02-28') },
    { id: 3, status: 'OVERDUE', dueDate: parseDate('2025-06-30') },
  ];

  const { gapUnpaid, setBillingResume } = selectPhantomGapUnpaidPayments({
    membershipStart,
    payments,
    resumeFrom: parseDate('2026-07-01'),
  });

  assert.equal(setBillingResume, true);
  assert.deepEqual(
    gapUnpaid.map((p) => p.id),
    [2, 3]
  );
});
