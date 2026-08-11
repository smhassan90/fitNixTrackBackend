#!/usr/bin/env python3
"""
FitNix Termux sync daemon — mirrors Android app AttendanceSyncService + SyncRepository logic.

Pulls users + attendance from ZKTeco (pyzk), uploads to FitNix backend (API key mode).
Keeps local dedup cache + pending queue in a JSON state file (like Room DB on the app).

Usage:
  python termux_sync.py                  # run forever
  python termux_sync.py --once           # single cycle (test)
  python termux_sync.py --reset          # clear cache, full historical resync

Edit USER SETTINGS below (no properties file needed).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
  from zk import ZK
except ImportError:
  print("Missing pyzk. Install: pip install pyzk", file=sys.stderr)
  sys.exit(1)

# Enables ZoneInfo("Asia/Karachi") on Termux when system tzdata is missing.
try:
  import tzdata  # noqa: F401
except ImportError:
  pass

# --- constants (match Android app) ---
BULK_UPLOAD_BATCH = 25
NORMAL_UPLOAD_BATCH = 25
FAST_POLL_SEC = 0.3
USER_SYNC_MIN_INTERVAL_SEC = 10 * 60
USER_SYNC_429_BACKOFF_SEC = 30 * 60
ATTENDANCE_429_BACKOFF_SEC = 60
TCP_RECONNECT_COOLDOWN_SEC = 60
POST_DISCONNECT_SEC = 0.3
BUFFER_READ_RETRIES = 3
READ_RETRY_DELAY_SEC = 0.25
MAX_CONSECUTIVE_DEVICE_ERRORS = 10
DEVICE_ERROR_BACKOFF_BASE_SEC = 3.0
DEVICE_ERROR_BACKOFF_MAX_SEC = 60.0
EPOCH_SYNC_AT = "1970-01-01T00:00:00.000Z"
SCRIPT_VERSION = "1.8.0"  # Overdue access control via Access Groups
ACCESS_CONTROL_MIN_INTERVAL_SEC = 5 * 60

# =============================================================================
# USER SETTINGS — edit these values on the tablet (only place to change config)
# =============================================================================
BACKEND_URL = "https://fitnixtrackbackend.vercel.app"
DEVICE_ID = 3
API_KEY = "fnx_3_Q0XJi0Ad6x0uqOLMcd-3-NX8VZ1fNARq"

DEVICE_IP = "192.168.100.201"
DEVICE_PORT = 4370

SYNC_INTERVAL_SEC = 600.0        # seconds between polls when idle (10 minutes)
CONNECTION_TIMEOUT_SEC = 30      # device read timeout (seconds)
PREFER_UDP = False               # False = TCP (stable on tablet)

# IANA timezone for punch times (Pakistan). Fallback to UTC+5 if tzdata missing on Termux.
DEVICE_TIMEZONE = "Asia/Karachi"

# Overdue / inactive members → move to blocked Access Group (templates stay on device).
# Device setup (once): Access Control → create Group 2 with NO valid time periods;
# keep Group 1 as full-day access for paid members. Then enable below.
ACCESS_CONTROL_ENABLED = True
ACTIVE_ACCESS_GROUP = "1"
BLOCKED_ACCESS_GROUP = "2"
ACCESS_CONTROL_INTERVAL_SEC = 300.0  # how often to reconcile groups (5 min)
# =============================================================================

LOG = logging.getLogger("fitnix-termux")


@dataclass
class Config:
    backend_url: str
    device_id: int
    api_key: str
    device_ip: str
    device_port: int = 4370
    sync_interval_sec: float = 1.0
    connection_timeout_sec: int = 15
    prefer_udp: bool = True
    device_timezone: str = ""
    device_tz: timezone | ZoneInfo = field(default_factory=lambda: timezone.utc)
    access_control_enabled: bool = True
    active_access_group: str = "1"
    blocked_access_group: str = "2"
    access_control_interval_sec: float = 300.0


@dataclass
class SyncState:
  synced_keys: set[str] = field(default_factory=set)
  pending_logs: list[dict] = field(default_factory=list)
  last_sync_at: str = EPOCH_SYNC_AT
  pending_full_resync: bool = False
  user_signature: str | None = None
  last_user_sync_attempt: float = 0.0
  user_sync_backoff_until: float = 0.0
  attendance_429_backoff_until: float = 0.0
  preferred_udp: bool | None = None
  session_synced: int = 0
  session_errors: int = 0
  consecutive_device_errors: int = 0
  device_error_backoff_until: float = 0.0
  last_access_sync_at: float = 0.0
  access_signature: str | None = None
  access_blocked_uids: list[str] = field(default_factory=list)

  def save(self, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
      "synced_keys": sorted(self.synced_keys),
      "pending_logs": self.pending_logs,
      "last_sync_at": self.last_sync_at,
      "pending_full_resync": self.pending_full_resync,
      "user_signature": self.user_signature,
      "last_user_sync_attempt": self.last_user_sync_attempt,
      "user_sync_backoff_until": self.user_sync_backoff_until,
      "attendance_429_backoff_until": self.attendance_429_backoff_until,
      "preferred_udp": self.preferred_udp,
      "session_synced": self.session_synced,
      "session_errors": self.session_errors,
      "consecutive_device_errors": self.consecutive_device_errors,
      "device_error_backoff_until": self.device_error_backoff_until,
      "last_access_sync_at": self.last_access_sync_at,
      "access_signature": self.access_signature,
      "access_blocked_uids": self.access_blocked_uids,
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(path)

  @classmethod
  def load(cls, path: Path) -> SyncState:
    if not path.exists():
      return cls()
    data = json.loads(path.read_text(encoding="utf-8"))
    return cls(
      synced_keys=set(data.get("synced_keys", [])),
      pending_logs=list(data.get("pending_logs", [])),
      last_sync_at=data.get("last_sync_at", EPOCH_SYNC_AT),
      pending_full_resync=bool(data.get("pending_full_resync", False)),
      user_signature=data.get("user_signature"),
      last_user_sync_attempt=float(data.get("last_user_sync_attempt", 0)),
      user_sync_backoff_until=float(data.get("user_sync_backoff_until", 0)),
      attendance_429_backoff_until=float(data.get("attendance_429_backoff_until", 0)),
      preferred_udp=data.get("preferred_udp"),
      session_synced=int(data.get("session_synced", 0)),
      session_errors=int(data.get("session_errors", 0)),
      consecutive_device_errors=int(data.get("consecutive_device_errors", 0)),
      device_error_backoff_until=float(data.get("device_error_backoff_until", 0)),
      last_access_sync_at=float(data.get("last_access_sync_at", 0)),
      access_signature=data.get("access_signature"),
      access_blocked_uids=list(data.get("access_blocked_uids", [])),
    )


def load_config() -> Config:
  """Build config from USER SETTINGS at top of this file."""
  missing = []
  if not BACKEND_URL.strip():
    missing.append("BACKEND_URL")
  if not API_KEY.strip():
    missing.append("API_KEY")
  if not DEVICE_IP.strip():
    missing.append("DEVICE_IP")
  if missing:
    raise SystemExit(f"Missing USER SETTINGS: {', '.join(missing)} — edit top of termux_sync.py")

  device_tz, tz_label = parse_device_timezone(DEVICE_TIMEZONE)

  return Config(
    backend_url=BACKEND_URL.strip().rstrip("/"),
    device_id=int(DEVICE_ID),
    api_key=API_KEY.strip(),
    device_ip=DEVICE_IP.strip(),
    device_port=max(1, int(DEVICE_PORT)),
    sync_interval_sec=max(0.3, float(SYNC_INTERVAL_SEC)),
    connection_timeout_sec=max(5, int(CONNECTION_TIMEOUT_SEC)),
    prefer_udp=bool(PREFER_UDP),
    device_timezone=tz_label,
    device_tz=device_tz,
    access_control_enabled=bool(ACCESS_CONTROL_ENABLED),
    active_access_group=str(ACTIVE_ACCESS_GROUP).strip() or "1",
    blocked_access_group=str(BLOCKED_ACCESS_GROUP).strip() or "2",
    access_control_interval_sec=max(
      float(ACCESS_CONTROL_MIN_INTERVAL_SEC),
      float(ACCESS_CONTROL_INTERVAL_SEC),
    ),
  )


# IANA names → UTC offset when Termux has no tzdata package (pkg install tzdata)
_IANA_UTC_OFFSET_HOURS = {
  "asia/karachi": 5,
  "pakistan": 5,
  "asia/dubai": 4,
  "asia/kolkata": 5,
  "asia/colombo": 5,
}


def parse_device_timezone(raw: str) -> tuple[timezone | ZoneInfo, str]:
  """Resolve offset (+05:00) or IANA name; Termux-safe without tzdata."""
  value = raw.strip().replace(",", "/")
  if not value:
    system_tz = datetime.now().astimezone().tzinfo or timezone.utc
    label = getattr(system_tz, "key", None) or str(system_tz)
    return system_tz, label

  upper = value.upper()
  if upper in ("UTC", "Z"):
    return timezone.utc, "UTC"

  offset_match = re.fullmatch(r"(?:UTC)?([+-])(\d{1,2})(?::?(\d{2}))?", upper)
  if offset_match:
    sign, hours, minutes = offset_match.groups()
    total_minutes = int(hours) * 60 + int(minutes or 0)
    if total_minutes > 18 * 60:
      raise SystemExit(f"Invalid DEVICE_TIMEZONE offset: {raw!r}")
    delta = timedelta(minutes=total_minutes)
    if sign == "-":
      delta = -delta
    tz = timezone(delta)
    return tz, f"UTC{sign}{hours}" + (f":{minutes}" if minutes else "")

  try:
    tz = ZoneInfo(value)
    return tz, value
  except Exception:
    hours = _IANA_UTC_OFFSET_HOURS.get(value.lower())
    if hours is not None:
      LOG.info(
        "tzdata missing for %s — using fixed UTC+%s (pip install tzdata or pkg install tzdata)",
        value,
        hours,
      )
      return timezone(timedelta(hours=hours)), value
    raise SystemExit(
      f"Invalid DEVICE_TIMEZONE {raw!r}. Use IANA name (Asia/Karachi) or offset (+05:00)."
    ) from None


def localize_device_time(dt: datetime, device_tz: timezone | ZoneInfo) -> datetime:
  if dt.tzinfo is None:
    return dt.replace(tzinfo=device_tz)
  return dt.astimezone(device_tz)


def sanitize_enrollment_id(value: str) -> str:
  """Match Android ZkStringDecoder.sanitizeEnrollmentId — digits-only badge IDs."""
  digits = "".join(c for c in value if c.isdigit())
  if digits:
    return digits
  return "".join(c for c in value if 32 <= ord(c) <= 126).strip()


def resolve_device_user_id(punch, users: list) -> str:
  """Map internal uid to enrollment badge ID — mirrors AttendanceUserMapper."""
  by_uid = {u.uid: u for u in users}
  uid = getattr(punch, "uid", None)

  if uid is not None and uid in by_uid:
    clean = sanitize_enrollment_id(str(by_uid[uid].user_id))
    if clean:
      return clean

  cleaned = sanitize_enrollment_id(str(punch.user_id))
  if cleaned:
    if any(sanitize_enrollment_id(str(u.user_id)) == cleaned for u in users):
      return cleaned
    if cleaned.isdigit():
      return cleaned
    if uid is not None and cleaned != str(uid):
      return cleaned

  if uid is not None:
    return str(uid)
  return cleaned or str(punch.user_id)


def dedup_key(device_user_id: str, record_time: str, punch_type: int, state: int) -> str:
  """Match Android DedupUtils — includes punch type."""
  return f"{device_user_id}_{record_time}_{punch_type or state or 0}"


def punch_to_iso(dt: datetime, device_tz: timezone | ZoneInfo) -> str:
  """ISO-8601 with real offset (e.g. +05:00). Do NOT append fake Z — that made backend store +5h."""
  local = localize_device_time(dt, device_tz)
  # timespec=seconds keeps payloads small; include offset from tz-aware datetime
  return local.isoformat(timespec="seconds")


def user_list_signature(users: list) -> str:
  parts = sorted(f"{u.uid}:{u.user_id}:{u.name or ''}" for u in users)
  return hashlib.md5("|".join(parts).encode()).hexdigest()


def attendance_to_dto(punch, device_tz: timezone | ZoneInfo, users: list | None = None) -> dict:
  punch_type = punch.punch if punch.punch is not None else 0
  state = punch.status if punch.status is not None else 0
  aware = localize_device_time(punch.timestamp, device_tz)
  record_time = punch_to_iso(aware, device_tz)
  raw_id = str(punch.user_id)
  device_user_id = resolve_device_user_id(punch, users or [])
  if device_user_id != raw_id:
    LOG.info(
      "Remapped punch uid=%s device id %s -> enrollment %s",
      getattr(punch, "uid", "?"),
      raw_id,
      device_user_id,
    )
  return {
    "deviceUserId": device_user_id,
    "recordTime": record_time,
    "type": punch_type,
    "state": state,
    "uid": getattr(punch, "uid", None),
    "timestamp": int(aware.timestamp()),
    "_dedup": dedup_key(device_user_id, record_time, punch_type, state),
  }


def user_to_dto(user) -> dict:
  enrollment = str(user.user_id).strip()
  name = (user.name or f"NN-{enrollment}").strip()
  return {
    "uid": user.uid,
    "name": name,
    "deviceUserName": name,
    "userId": enrollment,
    "privilege": user.privilege,
    "password": "",
    "groupId": str(user.group_id),
    "card": user.card or 0,
  }


def http_post(cfg: Config, path: str, body: dict) -> tuple[int, dict]:
  url = f"{cfg.backend_url}{path}"
  data = json.dumps(body).encode("utf-8")
  req = urllib.request.Request(url, data=data, method="POST")
  req.add_header("Content-Type", "application/json")
  req.add_header("X-Api-Key", cfg.api_key)
  try:
    with urllib.request.urlopen(req, timeout=60) as resp:
      raw = resp.read().decode("utf-8")
      return resp.status, json.loads(raw) if raw else {}
  except urllib.error.HTTPError as e:
    raw = e.read().decode("utf-8", errors="replace")
    try:
      body_json = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
      body_json = {"error": {"message": raw}}
    return e.code, body_json


def is_transient_device_error(exc: BaseException) -> bool:
  msg = str(exc).lower()
  return any(
    token in msg
    for token in (
      "unpack",
      "buffer",
      "timeout",
      "timed out",
      "broken pipe",
      "connection reset",
      "connection refused",
      "errno",
      "not enough data",
    )
  )


def record_device_failure(state: SyncState) -> float:
  state.consecutive_device_errors = min(
    state.consecutive_device_errors + 1,
    MAX_CONSECUTIVE_DEVICE_ERRORS,
  )
  delay = min(
    DEVICE_ERROR_BACKOFF_MAX_SEC,
    DEVICE_ERROR_BACKOFF_BASE_SEC * state.consecutive_device_errors,
  )
  state.device_error_backoff_until = time.time() + delay
  LOG.warning(
    "Device error #%s — backing off %.0fs before next pull",
    state.consecutive_device_errors,
    delay,
  )
  return delay


def record_device_success(state: SyncState) -> None:
  if state.consecutive_device_errors > 0:
    LOG.info("Device pull recovered after %s error(s)", state.consecutive_device_errors)
  state.consecutive_device_errors = 0
  state.device_error_backoff_until = 0.0


class DeviceSession:
  """Long-lived ZKTeco session — UDP first, TCP fallback (like Android)."""

  def __init__(self, cfg: Config, state: SyncState):
    self.cfg = cfg
    self.state = state
    self.conn = None
    self.use_udp = True
    self._last_tcp_attempt = 0.0
    self.device_record_count = 0
    self.device_user_count = 0
    self.last_users: list = []
    self._users_stale = False

  def connect(self, load_users: bool = False) -> bool:
    self.disconnect()
    time.sleep(POST_DISCONNECT_SEC)
    transports = [True, False] if self.state.preferred_udp is not False else [False, True]
    if not self.cfg.prefer_udp:
      transports = [False, True]

    for use_udp in transports:
      try:
        zk = ZK(
          self.cfg.device_ip,
          port=self.cfg.device_port,
          timeout=self.cfg.connection_timeout_sec,
          force_udp=use_udp,
          ommit_ping=False,
        )
        conn = zk.connect()
        conn.read_sizes()
        self.conn = conn
        self.use_udp = use_udp
        self.state.preferred_udp = use_udp
        self._sync_counts_from_conn()
        transport = "UDP" if use_udp else "TCP"
        LOG.info(
          "Device connected via %s: %s:%s (users=%s records=%s)",
          transport,
          self.cfg.device_ip,
          self.cfg.device_port,
          self.device_user_count,
          self.device_record_count,
        )
        if load_users:
          self._refresh_user_cache(force=True)
        return True
      except Exception as e:
        LOG.warning("Connect %s failed: %s", "UDP" if use_udp else "TCP", e)
    return False

  def disconnect(self) -> None:
    if self.conn:
      try:
        self.conn.disconnect()
      except Exception:
        pass
      self.conn = None

  def _sync_counts_from_conn(self) -> None:
    if not self.conn:
      return
    try:
      self.device_user_count = int(getattr(self.conn, "users", 0) or 0)
      self.device_record_count = int(getattr(self.conn, "records", 0) or 0)
    except (TypeError, ValueError):
      pass

  def _free_data(self) -> None:
    if not self.conn:
      return
    for name in ("free_data", "freeData"):
      fn = getattr(self.conn, name, None)
      if callable(fn):
        try:
          fn()
        except Exception:
          pass
        return

  def _recover_session(self, reason: str) -> bool:
    LOG.warning("Recovering device session: %s", reason)
    self._free_data()
    self.disconnect()
    time.sleep(POST_DISCONNECT_SEC)
    return self.connect(load_users=False)

  def _refresh_user_cache(self, force: bool = False) -> list:
    """Optional explicit user read — avoid on normal connect/recover (slow on tablet)."""
    if not self.conn:
      return self.last_users
    count_mismatch = self.device_user_count > 0 and len(self.last_users) != self.device_user_count
    if not force and not count_mismatch:
      return self.last_users
    try:
      users = list(self.conn.get_users() or [])
      if users:
        self.last_users = users
        LOG.info("User cache refreshed: %s users", len(users))
    except Exception as e:
      LOG.warning("User cache refresh failed (non-fatal): %s", e)
    return self.last_users

  def pull(self) -> tuple[list, list]:
    """Returns (users, attendance). Mirrors Android: retry buffer, reconnect, TCP."""
    now = time.time()
    if now < self.state.device_error_backoff_until:
      remaining = int(self.state.device_error_backoff_until - now)
      LOG.debug("Device in backoff (%ss left) — skipping pull", remaining)
      return self.last_users, []

    if not self.conn and not self.connect(load_users=False):
      record_device_failure(self.state)
      return self.last_users, []

    attendance = self._pull_once()
    expected = self.device_record_count

    if not attendance and expected > 0:
      LOG.warning("Read 0/%s punches — reconnecting session", expected)
      if self._recover_session("empty attendance read"):
        attendance = self._pull_once()
        expected = self.device_record_count

    if not attendance and expected > 0 and self.use_udp:
      attendance = self._try_tcp_fallback(force=True)

    if not attendance and expected > 0 and not self.use_udp:
      attendance = self._try_tcp_fallback(force=True)

    if attendance:
      record_device_success(self.state)
      if len(attendance) < expected:
        LOG.warning("Partial read %s/%s punches", len(attendance), expected)
      else:
        LOG.info(
          "OK: %s/%s punches, %s cached users (%s)",
          len(attendance),
          expected,
          len(self.last_users),
          "UDP" if self.use_udp else "TCP",
        )
    elif expected > 0:
      record_device_failure(self.state)
      LOG.warning(
        "Could not read punches (device reports %s) — will retry after backoff",
        expected,
      )

    return self.last_users, attendance

  def set_user_access_group(self, user, group_id: str, *, lock_device: bool = True) -> bool:
    """Update Access Group only — keeps face/finger templates on the device."""
    if not self.conn and not self.connect(load_users=False):
      return False
    assert self.conn is not None
    target = str(group_id).strip()
    current = str(getattr(user, "group_id", "") or "").strip()
    if current == target:
      return False
    try:
      was_enabled = bool(getattr(self.conn, "is_enabled", True))
      if lock_device and was_enabled:
        self.conn.disable_device()
      self.conn.set_user(
        uid=user.uid,
        name=user.name or "",
        privilege=int(getattr(user, "privilege", 0) or 0),
        password=getattr(user, "password", "") or "",
        group_id=target,
        user_id=str(user.user_id),
        card=int(getattr(user, "card", 0) or 0),
      )
      if lock_device:
        if hasattr(self.conn, "refresh_data"):
          try:
            self.conn.refresh_data()
          except Exception:
            pass
        if was_enabled:
          self.conn.enable_device()
      user.group_id = target
      LOG.info(
        "Access group uid=%s userId=%s %s -> %s (%s)",
        user.uid,
        user.user_id,
        current or "(empty)",
        target,
        user.name or "",
      )
      return True
    except Exception as e:
      LOG.error("Failed to set access group for uid=%s: %s", user.uid, e)
      if lock_device:
        try:
          self.conn.enable_device()
        except Exception:
          pass
      return False

  def apply_access_group_updates(self, updates: list[tuple[Any, str]]) -> int:
    """Apply many group changes under one disable/enable cycle."""
    if not updates:
      return 0
    if not self.conn and not self.connect(load_users=False):
      return 0
    assert self.conn is not None
    changed = 0
    was_enabled = bool(getattr(self.conn, "is_enabled", True))
    try:
      if was_enabled:
        self.conn.disable_device()
      for user, group_id in updates:
        if self.set_user_access_group(user, group_id, lock_device=False):
          changed += 1
      if hasattr(self.conn, "refresh_data"):
        try:
          self.conn.refresh_data()
        except Exception:
          pass
    finally:
      if was_enabled:
        try:
          self.conn.enable_device()
        except Exception:
          pass
    return changed

  def _try_tcp_fallback(self, force: bool = False) -> list:
    if not self.use_udp:
      if not force and time.time() - self._last_tcp_attempt < TCP_RECONNECT_COOLDOWN_SEC:
        return []
      self._last_tcp_attempt = time.time()
      LOG.info("TCP session empty — reconnecting and re-reading")
      if self._recover_session("TCP still returning 0 punches"):
        return self._pull_once()
      return []

    if not force and time.time() - self._last_tcp_attempt < TCP_RECONNECT_COOLDOWN_SEC:
      return []

    self._last_tcp_attempt = time.time()
    LOG.info("UDP read empty — switching to TCP")
    self.disconnect()
    time.sleep(POST_DISCONNECT_SEC)
    try:
      zk = ZK(
        self.cfg.device_ip,
        port=self.cfg.device_port,
        timeout=self.cfg.connection_timeout_sec,
        force_udp=False,
        ommit_ping=False,
      )
      self.conn = zk.connect()
      self.use_udp = False
      self.state.preferred_udp = False
      self.conn.read_sizes()
      self._sync_counts_from_conn()
      attendance = self._pull_once()
      if attendance:
        LOG.info("TCP read OK: %s/%s punches", len(attendance), self.device_record_count)
      return attendance
    except Exception as e:
      LOG.error("TCP fallback failed: %s", e)
      self.disconnect()
      return []

  def _pull_once(self) -> list:
    """get_attendance with free_data retries (like Android buffer read loop)."""
    for attempt in range(BUFFER_READ_RETRIES):
      attendance = self._read_attendance_once()
      expected = self.device_record_count
      if attendance or expected == 0:
        return attendance
      if attempt < BUFFER_READ_RETRIES - 1:
        LOG.debug(
          "Attendance buffer empty (device reports %s) — buffer retry %s/%s",
          expected,
          attempt + 2,
          BUFFER_READ_RETRIES,
        )
        self._free_data()
        time.sleep(READ_RETRY_DELAY_SEC)
    return []

  def _read_attendance_once(self) -> list:
    """Single pyzk get_attendance(); capture users from its internal get_users call."""
    if not self.conn:
      return []
    conn = self.conn
    captured: list = []
    original_get_users = conn.get_users

    def capturing_get_users():
      users = original_get_users()
      if users:
        captured[:] = list(users)
      return users

    conn.get_users = capturing_get_users
    try:
      attendance = list(conn.get_attendance() or [])
      self._sync_counts_from_conn()
      if captured:
        self.last_users = captured
      return attendance
    except Exception as e:
      LOG.error("Device pull error: %s", e)
      self.disconnect()
      return []
    finally:
      if self.conn is conn:
        conn.get_users = original_get_users


def should_upload_users(state: SyncState, users: list, device_reported: int) -> bool:
  now = time.time()
  if now < state.user_sync_backoff_until:
    return False
  if not users:
    return device_reported > 0
  sig = user_list_signature(users)
  list_changed = sig != state.user_signature
  first_upload = state.user_signature is None
  count_gap = len(users) < device_reported
  if not list_changed and not first_upload and not count_gap:
    return False
  if not first_upload and not list_changed and now - state.last_user_sync_attempt < USER_SYNC_MIN_INTERVAL_SEC:
    return False
  return True


def sync_users(cfg: Config, state: SyncState, users: list, device_reported: int = 0) -> None:
  if not users:
    return
  reported = device_reported or len(users)
  if not should_upload_users(state, users, reported):
    LOG.debug("Users unchanged (%s), skipping backend sync", len(users))
    return

  state.last_user_sync_attempt = time.time()
  dtos = [user_to_dto(u) for u in users]
  code, body = http_post(
    cfg,
    f"/api/device/{cfg.device_id}/sync-users-offline",
    {"apiKey": cfg.api_key, "users": dtos},
  )
  if 200 <= code < 300 and body.get("success"):
    data = body.get("data", {})
    state.user_signature = user_list_signature(users)
    LOG.info(
      "Users uploaded: %s stored, %s unmapped — %s",
      data.get("stored"),
      data.get("unmappedCount"),
      data.get("message", ""),
    )
    return

  if code == 429:
    state.user_sync_backoff_until = time.time() + USER_SYNC_429_BACKOFF_SEC
    LOG.warning("User sync rate-limited (429) — retry in 30min")
  else:
    msg = body.get("error", {}).get("message", f"HTTP {code}")
    LOG.error("User sync failed: %s", msg)


def _unwrap_api_data(body: dict) -> dict:
  data = body.get("data")
  return data if isinstance(data, dict) else body


def access_control_signature(blocked: list[dict], allowed: list[dict]) -> str:
  blocked_part = ",".join(
    sorted(f"{b.get('deviceUserId')}:{b.get('reason')}" for b in blocked)
  )
  allowed_part = ",".join(sorted(str(a.get("deviceUserId")) for a in allowed))
  raw = f"b={blocked_part}|a={allowed_part}"
  return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def plan_access_group_updates(
  device_users: list,
  blocked: list[dict],
  allowed: list[dict],
  active_group: str,
  blocked_group: str,
) -> tuple[list[tuple[Any, str, str, str]], list[str]]:
  """
  Pure planner: returns (updates, missing_blocked_uids).
  Each update is (user, target_group, current_group, action) where action is
  'block' or 'restore'.
  """
  active = str(active_group).strip() or "1"
  blocked_g = str(blocked_group).strip() or "2"
  by_uid = {str(u.uid): u for u in device_users}
  updates: list[tuple[Any, str, str, str]] = []
  missing: list[str] = []

  for entry in blocked:
    uid = str(entry.get("deviceUserId") or "").strip()
    user = by_uid.get(uid)
    if not user:
      missing.append(uid)
      continue
    current = str(getattr(user, "group_id", "") or "").strip()
    if current != blocked_g:
      updates.append((user, blocked_g, current, "block"))

  for entry in allowed:
    uid = str(entry.get("deviceUserId") or "").strip()
    user = by_uid.get(uid)
    if not user:
      continue
    current = str(getattr(user, "group_id", "") or "").strip()
    if current == blocked_g:
      updates.append((user, active, current, "restore"))

  return updates, missing


def fetch_access_control(cfg: Config) -> dict | None:
  code, body = http_post(
    cfg,
    f"/api/device/{cfg.device_id}/access-control-offline",
    {
      "apiKey": cfg.api_key,
      "activeGroup": cfg.active_access_group,
      "blockedGroup": cfg.blocked_access_group,
    },
  )
  if not (200 <= code < 300 and body.get("success")):
    msg = body.get("error", {}).get("message", f"HTTP {code}")
    LOG.error("Access control fetch failed: %s", msg)
    if body.get("error"):
      LOG.error("Access control error details: %s", body.get("error"))
    return None
  return _unwrap_api_data(body)


def sync_access_control(
  cfg: Config,
  state: SyncState,
  device: DeviceSession,
  users: list | None = None,
  force: bool = False,
  dry_run: bool = False,
) -> int:
  """Move overdue/inactive mapped users to blocked Access Group; restore after payment."""
  if not cfg.access_control_enabled:
    LOG.info("Access control disabled in settings — skip")
    return 0

  now = time.time()
  if (
    not force
    and not dry_run
    and state.last_access_sync_at > 0
    and now - state.last_access_sync_at < cfg.access_control_interval_sec
  ):
    return 0

  payload = fetch_access_control(cfg)
  if payload is None:
    return 0

  blocked = list(payload.get("blocked") or [])
  allowed = list(payload.get("allowed") or [])
  groups = payload.get("groups") or {}
  active_group = str(groups.get("active") or cfg.active_access_group).strip() or "1"
  blocked_group = str(groups.get("blocked") or cfg.blocked_access_group).strip() or "2"

  sig = access_control_signature(blocked, allowed)
  device_users = users if users is not None else device.last_users
  if not device_users and not dry_run:
    device_users = device._refresh_user_cache(force=True)
  device_users = device_users or []

  planned, missing = plan_access_group_updates(
    device_users, blocked, allowed, active_group, blocked_group
  )

  for uid in missing:
    reason = next(
      (b.get("memberName") or b.get("reason") for b in blocked if str(b.get("deviceUserId")) == uid),
      "?",
    )
    LOG.warning("Blocked member uid=%s (%s) not found on device — skip", uid, reason)

  if dry_run:
    LOG.info(
      "DRY-RUN access control: backend blocked=%s allowed=%s; device users=%s; would change=%s; missing=%s",
      len(blocked),
      len(allowed),
      len(device_users),
      len(planned),
      len(missing),
    )
    for entry in blocked[:20]:
      LOG.info(
        "DRY-RUN backend BLOCK uid=%s member=%s reason=%s",
        entry.get("deviceUserId"),
        entry.get("memberName"),
        entry.get("reason"),
      )
    if len(blocked) > 20:
      LOG.info("DRY-RUN ... +%s more blocked", len(blocked) - 20)
    for user, target, current, action in planned:
      LOG.info(
        "DRY-RUN would %s uid=%s userId=%s name=%r group %s -> %s",
        action,
        user.uid,
        user.user_id,
        user.name or "",
        current or "(empty)",
        target,
      )
    if not planned:
      LOG.info("DRY-RUN: no group changes needed (or device users unavailable)")
    return len(planned)

  apply_pairs = [(user, target) for user, target, _current, _action in planned]
  changed = device.apply_access_group_updates(apply_pairs)

  state.last_access_sync_at = now
  state.access_signature = sig
  state.access_blocked_uids = [
    str(b.get("deviceUserId")) for b in blocked if b.get("deviceUserId") is not None
  ]
  LOG.info(
    "Access control: %s blocked, %s allowed, %s group change(s) (active=%s blocked=%s)",
    len(blocked),
    len(allowed),
    changed,
    active_group,
    blocked_group,
  )
  return changed


def prepare_upload_batch(
  state: SyncState,
  punches: list,
  device_tz: timezone | ZoneInfo,
  users: list | None = None,
) -> tuple[list[dict], list[dict]]:
  """Filter new punches, apply batch limits, merge pending — mirrors SyncRepository."""
  dtos = [attendance_to_dto(p, device_tz, users) for p in punches]
  new_dtos = [d for d in dtos if d["_dedup"] not in state.synced_keys]
  new_dtos.sort(key=lambda d: d["recordTime"])

  if state.pending_full_resync and not new_dtos and dtos:
    state.pending_full_resync = False
    LOG.info("Historical catch-up complete")

  batch_limit = BULK_UPLOAD_BATCH if state.pending_full_resync else NORMAL_UPLOAD_BATCH
  to_upload = new_dtos[:batch_limit] if len(new_dtos) > batch_limit else new_dtos

  if len(new_dtos) > len(to_upload):
    LOG.info(
      "Uploading %s of %s new punch(es) this cycle — rest will follow",
      len(to_upload),
      len(new_dtos),
    )

  # Merge pending retries
  seen = set()
  api_logs: list[dict] = []
  for d in state.pending_logs + to_upload:
    key = d["_dedup"]
    if key in seen:
      continue
    seen.add(key)
    api_logs.append(d)

  return api_logs, new_dtos


def handle_sync_response(state: SyncState, api_logs: list[dict], code: int, body: dict) -> int:
  """Apply Android handleSyncResponse logic. Returns delivered count."""
  if not (200 <= code < 300 and body.get("success")):
    state.pending_logs = _merge_pending(state.pending_logs, api_logs)
    state.session_errors += 1
    msg = body.get("error", {}).get("message", f"HTTP {code}")
    LOG.error("Attendance sync failed: %s", msg)
    return 0

  data = body.get("data", {})
  synced = int(data.get("synced") or 0)
  pending = int(data.get("pending") or 0)
  received = int(data.get("received") or 0) or len(api_logs)
  skipped = max(0, received - synced - pending)
  fully_accounted = received >= len(api_logs) and (synced + pending + skipped) >= received

  delivered = received
  if delivered > 0:
    state.last_sync_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

  if fully_accounted:
    keys = {d["_dedup"] for d in api_logs}
    state.synced_keys.update(keys)
    state.pending_logs = [p for p in state.pending_logs if p["_dedup"] not in keys]
  else:
    LOG.warning(
      "Partial backend accept: sent=%s received=%s synced=%s pending=%s — keeping for retry",
      len(api_logs),
      received,
      synced,
      pending,
    )
    state.pending_logs = _merge_pending(state.pending_logs, api_logs)

  state.session_synced += delivered
  LOG.info(
    "Backend OK: delivered=%s synced=%s pending=%s",
    delivered,
    synced,
    pending,
  )
  if pending > 0:
    ids = data.get("pendingDeviceUserIds") or []
    LOG.info("%s punch(es) awaiting member mapping on server: %s", pending, ", ".join(map(str, ids)))
  return delivered


def _merge_pending(existing: list[dict], new_logs: list[dict]) -> list[dict]:
  by_key = {d["_dedup"]: d for d in existing}
  for d in new_logs:
    by_key[d["_dedup"]] = d
  return list(by_key.values())


def sync_attendance(cfg: Config, state: SyncState, punches: list, users: list | None = None) -> int:
  if time.time() < state.attendance_429_backoff_until:
    LOG.debug("Attendance sync in 429 backoff")
    return 0

  api_logs, new_dtos = prepare_upload_batch(state, punches, cfg.device_tz, users)
  if not api_logs:
    if punches:
      cached = len(punches) - len(new_dtos)
      if cached > 0:
        LOG.info("%s punch(es) already in local cache", cached)
      else:
        LOG.info("No new punches to upload (%s on device)", len(punches))
    else:
      LOG.info("No punches read from device yet")
    return 0

  payload_logs = [{k: v for k, v in d.items() if not k.startswith("_")} for d in api_logs]
  LOG.info("Uploading %s punch(es) to FitNix", len(payload_logs))

  code, body = http_post(
    cfg,
    f"/api/device/{cfg.device_id}/sync-attendance-offline",
    {
      "apiKey": cfg.api_key,
      "lastSyncAt": state.last_sync_at or EPOCH_SYNC_AT,
      "logs": payload_logs,
    },
  )

  if code == 429:
    state.attendance_429_backoff_until = time.time() + ATTENDANCE_429_BACKOFF_SEC
    state.pending_logs = _merge_pending(state.pending_logs, api_logs)
    LOG.warning("Attendance rate-limited (429) — queued for retry")
    return 0

  return handle_sync_response(state, api_logs, code, body)


def run_cycle(cfg: Config, state: SyncState, device: DeviceSession) -> tuple[int, bool]:
  """One sync cycle. Returns (punches_read, had_activity)."""
  users, attendance = device.pull()

  if should_upload_users(state, users, device.device_user_count):
    sync_users(cfg, state, users, device.device_user_count)
  elif users:
    LOG.debug("Users unchanged (%s), skipping backend sync", len(users))

  delivered = sync_attendance(cfg, state, attendance, users)
  access_changed = sync_access_control(cfg, state, device, users)

  had_new = False
  if attendance:
    latest = max(attendance, key=lambda p: p.timestamp)
    latest_local = localize_device_time(latest.timestamp, cfg.device_tz)
    latest_key = f"{latest.user_id}_{int(latest_local.timestamp())}"
    prev = getattr(run_cycle, "_last_punch_key", None)
    if latest_key != prev:
      run_cycle._last_punch_key = latest_key
      had_new = True
      action = "checkout" if (latest.punch or 0) == 1 else "checkin"
      LOG.info(
        "Latest device punch: user %s %s at %s -> API %s",
        latest.user_id,
        action,
        latest_local.strftime("%Y-%m-%d %H:%M:%S"),
        punch_to_iso(latest.timestamp, cfg.device_tz),
      )

  return len(attendance), had_new or delivered > 0 or access_changed > 0


def main() -> None:
  parser = argparse.ArgumentParser(description="FitNix Termux sync daemon")
  parser.add_argument("--once", action="store_true", help="Run one cycle and exit")
  parser.add_argument(
    "--access-once",
    action="store_true",
    help="Only reconcile Access Groups for overdue/inactive members, then exit",
  )
  parser.add_argument(
    "--dry-run",
    action="store_true",
    help="With --access-once: fetch backend plan and log changes without writing to device",
  )
  parser.add_argument(
    "--with-device",
    action="store_true",
    help="With --dry-run: also connect to device to compute per-user group deltas",
  )
  parser.add_argument("--reset", action="store_true", help="Clear local cache and full resync")
  parser.add_argument("--state", type=Path, help="State file path (default: ./termux_sync_state.json)")
  parser.add_argument("--version", action="version", version=f"%(prog)s {SCRIPT_VERSION}")
  args = parser.parse_args()

  script_dir = Path(__file__).resolve().parent
  state_path = args.state or script_dir / "termux_sync_state.json"
  log_path = script_dir / "termux_sync.log"

  logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
      logging.StreamHandler(sys.stdout),
      logging.FileHandler(log_path, encoding="utf-8"),
    ],
  )

  cfg = load_config()
  LOG.info("Config: hardcoded USER SETTINGS in %s", Path(__file__).name)
  state = SyncState.load(state_path)

  if args.reset:
    state = SyncState(pending_full_resync=True)
    state.save(state_path)
    LOG.info("Cache cleared — full historical resync enabled")

  device = DeviceSession(cfg, state)
  transport = "UDP" if cfg.prefer_udp and state.preferred_udp is not False else "TCP"
  LOG.info(
    "FitNix Termux sync v%s — %s %s:%s -> %s (interval %.1fs, timeout %ss, tz=%s, access=%s groups %s/%s)",
    SCRIPT_VERSION,
    transport,
    cfg.device_ip,
    cfg.device_port,
    cfg.backend_url,
    cfg.sync_interval_sec,
    cfg.connection_timeout_sec,
    cfg.device_timezone,
    "on" if cfg.access_control_enabled else "off",
    cfg.active_access_group,
    cfg.blocked_access_group,
  )

  if args.access_once:
    try:
      if args.dry_run:
        LOG.info("Access-once DRY-RUN — will not write to device")
        users: list = []
        # Optional live snapshot; skip long timeouts unless --with-device is set.
        if getattr(args, "with_device", False):
          if device.connect(load_users=True):
            users = list(device.last_users)
            LOG.info("Connected for dry-run user snapshot: %s users", len(users))
          else:
            LOG.warning(
              "Device unreachable — dry-run will only show backend blocked/allowed counts"
            )
        else:
          LOG.info("Dry-run without device connect (pass --with-device to include group deltas)")
        changed = sync_access_control(
          cfg, state, device, users, force=True, dry_run=True
        )
        LOG.info("Access-once dry-run done (would change %s)", changed)
      else:
        if not device.connect(load_users=True):
          LOG.error("Could not connect to device for access-control sync")
          sys.exit(1)
        changed = sync_access_control(cfg, state, device, device.last_users, force=True)
        state.save(state_path)
        LOG.info("Access-once done (%s change(s))", changed)
    finally:
      device.disconnect()
      if not args.dry_run:
        state.save(state_path)
    return

  try:
    while True:
      try:
        count, fast = run_cycle(cfg, state, device)
        state.save(state_path)
      except Exception as e:
        LOG.exception("Sync cycle error: %s", e)
        device.disconnect()
        state.session_errors += 1
        state.save(state_path)

      if args.once:
        break

      had_backoff = time.time() < state.device_error_backoff_until
      if had_backoff:
        sleep_sec = max(1.0, state.device_error_backoff_until - time.time())
      elif state.consecutive_device_errors == 0 and (fast or state.pending_full_resync):
        sleep_sec = FAST_POLL_SEC
      else:
        sleep_sec = cfg.sync_interval_sec
      time.sleep(sleep_sec)
  except KeyboardInterrupt:
    LOG.info("Stopped by user")
  finally:
    device.disconnect()
    state.save(state_path)
    LOG.info("Session synced=%s errors=%s", state.session_synced, state.session_errors)


if __name__ == "__main__":
  main()
