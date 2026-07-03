import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_MEMBER_DISCOUNT,
  resolveMaxMemberDiscount,
  assertMemberDiscountWithinLimit,
} from './memberDiscountPolicy';
import { ValidationError } from '../utils/errors';

test('resolveMaxMemberDiscount uses gym setting or default', () => {
  assert.equal(resolveMaxMemberDiscount({ maxMemberDiscount: 500 }), 500);
  assert.equal(resolveMaxMemberDiscount({ maxMemberDiscount: null }), DEFAULT_MAX_MEMBER_DISCOUNT);
});

test('assertMemberDiscountWithinLimit allows zero and null', () => {
  assert.doesNotThrow(() => assertMemberDiscountWithinLimit(null, 100));
  assert.doesNotThrow(() => assertMemberDiscountWithinLimit(0, 100));
});

test('assertMemberDiscountWithinLimit rejects over cap', () => {
  assert.throws(
    () => assertMemberDiscountWithinLimit(150, 100),
    (err: unknown) => {
      assert.ok(err instanceof ValidationError);
      assert.equal(err.details?.[0]?.path, 'body.discount');
      return true;
    }
  );
});
