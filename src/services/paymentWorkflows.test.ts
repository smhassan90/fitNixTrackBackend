import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteMonthlyPaymentAndReverseCollection,
  generatePaymentsForMember,
  markLastPaidInstallmentUnpaid,
  markOverduePayments,
  markPaymentAsPaid,
  markSignupOneTimeUnpaid,
} from './paymentService';
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

test('generatePaymentsForMember preserves membership anchor as due date', async () => {
  const membershipStart = new Date('2026-01-31T00:00:00.000Z');
  mockMethod(prisma.package as any, 'findFirst', (async () => ({
    id: 4,
    gymId: 10,
    price: 6000,
    discount: 0,
    duration: '3 months',
  })) as any);
  mockMethod(prisma.member as any, 'findFirst', (async (args: any) => {
    if (args.include?.package) {
      return {
        id: 21,
        gymId: 10,
        packageId: 4,
        package: { id: 4, price: 6000, discount: 0, duration: '3 months' },
        membershipStart,
        membershipEnd: null,
        billingResumeFrom: null,
        isActive: true,
        discount: 0,
        trainers: [],
      };
    }
    return {
      id: 21,
      gymId: 10,
      discount: 0,
      package: { id: 4, price: 6000, discount: 0, duration: '3 months' },
      trainers: [],
    };
  }) as any);
  mockMethod(prisma.payment as any, 'deleteMany', (async () => ({ count: 0 })) as any);
  mockMethod(prisma.payment as any, 'findFirst', (async () => null) as any);
  let created: any;
  mockMethod(prisma.payment as any, 'create', (async (args: any) => {
    created = args.data;
    return { id: 1, ...args.data };
  }) as any);
  mockMethod(prisma.payment as any, 'updateMany', (async () => ({ count: 1 })) as any);
  mockMethod(prisma.member as any, 'update', (async () => ({ id: 21 })) as any);

  await generatePaymentsForMember(21, 10, 4, membershipStart);

  assert.equal(created.month, '2026-01');
  assert.equal(created.dueDate.toISOString(), '2026-01-31T00:00:00.000Z');
  assert.equal(created.amount, 6000);
});

test('markPaymentAsPaid updates installment and creates dashboard fee collection', async () => {
  const payment = {
    id: 5,
    gymId: 10,
    memberId: 21,
    month: '2026-08',
    amount: 3000,
    status: 'PENDING',
    dueDate: new Date('2026-08-15T00:00:00.000Z'),
    paidDate: null,
    member: {
      id: 21,
      name: 'Ali',
      packageId: null,
      package: null,
      membershipStart: null,
      membershipEnd: null,
      billingResumeFrom: null,
      isActive: true,
    },
  };
  mockMethod(prisma.payment as any, 'findFirst', (async () => payment) as any);
  mockMethod(prisma.payment as any, 'findMany', (async () => [payment]) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => null) as any);
  mockMethod(prisma.member as any, 'findFirst', (async () => ({ id: 21, packageId: null })) as any);

  let paidUpdate: any;
  let collection: any;
  const tx = {
    payment: {
      update: async (args: any) => {
        paidUpdate = args.data;
        return { ...payment, ...args.data };
      },
      findFirst: async () => null,
      create: async () => null,
    },
    member: {
      findFirst: async () => ({ membershipStart: null, oneTimePaymentPaid: false }),
    },
    oneTimePayment: { findFirst: async () => null },
    feeCollection: {
      findUnique: async () => null,
      create: async (args: any) => {
        collection = args.data;
        return { id: 100, ...args.data };
      },
    },
  };
  mockMethod(prisma as any, '$transaction', (async (callback: any) => callback(tx)) as any);

  await markPaymentAsPaid(5, 10);

  assert.equal(paidUpdate.status, 'PAID');
  assert.ok(paidUpdate.paidDate instanceof Date);
  assert.equal(collection.sourceType, 'MONTHLY_PAYMENT');
  assert.equal(collection.sourceId, 5);
  assert.equal(collection.amount, 3000);
  assert.equal(collection.billingMonth, '2026-08');
});

