import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Lightweight pure-logic checks for access-control sorting/partitioning.
 * Service DB paths are covered by integration; this guards the reason rules.
 */
function partitionAccessTargets(
  mappings: Array<{
    deviceUserId: string;
    memberId: number;
    memberName: string;
    isActive: boolean;
    overdue: boolean;
  }>
) {
  const blocked: Array<{ deviceUserId: string; reason: 'inactive' | 'overdue' }> = [];
  const allowed: Array<{ deviceUserId: string }> = [];
  for (const m of mappings) {
    if (!m.isActive) {
      blocked.push({ deviceUserId: m.deviceUserId, reason: 'inactive' });
    } else if (m.overdue) {
      blocked.push({ deviceUserId: m.deviceUserId, reason: 'overdue' });
    } else {
      allowed.push({ deviceUserId: m.deviceUserId });
    }
  }
  return { blocked, allowed };
}

test('overdue active members are blocked', () => {
  const { blocked, allowed } = partitionAccessTargets([
    { deviceUserId: '10', memberId: 1, memberName: 'A', isActive: true, overdue: true },
    { deviceUserId: '11', memberId: 2, memberName: 'B', isActive: true, overdue: false },
  ]);
  assert.deepEqual(blocked, [{ deviceUserId: '10', reason: 'overdue' }]);
  assert.deepEqual(allowed, [{ deviceUserId: '11' }]);
});

test('inactive members are blocked even without overdue', () => {
  const { blocked, allowed } = partitionAccessTargets([
    { deviceUserId: '10', memberId: 1, memberName: 'A', isActive: false, overdue: false },
  ]);
  assert.deepEqual(blocked, [{ deviceUserId: '10', reason: 'inactive' }]);
  assert.equal(allowed.length, 0);
});

test('inactive wins over overdue reason', () => {
  const { blocked } = partitionAccessTargets([
    { deviceUserId: '10', memberId: 1, memberName: 'A', isActive: false, overdue: true },
  ]);
  assert.equal(blocked[0]?.reason, 'inactive');
});
