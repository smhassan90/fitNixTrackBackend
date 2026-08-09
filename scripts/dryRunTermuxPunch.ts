/**
 * Standalone production dry-run using EXACT values emitted by Python termux_sync.
 * Run: npx tsx scripts/dryRunTermuxPunch.ts
 */
import {
  formatDateTimeInGymTZ,
  formatTimeInGymTZ,
  resolveOfflineDevicePunchInstant,
} from '../src/utils/dateHelpers';

const KARACHI = 'Asia/Karachi';

// Captured from: python -c "... Asia/Karachi naive 14:22 ..."
const PYTHON_OLD_RECORD = '2026-08-09T14:22:00.000Z';
const PYTHON_NEW_RECORD = '2026-08-09T14:22:00+05:00';
const PYTHON_TIMESTAMP = 1786267320; // aware.timestamp() from Termux

const manualIso = new Date(PYTHON_TIMESTAMP * 1000).toISOString();
const brokenIfTrustZ = new Date(PYTHON_OLD_RECORD);

const fromOldScript = resolveOfflineDevicePunchInstant(
  { recordTime: PYTHON_OLD_RECORD, timestamp: PYTHON_TIMESTAMP },
  KARACHI,
  'gym_local'
)!;
const fromNewScript = resolveOfflineDevicePunchInstant(
  { recordTime: PYTHON_NEW_RECORD, timestamp: PYTHON_TIMESTAMP },
  KARACHI,
  'gym_local'
)!;
const fromManual = new Date(manualIso);

const rows = [
  ['Device clock (expected)', '02:22 PM'],
  ['BUG if trust fake Z', formatTimeInGymTZ(brokenIfTrustZ, KARACHI)],
  ['Backend + OLD termux script', formatTimeInGymTZ(fromOldScript, KARACHI)],
  ['Backend + NEW termux script', formatTimeInGymTZ(fromNewScript, KARACHI)],
  ['Manual check-in same moment', formatTimeInGymTZ(fromManual, KARACHI)],
  ['Attendance list field (old)', formatDateTimeInGymTZ(fromOldScript, {}, KARACHI)],
];

let failed = false;
console.log('=== Termux → Backend production dry-run ===\n');
for (const [k, v] of rows) {
  console.log(`${k.padEnd(32)} ${v}`);
}

const ok =
  formatTimeInGymTZ(fromOldScript, KARACHI) === '02:22 PM' &&
  formatTimeInGymTZ(fromNewScript, KARACHI) === '02:22 PM' &&
  formatTimeInGymTZ(fromManual, KARACHI) === '02:22 PM' &&
  fromOldScript.getTime() === fromManual.getTime() &&
  fromNewScript.getTime() === fromManual.getTime() &&
  formatTimeInGymTZ(brokenIfTrustZ, KARACHI) === '07:22 PM';

if (!ok) {
  failed = true;
  console.error('\nFAIL: device/manual mismatch or bug precondition broken');
} else {
  console.log('\nPASS: old+new termux payloads match manual check-in at 02:22 PM');
  console.log('(Fake Z alone still shows 07:22 PM — confirms we must prefer timestamp)');
}

process.exit(failed ? 1 : 0);
