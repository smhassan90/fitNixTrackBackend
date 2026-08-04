import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarDateStringInGymTZ,
  formatTimeInGymTZ,
  parseDevicePunchInstant,
} from './dateHelpers';

const KARACHI = 'Asia/Karachi';

test('device wall-clock: naive string stays gym-local (not +5h)', () => {
  const d = parseDevicePunchInstant('2026-08-05 10:30:00', KARACHI, { deviceWallClock: true });
  assert.ok(d);
  assert.equal(formatTimeInGymTZ(d!, KARACHI), '10:30 AM');
  assert.equal(calendarDateStringInGymTZ(d!, KARACHI), '2026-08-05');
});

test('device wall-clock: fake Z suffix is treated as gym-local digits', () => {
  // Python often does local_dt.isoformat() + "Z" → was showing 3:30 PM in Karachi
  const d = parseDevicePunchInstant('2026-08-05T10:30:00Z', KARACHI, { deviceWallClock: true });
  assert.ok(d);
  assert.equal(formatTimeInGymTZ(d!, KARACHI), '10:30 AM');
});

test('device wall-clock: +00:00 suffix is treated as gym-local digits', () => {
  const d = parseDevicePunchInstant('2026-08-05T10:30:00+00:00', KARACHI, {
    deviceWallClock: true,
  });
  assert.ok(d);
  assert.equal(formatTimeInGymTZ(d!, KARACHI), '10:30 AM');
});

test('device wall-clock: real +05:00 offset is trusted as absolute', () => {
  const d = parseDevicePunchInstant('2026-08-05T10:30:00+05:00', KARACHI, {
    deviceWallClock: true,
  });
  assert.ok(d);
  assert.equal(formatTimeInGymTZ(d!, KARACHI), '10:30 AM');
});

test('device wall-clock: numeric unix digits reinterpreted as gym-local', () => {
  // 10:30:00 labeled as UTC epoch (timegm on local wall clock)
  const fakeUnix = Date.UTC(2026, 7, 5, 10, 30, 0) / 1000;
  const d = parseDevicePunchInstant(fakeUnix, KARACHI, { deviceWallClock: true });
  assert.ok(d);
  assert.equal(formatTimeInGymTZ(d!, KARACHI), '10:30 AM');
});

test('utc mode: Z suffix is true UTC (displays +5h in Karachi)', () => {
  const d = parseDevicePunchInstant('2026-08-05T10:30:00Z', KARACHI, { deviceWallClock: false });
  assert.ok(d);
  assert.equal(formatTimeInGymTZ(d!, KARACHI), '03:30 PM');
});
