/**
 * Platform subscription billing cycle math (prepaid months + cycle discounts).
 */

export const PLAN_BILLING_CYCLES = ['MONTHLY', 'BIANNUAL', 'ANNUAL'] as const;
export type PlanBillingCycle = (typeof PLAN_BILLING_CYCLES)[number];

/** Months prepaid for each billing cycle. */
export const PLAN_CYCLE_MONTHS: Record<PlanBillingCycle, number> = {
  MONTHLY: 1,
  BIANNUAL: 6,
  ANNUAL: 12,
};

/** Percentage discount applied to the prepaid subtotal (monthlyPrice × months). */
export const PLAN_CYCLE_DISCOUNT_PERCENT: Record<PlanBillingCycle, number> = {
  MONTHLY: 0,
  BIANNUAL: 10,
  ANNUAL: 20,
};

export type PlanPayableBreakdown = {
  billingCycle: PlanBillingCycle;
  months: number;
  discountPercent: number;
  subtotal: number;
  discountAmount: number;
  payable: number;
  /** payable / months — effective monthly rate after discount */
  effectiveMonthly: number;
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Normalize legacy cycle names (YEARLY → ANNUAL) and unknown values. */
export function normalizePlanBillingCycle(billingCycle: string | null | undefined): PlanBillingCycle {
  const raw = (billingCycle || 'MONTHLY').trim().toUpperCase();
  if (raw === 'YEARLY' || raw === 'YEAR' || raw === 'ANNUAL') return 'ANNUAL';
  if (raw === 'BIANNUAL' || raw === 'BI_ANNUAL' || raw === 'SEMIANNUAL' || raw === 'SEMI_ANNUAL') {
    return 'BIANNUAL';
  }
  if (raw === 'MONTHLY' || raw === 'MONTH') return 'MONTHLY';
  if (raw === 'QUARTERLY') return 'MONTHLY';
  if ((PLAN_BILLING_CYCLES as readonly string[]).includes(raw)) {
    return raw as PlanBillingCycle;
  }
  return 'MONTHLY';
}

export function monthsFromBillingCycle(billingCycle: string | null | undefined): number {
  const raw = (billingCycle || 'MONTHLY').trim().toUpperCase();
  if (raw === 'QUARTERLY') return 3;
  const cycle = normalizePlanBillingCycle(raw);
  return PLAN_CYCLE_MONTHS[cycle];
}

/** payable = monthlyPrice × months × (1 - discountPercent / 100) */
export function calculatePlanPayable(
  monthlyPrice: number,
  billingCycle: string
): PlanPayableBreakdown {
  const cycle = normalizePlanBillingCycle(billingCycle);
  const months = PLAN_CYCLE_MONTHS[cycle];
  const discountPercent = PLAN_CYCLE_DISCOUNT_PERCENT[cycle];
  const subtotal = roundMoney(monthlyPrice * months);
  const discountAmount = roundMoney(subtotal * (discountPercent / 100));
  const payable = roundMoney(subtotal - discountAmount);
  const effectiveMonthly = roundMoney(payable / months);

  return {
    billingCycle: cycle,
    months,
    discountPercent,
    subtotal,
    discountAmount,
    payable,
    effectiveMonthly,
  };
}

/** Advance a YMD date by the selected billing cycle length. */
export function addPlanBillingCycle(ymd: string, billingCycle: string): string {
  const base = new Date(`${ymd}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) {
    throw new Error(`Invalid date: ${ymd}`);
  }
  const months = monthsFromBillingCycle(billingCycle);
  base.setUTCMonth(base.getUTCMonth() + months);
  return base.toISOString().slice(0, 10);
}

export type PlanRow = {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  price: number;
  currency: string;
  billingCycle: string;
  maxMembers?: number | null;
  isActive: boolean;
  sortOrder: number;
  features?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
  deletedAt?: Date | null;
};

/** API shape for plan list/detail responses (DB fields only). */
export function serializePlatformPlan(plan: PlanRow) {
  const monthlyPrice = Number(plan.price);
  return {
    id: plan.id,
    name: plan.name,
    code: plan.code,
    description: plan.description ?? null,
    price: monthlyPrice,
    monthlyPrice,
    currency: plan.currency,
    billingCycle: plan.billingCycle,
    maxMembers: plan.maxMembers ?? null,
    isActive: plan.isActive,
    status: plan.isActive ? 'ACTIVE' : 'INACTIVE',
    sortOrder: plan.sortOrder,
    features: plan.features ?? null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    deletedAt: plan.deletedAt ?? null,
  };
}
