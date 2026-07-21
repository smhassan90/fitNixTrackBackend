import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidDiscount,
  computeLineAmounts,
  effectiveAllowedForms,
  parseAllowedForms,
  roundMoney,
} from './posHelpers';
import { BadRequestError } from '../../utils/errors';

test('computeLineAmounts applies percent discount correctly', () => {
  const result = computeLineAmounts(100, 2, 'PERCENT', 10);
  assert.equal(result.lineSubtotal, 200);
  assert.equal(result.lineDiscount, 20);
  assert.equal(result.lineTotal, 180);
});

test('computeLineAmounts caps flat discount at line subtotal', () => {
  const result = computeLineAmounts(50, 2, 'FLAT', 100);
  assert.equal(result.lineDiscount, 100);
  assert.equal(result.lineTotal, 0);
});

test('effectiveAllowedForms forces PACKAGED for accessories', () => {
  assert.deepEqual(effectiveAllowedForms('ACCESSORY', ['SERVING']), ['PACKAGED']);
});

test('effectiveAllowedForms defaults nutrients to both forms', () => {
  assert.deepEqual(effectiveAllowedForms('NUTRIENT', null), ['PACKAGED', 'SERVING']);
});

test('parseAllowedForms rejects invalid values', () => {
  assert.throws(() => parseAllowedForms(['INVALID']), BadRequestError);
});

test('assertValidDiscount blocks custom discounts without permission', () => {
  assert.throws(
    () => assertValidDiscount('PERCENT', 20, 100, false, 'NONE', 0),
    BadRequestError
  );
});

test('assertValidDiscount allows product default discount without manage permission', () => {
  assert.doesNotThrow(() =>
    assertValidDiscount('PERCENT', 10, 100, false, 'PERCENT', 10)
  );
});

test('roundMoney rounds to two decimals', () => {
  assert.equal(roundMoney(10.005), 10.01);
});
