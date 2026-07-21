import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveExpandedGymPermissionKeys,
  expandGymPermissionKeys,
  GYM_PERMISSION_DEFINITIONS,
} from './gymPermissions';

test('POS permissions exist in catalog', () => {
  const keys = GYM_PERMISSION_DEFINITIONS.map((permission) => permission.key);
  assert.equal(keys.includes('gym.pos.catalog.read'), true);
  assert.equal(keys.includes('gym.pos.products.manage'), true);
  assert.equal(keys.includes('gym.pos.inventory.manage'), true);
  assert.equal(keys.includes('gym.pos.sell'), true);
  assert.equal(keys.includes('gym.pos.discounts.manage'), true);
  assert.equal(keys.includes('gym.pos.revenue.read'), true);
});

test('POS manage permissions imply catalog read', () => {
  const expanded = expandGymPermissionKeys(['gym.pos.products.manage', 'gym.pos.sell']);
  assert.equal(expanded.has('gym.pos.catalog.read'), true);
});

test('POS discount permission implies sell and catalog read', () => {
  const expanded = expandGymPermissionKeys(['gym.pos.discounts.manage']);
  assert.equal(expanded.has('gym.pos.sell'), true);
  assert.equal(expanded.has('gym.pos.catalog.read'), true);
});

test('POS revenue read implies catalog read only', () => {
  const expanded = effectiveExpandedGymPermissionKeys('GYM_STAFF', ['gym.pos.revenue.read']);
  assert.equal(expanded.includes('gym.pos.catalog.read'), true);
  assert.equal(expanded.includes('gym.pos.sell'), false);
});
