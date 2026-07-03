import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMonthlyPaymentReceipt,
  buildOneTimePaymentReceipt,
} from './receiptService';

const samplePackage = {
  id: 1,
  name: 'Gold',
  duration: '12 months',
  price: 12000,
  discount: 0,
  features: [{ feature: { name: 'Gym access' } }],
};

const sampleGym = {
  id: 1,
  name: 'Fit Gym',
  logoUrl: null,
  address: null,
  city: null,
  country: null,
  phone: null,
  email: null,
};

test('monthly receipt populates package coverage from payment.month and membershipStart', () => {
  const receipt = buildMonthlyPaymentReceipt({
    payment: {
      id: 42,
      month: '2026-03',
      amount: 5000,
      status: 'PAID',
      dueDate: new Date('2026-03-15T00:00:00.000Z'),
      paidDate: new Date('2026-03-10T00:00:00.000Z'),
    },
    member: {
      id: 10,
      name: 'Jane Doe',
      email: null,
      phone: null,
      cnic: null,
      membershipStart: new Date('2026-01-15T00:00:00.000Z'),
      membershipEnd: new Date('2027-01-15T00:00:00.000Z'),
      monthlyPaymentAmount: 5000,
      discount: null,
      isActive: true,
      package: samplePackage,
      trainers: [],
    },
    gym: sampleGym,
    printedBy: null,
  });

  assert.equal(receipt.package?.startDate, '2026-03-15');
  assert.equal(receipt.package?.expiryDate, '2026-04-15');
});

test('monthly receipt falls back to payment.dueDate when membershipStart is missing', () => {
  const receipt = buildMonthlyPaymentReceipt({
    payment: {
      id: 43,
      month: '2026-03',
      amount: 5000,
      status: 'PAID',
      dueDate: new Date('2026-03-15T00:00:00.000Z'),
      paidDate: new Date('2026-03-10T00:00:00.000Z'),
    },
    member: {
      id: 11,
      name: 'Legacy Member',
      email: null,
      phone: null,
      cnic: null,
      membershipStart: null,
      membershipEnd: null,
      monthlyPaymentAmount: 5000,
      discount: null,
      isActive: true,
      package: samplePackage,
      trainers: [],
    },
    gym: sampleGym,
    printedBy: null,
  });

  assert.equal(receipt.package?.startDate, '2026-03-15');
  assert.equal(receipt.package?.expiryDate, '2026-04-15');
});

test('monthly receipt coerces ISO string membershipStart from JSON', () => {
  const receipt = buildMonthlyPaymentReceipt({
    payment: {
      id: 44,
      month: '2026-03',
      amount: 5000,
      status: 'PAID',
      dueDate: '2026-03-15T00:00:00.000Z' as unknown as Date,
      paidDate: null,
    },
    member: {
      id: 12,
      name: 'API Member',
      email: null,
      phone: null,
      cnic: null,
      membershipStart: '2026-01-15T00:00:00.000Z' as unknown as Date,
      membershipEnd: null,
      monthlyPaymentAmount: 5000,
      discount: null,
      isActive: true,
      package: samplePackage,
      trainers: [],
    },
    gym: sampleGym,
    printedBy: null,
  });

  assert.equal(receipt.package?.startDate, '2026-03-15');
  assert.equal(receipt.package?.expiryDate, '2026-04-15');
});

test('one-time receipt populates package coverage for signup month', () => {
  const receipt = buildOneTimePaymentReceipt({
    oneTimePayment: {
      id: 7,
      admissionFee: 1000,
      packageFee: 4000,
      trainerFee: 0,
      totalAmount: 5000,
      status: 'PAID',
      paidDate: new Date('2026-01-15T00:00:00.000Z'),
      createdAt: new Date('2026-01-15T00:00:00.000Z'),
    },
    member: {
      id: 10,
      name: 'Jane Doe',
      email: null,
      phone: null,
      cnic: null,
      membershipStart: new Date('2026-01-15T00:00:00.000Z'),
      membershipEnd: null,
      monthlyPaymentAmount: 4000,
      discount: null,
      isActive: true,
      package: samplePackage,
      trainers: [],
    },
    gym: sampleGym,
    printedBy: null,
  });

  assert.equal(receipt.package?.startDate, '2026-01-15');
  assert.equal(receipt.package?.expiryDate, '2026-02-15');
});

test('receipt package is null when member has no package', () => {
  const receipt = buildMonthlyPaymentReceipt({
    payment: {
      id: 45,
      month: '2026-03',
      amount: 5000,
      status: 'PAID',
      dueDate: new Date('2026-03-15T00:00:00.000Z'),
      paidDate: null,
    },
    member: {
      id: 13,
      name: 'No Package',
      email: null,
      phone: null,
      cnic: null,
      membershipStart: new Date('2026-01-15T00:00:00.000Z'),
      membershipEnd: null,
      monthlyPaymentAmount: null,
      discount: null,
      isActive: true,
      package: null,
      trainers: [],
    },
    gym: sampleGym,
    printedBy: null,
  });

  assert.equal(receipt.package, null);
});
