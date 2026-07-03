import { ValidationError } from '../utils/errors';

/** Fallback when gym has no maxMemberDiscount stored (matches legacy Zod cap). */
export const DEFAULT_MAX_MEMBER_DISCOUNT = 100;

export function resolveMaxMemberDiscount(gym: {
  maxMemberDiscount: number | null;
}): number {
  const max = gym.maxMemberDiscount ?? DEFAULT_MAX_MEMBER_DISCOUNT;
  return max < 0 ? 0 : max;
}

export function assertMemberDiscountWithinLimit(
  discount: number | null | undefined,
  maxMemberDiscount: number
): void {
  if (discount == null || discount === 0) {
    return;
  }
  if (discount < 0) {
    throw new ValidationError('Validation failed', [
      { path: 'body.discount', message: 'Discount must be 0 or greater' },
    ]);
  }
  if (discount > maxMemberDiscount) {
    throw new ValidationError('Validation failed', [
      {
        path: 'body.discount',
        message: `Member discount cannot exceed ${maxMemberDiscount}`,
      },
    ]);
  }
}
