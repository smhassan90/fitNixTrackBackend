/**
 * Production dry-run: exact payloads from termux_sync.py → backend resolve → gym display.
 * Manual check-in uses real UTC ISO; device must display the same wall clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDateTimeInGymTZ,
  formatTimeInGymTZ,
  resolveOfflineDevicePunchInstant,
} from './dateHelpers';

const KARACHI = 'Asia/Karachi';

/** Mirror termux localize: naive device clock = gym wall clock. */
function termuxAwareEpochSec(wallHour: number, wallMin: number, day = 9, monthIndex = 7, year = 2026): number {
  // Asia/Karachi is UTC+5 year-round (no DST)
  return Math.floor(Date.UTC(year, monthIndex, day, wallHour - 5, wallMin, 0) / 1000);
}

/** OLD termux_sync punch_to_iso (fake Z) — still on many client devices until script updated. */
function oldTermuxRecordTime(wallHour: number, wallMin: number, day = 9): string {
  const hh = String(wallHour).padStart(2, '0');
  const mm = String(wallMin).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `2026-08-${dd}T${hh}:${mm}:00.000Z`;
}

/** NEW termux_sync punch_to_iso (real offset). */
function newTermuxRecordTime(wallHour: number, wallMin: number, day = 9): string {
  const hh = String(wallHour).padStart(2, '0');
  const mm = String(wallMin).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `2026-08-${dd}T${hh}:${mm}:00+05:00`;
}

/** Manual portal check-in: browser Instant for the same wall clock in Karachi. */
function manualCheckInIso(wallHour: number, wallMin: number, day = 9): string {
  return new Date(termuxAwareEpochSec(wallHour, wallMin, day) * 1000).toISOString();
}

function assertSameWallClock(
  label: string,
  deviceParsed: Date,
  manualIso: string,
  expectedTime: string
) {
  const manual = new Date(manualIso);
  assert.equal(
    formatTimeInGymTZ(deviceParsed, KARACHI),
    expectedTime,
    `${label}: device display`
  );
  assert.equal(
    formatTimeInGymTZ(manual, KARACHI),
    expectedTime,
    `${label}: manual display`
  );
  assert.equal(
    deviceParsed.getTime(),
    manual.getTime(),
    `${label}: stored instant must match manual check-in`
  );
}

test('CRITICAL: old termux fake-Z payload still correct via timestamp preference', () => {
  // Member punches at 2:22 PM device clock (Pakistan)
  const wallH = 14;
  const wallM = 22;
  const payload = {
    recordTime: oldTermuxRecordTime(wallH, wallM), // "2026-08-09T14:22:00.000Z" FAKE
    timestamp: termuxAwareEpochSec(wallH, wallM), // real epoch
  };

  // Bug without fix: trusting recordTime Z → 7:22 PM
  const brokenIfTrustedZ = new Date(payload.recordTime);
  assert.equal(formatTimeInGymTZ(brokenIfTrustedZ, KARACHI), '07:22 PM', 'precondition: fake Z causes +5h');

  const parsed = resolveOfflineDevicePunchInstant(payload, KARACHI, 'gym_local');
  assert.ok(parsed);
  assertSameWallClock(
    'old termux',
    parsed!,
    manualCheckInIso(wallH, wallM),
    '02:22 PM'
  );
});

test('CRITICAL: new termux +05:00 payload matches manual', () => {
  const wallH = 9;
  const wallM = 5;
  const payload = {
    recordTime: newTermuxRecordTime(wallH, wallM),
    timestamp: termuxAwareEpochSec(wallH, wallM),
  };
  const parsed = resolveOfflineDevicePunchInstant(payload, KARACHI, 'gym_local');
  assert.ok(parsed);
  assertSameWallClock('new termux', parsed!, manualCheckInIso(wallH, wallM), '09:05 AM');
});

test('CRITICAL: timestamp-only payload (no recordTime) matches manual', () => {
  const wallH = 18;
  const wallM = 0;
  const parsed = resolveOfflineDevicePunchInstant(
    { timestamp: termuxAwareEpochSec(wallH, wallM) },
    KARACHI,
    'gym_local'
  );
  assert.ok(parsed);
  assertSameWallClock('timestamp only', parsed!, manualCheckInIso(wallH, wallM), '06:00 PM');
});

