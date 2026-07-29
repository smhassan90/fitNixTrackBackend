import {
  PosDiscountType,
  PosProductForm,
  PosProductType,
} from '@prisma/client';
import { BadRequestError } from '../../utils/errors';

export const POS_PRODUCT_TYPES = ['NUTRIENT', 'ACCESSORY'] as const;
export const POS_PRODUCT_FORMS = ['PACKAGED', 'SERVING'] as const;
export const POS_DISCOUNT_TYPES = ['NONE', 'PERCENT', 'FLAT'] as const;

export function normalizeOptionalCode(code: string | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  const trimmed = code.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseAllowedForms(value: unknown): PosProductForm[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new BadRequestError('allowedForms must be an array of PACKAGED and/or SERVING');
  }
  const forms = [...new Set(value.map((item) => String(item).toUpperCase()))];
  for (const form of forms) {
    if (form !== 'PACKAGED' && form !== 'SERVING') {
      throw new BadRequestError('allowedForms may only contain PACKAGED and SERVING');
    }
  }
  return forms.length > 0 ? (forms as PosProductForm[]) : null;
}

export function defaultAllowedForms(productType: PosProductType): PosProductForm[] {
  return productType === 'NUTRIENT' ? ['PACKAGED', 'SERVING'] : ['PACKAGED'];
}

/**
 * When subcategory is named Packaged / Serving, lock allowedForms to that form
 * so super admin does not need a separate "is it packaged or serving?" choice.
 */
export function inferAllowedFormsFromName(name: string): PosProductForm[] | null {
  const normalized = name.trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (normalized === 'packaged' || normalized === 'package') return ['PACKAGED'];
  if (normalized === 'serving' || normalized === 'servings') return ['SERVING'];
  return null;
}

/** Single form derived from Packaged / Serving subcategory names. */
export function inferFormFromSubcategoryName(name: string): PosProductForm | null {
  const inferred = inferAllowedFormsFromName(name);
  return inferred?.[0] ?? null;
}

/**
 * Reliable form for API responses.
 * Prefer subcategory name (Packaged/Serving) over a stale DB form for nutrients.
 */
export function resolveDisplayedForm(
  productType: PosProductType,
  form: PosProductForm | null | undefined,
  subcategoryName?: string | null
): PosProductForm {
  if (productType === 'ACCESSORY') return 'PACKAGED';
  if (subcategoryName) {
    const inferred = inferFormFromSubcategoryName(subcategoryName);
    if (inferred) return inferred;
  }
  return form ?? 'PACKAGED';
}

/**
 * Persist form from subcategory when name locks it; otherwise use client/default.
 */
export function resolvePersistedForm(
  productType: PosProductType,
  subcategoryName: string,
  allowedForms: unknown,
  clientForm?: PosProductForm | null
): PosProductForm {
  if (productType === 'ACCESSORY') return 'PACKAGED';
  const inferred = inferFormFromSubcategoryName(subcategoryName);
  if (inferred) return inferred;
  const allowed = effectiveAllowedForms(productType, allowedForms);
  if (clientForm && allowed.includes(clientForm)) return clientForm;
  return allowed.length === 1 ? allowed[0] : 'PACKAGED';
}

export function resolveSubcategoryAllowedForms(
  productType: PosProductType,
  name: string,
  allowedForms?: PosProductForm[] | null
): PosProductForm[] | null {
  if (productType === 'ACCESSORY') return ['PACKAGED'];
  const inferred = inferAllowedFormsFromName(name);
  if (inferred) return inferred;
  if (allowedForms === undefined || allowedForms === null) return null;
  return parseAllowedForms(allowedForms);
}

export function effectiveAllowedForms(
  productType: PosProductType,
  allowedForms: unknown
): PosProductForm[] {
  const parsed = allowedForms === null || allowedForms === undefined
    ? null
    : parseAllowedForms(allowedForms);
  if (productType === 'ACCESSORY') return ['PACKAGED'];
  return parsed ?? defaultAllowedForms(productType);
}

export function assertFormAllowed(
  productType: PosProductType,
  form: PosProductForm,
  allowedForms: unknown
): void {
  const effective = effectiveAllowedForms(productType, allowedForms);
  if (!effective.includes(form)) {
    throw new BadRequestError(
      `Product form ${form} is not allowed for this subcategory. Allowed: ${effective.join(', ')}`
    );
  }
  if (productType === 'ACCESSORY' && form !== 'PACKAGED') {
    throw new BadRequestError('Accessory products must use PACKAGED form');
  }
}

export function computeLineAmounts(
  unitPrice: number,
  quantity: number,
  discountType: PosDiscountType,
  discountValue: number
): { lineSubtotal: number; lineDiscount: number; lineTotal: number } {
  const lineSubtotal = roundMoney(unitPrice * quantity);
  let lineDiscount = 0;
  if (discountType === 'PERCENT') {
    lineDiscount = roundMoney(lineSubtotal * (discountValue / 100));
  } else if (discountType === 'FLAT') {
    lineDiscount = roundMoney(Math.min(discountValue * quantity, lineSubtotal));
  }
  const lineTotal = roundMoney(Math.max(lineSubtotal - lineDiscount, 0));
  return { lineSubtotal, lineDiscount, lineTotal };
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function assertValidDiscount(
  discountType: PosDiscountType,
  discountValue: number,
  unitPrice: number,
  canManageDiscounts: boolean,
  productDefaultType: PosDiscountType,
  productDefaultValue: number
): void {
  if (discountType === 'NONE') {
    if (discountValue !== 0) {
      throw new BadRequestError('discountValue must be 0 when discountType is NONE');
    }
    return;
  }
  if (discountValue < 0) {
    throw new BadRequestError('discountValue cannot be negative');
  }
  if (discountType === 'PERCENT' && discountValue > 100) {
    throw new BadRequestError('Percent discount cannot exceed 100');
  }
  if (discountType === 'FLAT' && discountValue > unitPrice) {
    throw new BadRequestError('Flat discount cannot exceed unit price');
  }
  const differsFromProductDefault =
    discountType !== productDefaultType || discountValue !== productDefaultValue;
  if (differsFromProductDefault && !canManageDiscounts) {
    throw new BadRequestError('You do not have permission to apply custom discounts');
  }
}

export function generateReceiptNo(gymId: number): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `POS-${gymId}-${ts}-${rand}`;
}