test('markLastPaidInstallmentUnpaid reverses status, future rows, and income ledger', async () => {
  const payment = {
    id: 5,
    gymId: 10,
    memberId: 21,
    month: '2026-08',
    amount: 3000,
    status: 'PAID',
    dueDate: new Date('2026-08-15T00:00:00.000Z'),
    paidDate: new Date('2026-08-14T00:00:00.000Z'),
  };
  let finalRead = false;
  mockMethod(prisma.payment as any, 'findFirst', (async (args: any) => {
    if (args.include?.member) {
      finalRead = true;
      return { ...payment, status: 'PENDING', paidDate: null, member: { id: 21, name: 'Ali' } };
    }
    return payment;
  }) as any);
  mockMethod(prisma.payment as any, 'findMany', (async () => []) as any);
  mockMethod(prisma.member as any, 'findFirst', (async () => ({ id: 21, packageId: null })) as any);

  let futureDelete: any;
  let reverted: any;
  let ledgerDelete: any;
  const tx = {
    payment: {
      deleteMany: async (args: any) => {
        futureDelete = args.where;
        return { count: 1 };
      },
      update: async (args: any) => {
        reverted = args.data;
        return { ...payment, ...args.data };
      },
      findUnique: async () => ({ month: '2026-08' }),
    },
    member: {
      findFirst: async () => ({ membershipStart: null, oneTimePaymentPaid: false }),
    },
    oneTimePayment: { findFirst: async () => null },
    feeCollection: {
      deleteMany: async (args: any) => {
        ledgerDelete = args.where;
        return { count: 1 };
      },
    },
  };
  mockMethod(prisma as any, '$transaction', (async (callback: any) => callback(tx)) as any);

  const updated = await markLastPaidInstallmentUnpaid(5, 10);

  assert.equal(reverted.status, 'PENDING');
  assert.equal(reverted.paidDate, null);
  assert.equal(futureDelete.dueDate.gt.toISOString(), payment.dueDate.toISOString());
  assert.deepEqual(ledgerDelete, { sourceType: 'MONTHLY_PAYMENT', sourceId: 5, gymId: 10 });
  assert.equal(finalRead, true);
  assert.equal(updated?.status, 'PENDING');
});

test('markLastPaidInstallmentUnpaid enforces LIFO reversal', async () => {
  const target = {
    id: 5,
    gymId: 10,
    memberId: 21,
    month: '2026-07',
    amount: 3000,
    status: 'PAID',
    dueDate: new Date('2026-07-15T00:00:00.000Z'),
  };
  let call = 0;
  mockMethod(prisma.payment as any, 'findFirst', (async () => {
    call += 1;
    return call === 1
      ? target
      : { ...target, id: 6, month: '2026-08', dueDate: new Date('2026-08-15T00:00:00.000Z') };
  }) as any);

  await assert.rejects(
    () => markLastPaidInstallmentUnpaid(5, 10),
    /Only the latest paid installment/
  );
});

test('deleteMonthlyPaymentAndReverseCollection removes both source and ledger row', async () => {
  mockMethod(prisma.payment as any, 'findFirst', (async () => ({
    id: 5,
    gymId: 10,
    memberId: 21,
  })) as any);
  let ledgerDelete: any;
  let paymentDelete: any;
  const tx = {
    feeCollection: {
      deleteMany: async (args: any) => {
        ledgerDelete = args.where;
        return { count: 1 };
      },
    },
    payment: {
      delete: async (args: any) => {
        paymentDelete = args.where;
        return { id: 5 };
      },
    },
  };
  mockMethod(prisma as any, '$transaction', (async (callback: any) => callback(tx)) as any);

  await deleteMonthlyPaymentAndReverseCollection(5, 10);

  assert.deepEqual(ledgerDelete, { sourceType: 'MONTHLY_PAYMENT', sourceId: 5, gymId: 10 });
  assert.deepEqual(paymentDelete, { id: 5 });
});

test('markPaymentAsPaid refuses later months while overdue exists', async () => {
  const later = {
    id: 6,
    gymId: 10,
    memberId: 21,
    month: '2026-08',
    amount: 3000,
    status: 'PENDING',
    dueDate: new Date('2026-08-15T00:00:00.000Z'),
    member: { id: 21, name: 'Ali', isActive: true, packageId: null, package: null },
  };
  const overdue = {
    id: 5,
    gymId: 10,
    memberId: 21,
    month: '2026-07',
    amount: 3000,
    status: 'OVERDUE',
    dueDate: new Date('2026-07-15T00:00:00.000Z'),
  };
  mockMethod(prisma.payment as any, 'findFirst', (async () => later) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => null) as any);
  mockMethod(prisma.payment as any, 'findMany', (async (args: any) => {
    if (args.where?.status?.in) return [overdue, later];
    return [later];
  }) as any);

  await assert.rejects(
    () => markPaymentAsPaid(6, 10),
    /Clear all overdue installments/
  );
});