test('CRITICAL: recordTime-only fake Z still corrected by gym_local fallback', () => {
  // If an older client omitted timestamp, wall-clock mode must still work
  const wallH = 11;
  const wallM = 45;
  const parsed = resolveOfflineDevicePunchInstant(
    { recordTime: oldTermuxRecordTime(wallH, wallM) },
    KARACHI,
    'gym_local'
  );
  assert.ok(parsed);
  assertSameWallClock('recordTime only fake Z', parsed!, manualCheckInIso(wallH, wallM), '11:45 AM');
});

test('CRITICAL: recordTime-only +05:00 matches manual', () => {
  const wallH = 16;
  const wallM = 30;
  const parsed = resolveOfflineDevicePunchInstant(
    { recordTime: newTermuxRecordTime(wallH, wallM) },
    KARACHI,
    'gym_local'
  );
  assert.ok(parsed);
  assertSameWallClock('recordTime only +05:00', parsed!, manualCheckInIso(wallH, wallM), '04:30 PM');
});

test('CRITICAL: midnight and near-midnight boundary in Karachi', () => {
  for (const [h, m, label] of [
    [0, 0, '12:00 AM'],
    [0, 15, '12:15 AM'],
    [23, 59, '11:59 PM'],
  ] as const) {
    const parsed = resolveOfflineDevicePunchInstant(
      {
        recordTime: oldTermuxRecordTime(h, m),
        timestamp: termuxAwareEpochSec(h, m),
      },
      KARACHI,
      'gym_local'
    );
    assert.ok(parsed, label);
    assert.equal(formatTimeInGymTZ(parsed!, KARACHI), label);
    assert.equal(parsed!.getTime(), new Date(manualCheckInIso(h, m)).getTime());
  }
});

test('CRITICAL: attendance list display field (formatDateTimeInGymTZ) not +5h', () => {
  const wallH = 13;
  const wallM = 10;
  const parsed = resolveOfflineDevicePunchInstant(
    {
      recordTime: oldTermuxRecordTime(wallH, wallM),
      timestamp: termuxAwareEpochSec(wallH, wallM),
    },
    KARACHI,
    'gym_local'
  )!;
  const checkIn = formatDateTimeInGymTZ(parsed, {}, KARACHI);
  assert.match(checkIn, /1:10\s*PM/i);
  assert.doesNotMatch(checkIn, /6:10\s*PM/i);
  assert.equal(formatTimeInGymTZ(parsed, KARACHI), '01:10 PM');
});

test('CRITICAL: several wall clocks across the day (device == manual)', () => {
  const samples = [
    [7, 0, '07:00 AM'],
    [8, 30, '08:30 AM'],
    [12, 0, '12:00 PM'],
    [15, 45, '03:45 PM'],
    [21, 20, '09:20 PM'],
  ] as const;

  for (const [h, m, expected] of samples) {
    const oldPayload = {
      recordTime: oldTermuxRecordTime(h, m),
      timestamp: termuxAwareEpochSec(h, m),
    };
    const newPayload = {
      recordTime: newTermuxRecordTime(h, m),
      timestamp: termuxAwareEpochSec(h, m),
    };
    const fromOld = resolveOfflineDevicePunchInstant(oldPayload, KARACHI, 'gym_local')!;
    const fromNew = resolveOfflineDevicePunchInstant(newPayload, KARACHI, 'gym_local')!;
    const manual = new Date(manualCheckInIso(h, m));

    assert.equal(formatTimeInGymTZ(fromOld, KARACHI), expected, `old script ${expected}`);
    assert.equal(formatTimeInGymTZ(fromNew, KARACHI), expected, `new script ${expected}`);
    assert.equal(fromOld.getTime(), manual.getTime(), `old==manual ${expected}`);
    assert.equal(fromNew.getTime(), manual.getTime(), `new==manual ${expected}`);
  }
});
