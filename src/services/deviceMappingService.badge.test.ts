import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectDeviceBadgeIds,
  isBadgeGhostDeviceUser,
  resolveCanonicalDeviceUserId,
  type DeviceUserIdentifierMap,
} from './deviceMappingService';

test('resolveCanonicalDeviceUserId maps badge to uid', () => {
  const map: DeviceUserIdentifierMap = new Map([
    ['10', '10'],
    ['311', '10'],
    ['11', '11'],
    ['159', '11'],
  ]);

  assert.equal(resolveCanonicalDeviceUserId(map, '159'), '11');
  assert.equal(resolveCanonicalDeviceUserId(map, '11'), '11');
  assert.equal(resolveCanonicalDeviceUserId(map, '999'), '999');
});

test('isBadgeGhostDeviceUser detects nameless badge duplicates', () => {
  const badgeIds = collectDeviceBadgeIds([
    { deviceBadgeId: '311' },
    { deviceBadgeId: '159' },
  ]);

  assert.equal(
    isBadgeGhostDeviceUser({ deviceUserId: '159', deviceUserName: null }, badgeIds),
    true
  );
  assert.equal(
    isBadgeGhostDeviceUser({ deviceUserId: '11', deviceUserName: 'Rizwan' }, badgeIds),
    false
  );
});
