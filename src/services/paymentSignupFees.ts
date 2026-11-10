import { parseDurationToMonths } from '../utils/dateHelpers';

/** Monthly package portion (annual plans divided by 12). */
export function computeMonthlyPackageFee(packageData: {
  price: number;
  discount: number | null;
  duration: string;
}): number {
  const packageDiscount = packageData.discount ?? 0;
  const net = Math.max(0, packageData.price - packageDiscount);
  const months = parseDurationToMonths(packageData.duration);
  return months === 12 ? net / 12 : net;
}

export function computeTrainerFeeFromTrainers(
  trainers: { charges: number | null }[]
): number {
  return trainers.reduce((sum, t) => sum + (t.charges ?? 0), 0);
}

/** Package + trainer fees minus member-level discount (matches portal monthly billing). */
export function computeMemberMonthlyInstallmentAmount(
  packageData: { price: number; discount: number | null; duration: string } | null,
  trainers: { charges: number | null }[],
  memberDiscount: number | null | undefined
): number {
  const packageFee = packageData ? computeMonthlyPackageFee(packageData) : 0;
  const trainerFee = computeTrainerFeeFromTrainers(trainers);
  return Math.max(0, packageFee + trainerFee - (memberDiscount ?? 0));
}

/** Signup one-time = admission + first month (monthly package + trainer − discount). */
export function computeSignupOneTimeFees(params: {
  admissionFeePaid: number;
  packageData: { price: number; discount: number | null; duration: string } | null;
  trainers: { charges: number | null }[];
  memberDiscount: number | null | undefined;
}): {
  admissionFee: number;
  packageFee: number;
  trainerFee: number;
  firstMonthRecurring: number;
  totalAmount: number;
  monthlyInstallmentAmount: number;
} {
  const monthlyPackageFee = params.packageData
    ? computeMonthlyPackageFee(params.packageData)
    : 0;
  const trainerFee = computeTrainerFeeFromTrainers(params.trainers);
  const monthlyInstallmentAmount = computeMemberMonthlyInstallmentAmount(
    params.packageData,
    params.trainers,
    params.memberDiscount
  );
  const firstMonthRecurring =
    params.packageData || trainerFee > 0 ? monthlyInstallmentAmount : 0;
  const totalAmount = params.admissionFeePaid + firstMonthRecurring;
  const packageFee = Math.max(0, monthlyInstallmentAmount - trainerFee);

  return {
    admissionFee: params.admissionFeePaid,
    packageFee,
    trainerFee,
    firstMonthRecurring,
    totalAmount,
    monthlyInstallmentAmount,
  };
}

/** Ensure admission + package + trainer line items match total (legacy rows may omit member discount on packageFee). */
export function normalizeOneTimePaymentBreakdown(payment: {
  admissionFee: number;
  packageFee: number;
  trainerFee: number;
  totalAmount: number;
}): { admissionFee: number; packageFee: number; trainerFee: number; totalAmount: number } {
  const lineSum = payment.admissionFee + payment.packageFee + payment.trainerFee;
  if (Math.abs(lineSum - payment.totalAmount) < 0.01) {
    return payment;
  }
  const firstMonthRecurring = Math.max(0, payment.totalAmount - payment.admissionFee);
  return {
    ...payment,
    packageFee: Math.max(0, firstMonthRecurring - payment.trainerFee),
  };
}