test('markPaymentAsPaid blocks monthly pay while signup is still pending', async () => {
  mockMethod(prisma.payment as any, 'findFirst', (async () => ({
    id: 5,
    gymId: 10,
    memberId: 21,
    month: '2026-08',
    amount: 3000,
    status: 'PENDING',
    dueDate: new Date('2026-08-15T00:00:00.000Z'),
    member: { id: 21, name: 'Ali' },
  })) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => ({ id: 9 })) as any);

  await assert.rejects(
    () => markPaymentAsPaid(5, 10),
    /signup one-time payment/
  );
});

test('markPaymentAsPaid skips fee collection when signup already covers month 1', async () => {
  const membershipStart = new Date('2026-08-14T00:00:00.000Z');
  const payment = {
    id: 5,
    gymId: 10,
    memberId: 21,
    month: '2026-08',
    amount: 3000,
    status: 'PENDING',
    dueDate: membershipStart,
    member: {
      id: 21,
      name: 'Ali',
      packageId: null,
      package: null,
      membershipStart,
      membershipEnd: null,
      billingResumeFrom: null,
      isActive: true,
    },
  };
  mockMethod(prisma.payment as any, 'findFirst', (async () => payment) as any);
  mockMethod(prisma.payment as any, 'findMany', (async () => [payment]) as any);
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => null) as any);
  mockMethod(prisma.member as any, 'findFirst', (async () => ({ id: 21, packageId: null })) as any);

  let createdLedger = false;
  const tx = {
    payment: {
      update: async () => ({ ...payment, status: 'PAID' }),
      findFirst: async () => null,
      create: async () => null,
    },
    member: {
      findFirst: async () => ({ membershipStart, oneTimePaymentPaid: true }),
    },
    oneTimePayment: {
      findFirst: async () => ({ totalAmount: 4000, admissionFee: 1000 }),
    },
    feeCollection: {
      findUnique: async () => null,
      create: async () => {
        createdLedger = true;
        return { id: 1 };
      },
    },
  };
  mockMethod(prisma as any, '$transaction', (async (callback: any) => callback(tx)) as any);

  await markPaymentAsPaid(5, 10);
  assert.equal(createdLedger, false);
});

test('markOverduePayments skips inactive members', async () => {
  const previousTz = process.env.GYM_TIMEZONE;
  process.env.GYM_TIMEZONE = 'Asia/Karachi';
  restores.push(() => {
    process.env.GYM_TIMEZONE = previousTz;
  });
  mockMethod(prisma.payment as any, 'findMany', (async () => [
    { id: 1, dueDate: new Date('2026-07-01T00:00:00.000Z'), member: { isActive: true } },
    { id: 2, dueDate: new Date('2026-07-01T00:00:00.000Z'), member: { isActive: false } },
  ]) as any);
  let overdueIds: number[] | undefined;
  mockMethod(prisma.payment as any, 'updateMany', (async (args: any) => {
    overdueIds = args.where.id.in;
    return { count: args.where.id.in.length };
  }) as any);

  const count = await markOverduePayments(10);
  assert.equal(count, 1);
  assert.deepEqual(overdueIds, [1]);
});

test('markSignupOneTimeUnpaid refuses until later monthly installments are unmarked', async () => {
  mockMethod(prisma.oneTimePayment as any, 'findFirst', (async () => ({
    id: 9,
    gymId: 10,
    memberId: 21,
    status: 'PAID',
    paidDate: new Date('2026-08-14T00:00:00.000Z'),
    member: {
      id: 21,
      name: 'Ali',
      membershipStart: new Date('2026-08-14T00:00:00.000Z'),
      oneTimePaymentPaid: true,
    },
  })) as any);
  let paymentCall = 0;
  mockMethod(prisma.payment as any, 'findFirst', (async () => {
    paymentCall += 1;
    if (paymentCall === 1) {
      return { id: 5, memberId: 21, dueDate: new Date('2026-08-14T00:00:00.000Z'), status: 'PAID' };
    }
    return { id: 6, memberId: 21, dueDate: new Date('2026-09-14T00:00:00.000Z'), status: 'PAID' };
  }) as any);

  await assert.rejects(
    () => markSignupOneTimeUnpaid(9, 10),
    /Unmark later monthly installments first/
  );
});
