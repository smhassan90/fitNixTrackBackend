import { prisma } from '../lib/prisma';
import {
  coerceUtcDate,
  computeReceiptPackageCoverage,
  formatMonth,
} from '../utils/dateHelpers';
import { normalizeOneTimePaymentBreakdown } from './paymentService';

type ReceiptPrintedBy = {
  id: number;
  name: string;
  email: string | null;
  role: string | null;
} | null;

type GymReceiptInfo = {
  id: number;
  name: string;
  logoUrl: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
};

type MemberWithRelations = {
  id: number;
  legacyMemberId?: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  cnic: string | null;
  membershipStart: Date | null;
  membershipEnd: Date | null;
  billingResumeFrom?: Date | null;
  monthlyPaymentAmount: number | null;
  discount: number | null;
  isActive: boolean;
  admissionFeeWaived?: boolean;
  admissionFeePaid?: number | null;
  oneTimePaymentPaid?: boolean;
  package?: {
    id: number;
    name: string;
    duration: string;
    price: number;
    discount: number | null;
    features?: { feature: { name: string } | null }[];
  } | null;
  trainers?: {
    trainer: { id: number; name: string; charges: number | null };
  }[];
};

export function buildReceiptPrintedBy(user: {
  id: number;
  name?: string | null;
  email?: string | null;
  role?: string | null;
} | undefined): ReceiptPrintedBy {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    name: user.name ?? user.email ?? 'Staff',
    email: user.email ?? null,
    role: user.role ?? null,
  };
}

function buildMemberReceiptSection(member: MemberWithRelations) {
  const memberNumber = member.legacyMemberId?.trim() || null;
  return {
    // Gym-facing member ID only — never expose internal PK on receipts.
    memberNumber,
    legacyMemberId: memberNumber,
    name: member.name ?? '',
    email: member.email ?? null,
    phone: member.phone ?? null,
    cnic: member.cnic ?? null,
    membershipStart: member.membershipStart ?? null,
    membershipEnd: member.membershipEnd ?? null,
    monthlyPaymentAmount: member.monthlyPaymentAmount ?? null,
    memberDiscount: member.discount ?? null,
    isActive: member.isActive ?? true,
  };
}

function buildPackageReceiptSection(
  pkg: NonNullable<MemberWithRelations['package']> | null | undefined,
  coverageMonthKey: string | null | undefined,
  member: Pick<MemberWithRelations, 'membershipStart' | 'billingResumeFrom'>,
  installmentDueDate?: Date | string | null
) {
  if (!pkg) {
    return null;
  }

  const dueDate = coerceUtcDate(installmentDueDate);
  const membershipStart = coerceUtcDate(member.membershipStart) ?? dueDate;
  const billingResumeFrom = coerceUtcDate(member.billingResumeFrom);
  const monthKey =
    coverageMonthKey?.trim() || (dueDate ? formatMonth(dueDate) : null);

  const coverage =
    monthKey && membershipStart
      ? computeReceiptPackageCoverage(monthKey, membershipStart, billingResumeFrom)
      : null;

  return {
    id: pkg.id,
    name: pkg.name,
    duration: pkg.duration,
    price: pkg.price,
    discount: pkg.discount ?? 0,
    features: pkg.features?.map((pf) => pf.feature?.name).filter(Boolean) ?? [],
    startDate: coverage?.startDate ?? null,
    expiryDate: coverage?.expiryDate ?? null,
  };
}

function buildTrainersReceiptSection(member: MemberWithRelations) {
  return (
    member.trainers?.map((mt) => ({
      id: mt.trainer.id,
      name: mt.trainer.name,
      charges: mt.trainer.charges,
    })) ?? []
  );
}

function computePackageFeeMonthly(
  pkg: NonNullable<MemberWithRelations['package']> | null | undefined
): number | null {
  if (!pkg) {
    return null;
  }
  const net = Math.max(0, pkg.price - (pkg.discount ?? 0));
  return pkg.duration.includes('12') ? net / 12 : net;
}

export async function findPaidSignupOneTimeForMemberMonth(
  gymId: number,
  memberId: number,
  paymentMonth: string,
  membershipStart: Date | null | undefined
) {
  if (!membershipStart || formatMonth(membershipStart) !== paymentMonth) {
    return null;
  }
  return prisma.oneTimePayment.findFirst({
    where: { gymId, memberId, status: 'PAID' },
    orderBy: { createdAt: 'asc' },
  });
}

