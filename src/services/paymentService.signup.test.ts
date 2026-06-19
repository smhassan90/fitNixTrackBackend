import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMonthlyPackageFee,
  computeMemberMonthlyInstallmentAmount,
  computeSignupOneTimeFees,
  normalizeOneTimePaymentBreakdown,
} from './paymentService';

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
