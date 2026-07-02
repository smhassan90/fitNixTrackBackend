import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../utils/csvParse';
import { mapMemberRow } from '../utils/importColumnMap';
import {
  parseFlexibleDate,
  parseAvailabilityTimings,
  normalizeImportNameKey,
} from '../services/bulkImportService';
import { mapTrainerRow, mapPaymentRow } from '../utils/importColumnMap';

function normalizeDuration(value: string): string | null {
  const VALID = new Set(['1 month', '3 months', '6 months', '12 months']);
  const v = value.trim().toLowerCase();
  if (VALID.has(v)) return v;
  const map: Record<string, string> = {
    monthly: '1 month',
    '1 month': '1 month',
    quarterly: '3 months',
    '3 months': '3 months',
    '6 months': '6 months',
    yearly: '12 months',
    annual: '12 months',
    '12 months': '12 months',
    '1 year': '12 months',
  };
  return map[v] ?? null;
}

test('mapPaymentRow accepts legacy payment export headers', () => {
  const mapped = mapPaymentRow({
    'Member ID': '11',
    'Member Name': 'Shan Naseem',
    'Amount (Rs.)': '1,000.00',
    'Due Date': '04-Apr-2026',
    'Paid Date': '04-Mar-2026',
  });
  assert.equal(mapped.legacyMemberId, '11');
  assert.equal(mapped.memberName, 'Shan Naseem');
  assert.equal(mapped.amount, '1,000.00');
  assert.equal(mapped.dueDate, '04-Apr-2026');
  assert.equal(mapped.paidDate, '04-Mar-2026');
});

test('parseFlexibleDate supports DD-Mon-YYYY used in payment exports', () => {
  const d = parseFlexibleDate('04-Mar-2026');
  assert.equal(d?.getUTCFullYear(), 2026);
  assert.equal(d?.getUTCMonth(), 2);
  assert.equal(d?.getUTCDate(), 4);
});

test('normalizeImportNameKey handles Excel spacing and punctuation', () => {
  assert.equal(normalizeImportNameKey('  Ali\u00a0Warsi  '), 'ali warsi');
  assert.equal(normalizeImportNameKey('Ali Warsi,'), 'ali warsi');
  assert.equal(normalizeImportNameKey('ALI  WARSI'), 'ali warsi');
});

test('mapMemberRow skips additional empty trainer labels', () => {
  const mapped = mapMemberRow({
    Name: 'Test Member',
    Trainer: 'Unassigned',
  });
  assert.equal(mapped.trainerName, undefined);
});

test('parseCsv reads header and rows', () => {
  const csv = 'name,phone\nAli,03001234567\nSara,03007654321';
  const { headers, rows } = parseCsv(csv);
  assert.deepEqual(headers, ['name', 'phone']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Ali');
});

test('mapMemberRow accepts gym spreadsheet headers (Member ID, Joining Date, etc.)', () => {
  const mapped = mapMemberRow({
    'Member ID': '42',
    Name: 'Ali Khan',
    Gender: 'Male',
    Phone: '03001234567',
    'Joining Date': '15-05-2023',
    'Expiry Date': '15-06-2023',
    Package: '1 Month',
    Trainer: 'John Trainer',
    Status: 'Active',
  });
  assert.equal(mapped.name, 'Ali Khan');
  assert.equal(mapped.phone, '03001234567');
  assert.equal(mapped.joiningDate, '15-05-2023');
  assert.equal(mapped.expiryDate, '15-06-2023');
  assert.equal(mapped.packageName, '1 Month');
  assert.equal(mapped.trainerName, 'John Trainer');
  assert.equal(mapped.status, 'Active');
  assert.equal(mapped.memberId, '42');
});

test('mapMemberRow accepts Admission Date, Current Package, and skips Not Assigned / N/A', () => {
  const mapped = mapMemberRow({
    'Member ID': '11',
    'Full Name': 'Shan Naseem',
    Phone: '03410562971',
    Gender: 'Male',
    'Date of Birth': 'N/A',
    'Admission Date': '26-Feb-20',
    'Current Package': 'Basic',
    Trainer: 'Not Assigned',
    Status: 'Frozen',
  });
  assert.equal(mapped.name, 'Shan Naseem');
  assert.equal(mapped.joiningDate, '26-Feb-20');
  assert.equal(mapped.packageName, 'Basic');
  assert.equal(mapped.status, 'Frozen');
  assert.equal(mapped.dateOfBirth, undefined);
  assert.equal(mapped.trainerName, undefined);
});

test('parseFlexibleDate supports DD-MM-YYYY', () => {
  const d = parseFlexibleDate('15-05-2023');
  assert.equal(d?.getUTCFullYear(), 2023);
  assert.equal(d?.getUTCMonth(), 4);
  assert.equal(d?.getUTCDate(), 15);
});

test('parseAmount strips Rs. and commas', () => {
  const parseRs = (v: string) => {
    const cleaned = v
      .replace(/rs\.?/gi, '')
      .replace(/pkr/gi, '')
      .replace(/[^\d.,-]/g, '')
      .replace(/,/g, '')
      .trim();
    return parseFloat(cleaned);
  };
  assert.equal(parseRs('Rs. 2,000'), 2000);
  assert.equal(parseRs('Rs. 3,000'), 3000);
});

test('parseAvailabilityTimings extracts start and end times', () => {
  const a = parseAvailabilityTimings('Mon-Sat 7PM to 12AM');
  assert.equal(a.startTime, '19:00');
  assert.equal(a.endTime, '00:00');

  const b = parseAvailabilityTimings('Monday to Saturday 8:00 PM to 12:00 AM');
  assert.equal(b.startTime, '20:00');
  assert.equal(b.endTime, '00:00');
});

test('mapTrainerRow accepts Full Name and Available Timings headers', () => {
  const mapped = mapTrainerRow({
    'Full Name': 'Ali Warsi',
    Gender: 'Male',
    Specialization: 'Strength training (Body building)',
    Charges: 'Rs. 2,000',
    'Available Timings': 'Mon-Sat 7PM to 12AM',
  });
  assert.equal(mapped.name, 'Ali Warsi');
  assert.equal(mapped.charges, 'Rs. 2,000');
  assert.equal(mapped.availableTimings, 'Mon-Sat 7PM to 12AM');
});

test('parseFlexibleDate supports common spreadsheet formats', () => {
  const a = parseFlexibleDate('2024-01-15');
  assert.equal(a?.toISOString().slice(0, 10), '2024-01-15');

  const b = parseFlexibleDate('01-Jan-2024');
  assert.equal(b?.getUTCFullYear(), 2024);
  assert.equal(b?.getUTCMonth(), 0);
  assert.equal(b?.getUTCDate(), 1);

  const c = parseFlexibleDate('15/01/2024');
  assert.equal(c?.getUTCDate(), 15);

  const d = parseFlexibleDate('15-Feb-20');
  assert.equal(d?.getUTCFullYear(), 2020);
  assert.equal(d?.getUTCMonth(), 1);
  assert.equal(d?.getUTCDate(), 15);

  const e = parseFlexibleDate('18-Nov-2008');
  assert.equal(e?.getUTCFullYear(), 2008);
  assert.equal(e?.getUTCMonth(), 10);
  assert.equal(e?.getUTCDate(), 18);
});
