#!/usr/bin/env python3
"""Offline dry-run tests for access-control planner (no device / no network required)."""
from __future__ import annotations

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

# Stub pyzk so planner tests run without the package / device.
zk_mod = types.ModuleType("zk")
zk_mod.ZK = object  # type: ignore[attr-defined]
sys.modules["zk"] = zk_mod

import termux_sync as ts  # noqa: E402


class FakeUser:
  def __init__(self, uid, user_id, name="", group_id="1"):
    self.uid = uid
    self.user_id = user_id
    self.name = name
    self.group_id = group_id
    self.privilege = 0
    self.password = ""
    self.card = 0


def assert_eq(actual, expected, label: str) -> None:
  if actual != expected:
    raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def test_plan_blocks_overdue_in_active_group() -> None:
  users = [
    FakeUser(10, "100", "Overdue Ali", "1"),
    FakeUser(11, "101", "Paid Sara", "1"),
  ]
  blocked = [{"deviceUserId": "10", "reason": "overdue", "memberName": "Overdue Ali"}]
  allowed = [{"deviceUserId": "11", "memberName": "Paid Sara"}]
  updates, missing = ts.plan_access_group_updates(users, blocked, allowed, "1", "2")
  assert_eq(missing, [], "missing")
  assert_eq(len(updates), 1, "update count")
  user, target, current, action = updates[0]
  assert_eq(user.uid, 10, "uid")
  assert_eq(target, "2", "target")
  assert_eq(current, "1", "current")
  assert_eq(action, "block", "action")


def test_plan_restores_paid_member_from_blocked_group() -> None:
  users = [FakeUser(11, "101", "Paid Sara", "2")]
  blocked: list[dict] = []
  allowed = [{"deviceUserId": "11"}]
  updates, missing = ts.plan_access_group_updates(users, blocked, allowed, "1", "2")
  assert_eq(missing, [], "missing")
  assert_eq(len(updates), 1, "update count")
  assert_eq(updates[0][3], "restore", "action")
  assert_eq(updates[0][1], "1", "target")


def test_plan_skips_already_blocked() -> None:
  users = [FakeUser(10, "100", "Overdue Ali", "2")]
  blocked = [{"deviceUserId": "10", "reason": "overdue"}]
  updates, missing = ts.plan_access_group_updates(users, blocked, [], "1", "2")
  assert_eq(updates, [], "no updates")
  assert_eq(missing, [], "missing")


def test_plan_reports_missing_blocked_uid() -> None:
  users = [FakeUser(11, "101", "Paid Sara", "1")]
  blocked = [{"deviceUserId": "99", "reason": "overdue"}]
  updates, missing = ts.plan_access_group_updates(users, blocked, [], "1", "2")
  assert_eq(updates, [], "updates")
  assert_eq(missing, ["99"], "missing")


def test_plan_does_not_touch_custom_group_on_allowed() -> None:
  """Allowed members in group 3 stay put (only restore from blocked group)."""
  users = [FakeUser(11, "101", "VIP", "3")]
  allowed = [{"deviceUserId": "11"}]
  updates, _ = ts.plan_access_group_updates(users, [], allowed, "1", "2")
  assert_eq(updates, [], "custom group preserved")


def test_signature_stable() -> None:
  blocked = [{"deviceUserId": "2", "reason": "overdue"}, {"deviceUserId": "1", "reason": "inactive"}]
  allowed = [{"deviceUserId": "10"}, {"deviceUserId": "3"}]
  a = ts.access_control_signature(blocked, allowed)
  b = ts.access_control_signature(list(reversed(blocked)), list(reversed(allowed)))
  assert_eq(a, b, "signature order-independent")
  assert_eq(len(a), 24, "signature length")


def test_unwrap_api_data() -> None:
  assert_eq(ts._unwrap_api_data({"success": True, "data": {"blocked": []}}), {"blocked": []}, "unwrap")
  assert_eq(ts._unwrap_api_data({"blocked": [1]}), {"blocked": [1]}, "passthrough")


def main() -> None:
  tests = [
    test_plan_blocks_overdue_in_active_group,
    test_plan_restores_paid_member_from_blocked_group,
    test_plan_skips_already_blocked,
    test_plan_reports_missing_blocked_uid,
    test_plan_does_not_touch_custom_group_on_allowed,
    test_signature_stable,
    test_unwrap_api_data,
  ]
  failed = 0
  for fn in tests:
    try:
      fn()
      print(f"PASS  {fn.__name__}")
    except Exception as e:
      failed += 1
      print(f"FAIL  {fn.__name__}: {e}")
  print(f"\n{len(tests) - failed}/{len(tests)} passed")
  raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
  main()
