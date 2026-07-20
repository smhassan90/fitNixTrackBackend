import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveExpandedGymPermissionKeys,
  effectiveGymPermissionKeys,
  expandGymPermissionKeys,
  GYM_PERMISSION_DEFINITIONS,
  KNOWN_GYM_PERMISSION_KEYS,
  normalizeGymPermissionKeys,
} from './gymPermissions';

test('permission catalog excludes attendance viewing and imports', () => {
  const keys = GYM_PERMISSION_DEFINITIONS.map((permission) => permission.key);
  assert.equal(keys.some((key) => key.includes('import')), false);
  assert.equal(keys.includes('gym.attendance.read'), false);
  assert.equal(keys.length, KNOWN_GYM_PERMISSION_KEYS.size);
});

test('manage and delete permissions imply the required read permissions', () => {
  const expanded = expandGymPermissionKeys(['gym.members.delete', 'gym.devices.manage']);
  assert.equal(expanded.has('gym.members.manage'), true);
  assert.equal(expanded.has('gym.members.read'), true);
  assert.equal(expanded.has('gym.devices.read'), true);
});

test('explicit empty permissions remain empty for non-admin users', () => {
  assert.deepEqual(effectiveGymPermissionKeys('GYM_STAFF', []), []);
});

test('payment permissions imply member/settings/package read access for desk workflows', () => {
  const expanded = expandGymPermissionKeys(['gym.payments.manage']);
  assert.equal(expanded.has('gym.payments.read'), true);
  assert.equal(expanded.has('gym.members.read'), true);
  assert.equal(expanded.has('gym.settings.read'), true);
  assert.equal(expanded.has('gym.packages.read'), true);
});

test('normalizeGymPermissionKeys accepts JSON string arrays', () => {
  assert.deepEqual(
    normalizeGymPermissionKeys('["gym.payments.read","gym.payments.manage"]'),
    ['gym.payments.read', 'gym.payments.manage']
  );
});

test('login/me expanded permissions include implied keys', () => {
  const expanded = effectiveExpandedGymPermissionKeys('GYM_STAFF', ['gym.payments.read']);
  assert.equal(expanded.includes('gym.members.read'), true);
  assert.equal(expanded.includes('gym.settings.read'), true);
});

test('gym administrators always have the complete permission catalog', () => {
  const permissions = effectiveGymPermissionKeys('GYM_ADMIN', []);
  assert.equal(permissions.length, KNOWN_GYM_PERMISSION_KEYS.size);
});