export function buildOneTimePaymentReceipt(params: {
  oneTimePayment: {
    id: number;
    admissionFee: number;
    packageFee: number;
    trainerFee: number;
    totalAmount: number;
    status: string;
    paidDate: Date | null;
    createdAt: Date;
  };
  member: MemberWithRelations;
  gym: GymReceiptInfo;
  printedBy: ReceiptPrintedBy;
}) {
  const { oneTimePayment, member, gym, printedBy } = params;
  const normalized = normalizeOneTimePaymentBreakdown(oneTimePayment);
  const trainers = buildTrainersReceiptSection(member);
  const pkg = member.package ?? null;
  const membershipStart = coerceUtcDate(member.membershipStart);
  const coverageAnchorDate =
    oneTimePayment.paidDate ?? oneTimePayment.createdAt;

  return {
    receiptType: 'one-time' as const,
    receiptNumber: `OTP-${oneTimePayment.id}`,
    generatedAt: new Date().toISOString(),
    printedBy,
    gym,
    member: buildMemberReceiptSection(member),
    package: buildPackageReceiptSection(
      pkg,
      membershipStart ? formatMonth(membershipStart) : null,
      member,
      coverageAnchorDate
    ),
    trainers,
    trainerFee: normalized.trainerFee,
    packageFeeMonthly: computePackageFeeMonthly(pkg),
    signupPayment: {
      id: oneTimePayment.id,
      admissionFee: normalized.admissionFee,
      packageFee: normalized.packageFee,
      trainerFee: normalized.trainerFee,
      memberDiscount: member.discount ?? null,
      totalAmount: normalized.totalAmount,
      status: oneTimePayment.status,
      paidDate: oneTimePayment.paidDate,
      createdAt: oneTimePayment.createdAt,
    },
    payment: {
      id: oneTimePayment.id,
      type: 'one-time' as const,
      amount: normalized.totalAmount,
      status: oneTimePayment.status,
      paidDate: oneTimePayment.paidDate,
      createdAt: oneTimePayment.createdAt,
    },
  };
}

export function buildMonthlyPaymentReceipt(params: {
  payment: {
    id: number;
    month: string;
    amount: number;
    status: string;
    dueDate: Date;
    paidDate: Date | null;
  };
  member: MemberWithRelations;
  gym: GymReceiptInfo;
  printedBy: ReceiptPrintedBy;
  signupOneTime?: {
    id: number;
    admissionFee: number;
    packageFee: number;
    trainerFee: number;
    totalAmount: number;
    status: string;
    paidDate: Date | null;
    createdAt: Date;
  } | null;
}) {
  const { payment, member, gym, printedBy, signupOneTime } = params;
  const normalizedSignup = signupOneTime
    ? normalizeOneTimePaymentBreakdown(signupOneTime)
    : null;
  const trainers = buildTrainersReceiptSection(member);
  const pkg = member.package ?? null;
  const trainerFeeTotal = trainers.reduce((sum, t) => sum + (t.charges ?? 0), 0);

  const receiptAmount = normalizedSignup ? normalizedSignup.totalAmount : payment.amount;

  return {
    receiptType: normalizedSignup ? ('signup-monthly' as const) : ('monthly' as const),
    receiptNumber: normalizedSignup ? `OTP-${signupOneTime!.id}` : `PAY-${payment.id}`,
    generatedAt: new Date().toISOString(),
    printedBy,
    gym,
    member: buildMemberReceiptSection(member),
    package: buildPackageReceiptSection(pkg, payment.month, member, payment.dueDate),
    trainers,
    trainerFee: normalizedSignup ? normalizedSignup.trainerFee : trainerFeeTotal,
    packageFeeMonthly: computePackageFeeMonthly(pkg),
    signupPayment: normalizedSignup
      ? {
          id: signupOneTime!.id,
          admissionFee: normalizedSignup.admissionFee,
          packageFee: normalizedSignup.packageFee,
          trainerFee: normalizedSignup.trainerFee,
          memberDiscount: member.discount ?? null,
          totalAmount: normalizedSignup.totalAmount,
          status: signupOneTime!.status,
          paidDate: signupOneTime!.paidDate,
          createdAt: signupOneTime!.createdAt,
        }
      : null,
    payment: {
      id: payment.id,
      type: 'monthly' as const,
      month: payment.month,
      amount: receiptAmount,
      monthlyInstallmentAmount: payment.amount,
      status: payment.status,
      dueDate: payment.dueDate,
      paidDate: payment.paidDate ?? signupOneTime?.paidDate ?? null,
    },
  };
}
