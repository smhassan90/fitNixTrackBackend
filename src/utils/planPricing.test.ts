import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePlanPayable,
  addPlanBillingCycle,
  serializePlatformPlan,
} from './planPricing';

test('calculatePlanPayable for monthly / biannual / annual cycles', () => {
  const monthly = calculatePlanPayable(2500, 'MONTHLY');
  assert.equal(monthly.payable, 2500);
  assert.equal(monthly.discountPercent, 0);
  assert.equal(monthly.months, 1);

  const biannual = calculatePlanPayable(2500, 'BIANNUAL');
  assert.equal(biannual.payable, 13500);
  assert.equal(biannual.discountPercent, 10);
  assert.equal(biannual.effectiveMonthly, 2250);

  const annual = calculatePlanPayable(2500, 'ANNUAL');
  assert.equal(annual.payable, 24000);
  assert.equal(annual.discountPercent, 20);
  assert.equal(annual.effectiveMonthly, 2000);
});

test('YEARLY normalizes to ANNUAL', () => {
  assert.equal(calculatePlanPayable(2500, 'YEARLY').billingCycle, 'ANNUAL');
  assert.equal(calculatePlanPayable(2500, 'YEARLY').payable, 24000);
});

test('addPlanBillingCycle advances by cycle months', () => {
  assert.equal(addPlanBillingCycle('2026-01-15', 'MONTHLY'), '2026-02-15');
  assert.equal(addPlanBillingCycle('2026-01-15', 'BIANNUAL'), '2026-07-15');
  assert.equal(addPlanBillingCycle('2026-01-15', 'ANNUAL'), '2027-01-15');
});

test('serializePlatformPlan returns DB fields without pricing breakdown', () => {
  const serialized = serializePlatformPlan({
    id: 1,
    name: 'Starter',
    code: 'STARTER',
    description: 'Up to 100 members',
    price: 2500,
    currency: 'PKR',
    billingCycle: 'MONTHLY',
    maxMembers: 100,
    isActive: true,
    sortOrder: 1,
    features: null,
  });
  assert.equal(serialized.monthlyPrice, 2500);
  assert.equal(serialized.maxMembers, 100);
  assert.equal(serialized.status, 'ACTIVE');
  assert.equal('pricing' in serialized, false);
});
