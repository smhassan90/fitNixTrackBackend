import { prisma } from '../lib/prisma';
import { ValidationError } from '../utils/errors';
import { parseCsv } from '../utils/csvParse';
import { mapMemberRow, mapPackageRow, mapPaymentRow, mapTrainerRow } from '../utils/importColumnMap';
import {
  parseDate,
  formatMonth,
  getGymTimezone,
  initialOpenInstallmentStatus,
} from '../utils/dateHelpers';
import {
  computeSignupOneTimeFees,
  generatePaymentsForMember,
  syncMissingNextMonthlyInstallment,
  seedMonthlyBillingAfterOneTimePaid,
  markOverduePayments,
  refreshMemberOpenInstallmentAmounts,
} from './paymentService';
import { recordMonthlyFeeCollection, recordOneTimeFeeCollection } from './feeCollectionService';

export type ImportRowResult = {
  row: number;
  status: 'created' | 'skipped' | 'failed';
  name?: string;
  id?: number;
  message?: string;
};

export type BulkImportResult = {
  gymId: number;
  dryRun: boolean;
  totalRows: number;
  created: number;
  skipped: number;
  failed: number;
  rows: ImportRowResult[];
};

export type MemberImportOptions = {
  admissionFeeWaived?: boolean;
  dryRun?: boolean;
  createMissingTrainers?: boolean;
};

const VALID_DURATIONS = new Set(['1 month', '3 months', '6 months', '12 months']);

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export function parseFlexibleDate(input: string | undefined | null): Date | null {
  if (!input?.trim()) {
    return null;
  }
  const value = input.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return parseDate(value);
  }

  const dmySlash = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmySlash) {
    const [, d, m, y] = dmySlash;
    return new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10)));
  }

  const dmyDash = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dmyDash) {
    const [, d, m, y] = dmyDash;
    return new Date(Date.UTC(parseInt(y, 10), parseInt(m, 10) - 1, parseInt(d, 10)));
  }

  const dMonY = value.match(/^(\d{1,2})[-/](\w{3})[-/](\d{4})$/i);
  if (dMonY) {
    const month = MONTHS[dMonY[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      return new Date(Date.UTC(parseInt(dMonY[3], 10), month, parseInt(dMonY[1], 10)));
    }
  }

  const dMonY2 = value.match(/^(\d{1,2})[-/](\w{3})[-/](\d{2})$/i);
  if (dMonY2) {
    const month = MONTHS[dMonY2[2].slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const yy = parseInt(dMonY2[3], 10);
      const year = yy <= 30 ? 2000 + yy : 1900 + yy;
      return new Date(Date.UTC(year, month, parseInt(dMonY2[1], 10)));
    }
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const d = new Date(parsed);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  throw new ValidationError(`Invalid date: ${value}`);
}

function parseAmount(value: string | undefined): number {
  if (!value?.trim()) {
    return 0;
  }
  const cleaned = value
    .replace(/rs\.?/gi, '')
    .replace(/pkr/gi, '')
    .replace(/[^\d.,-]/g, '')
    .replace(/,/g, '')
    .trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function isEmptyImportValue(value: string | undefined | null): boolean {
  if (!value?.trim()) {
    return true;
  }
  const v = value.trim().toLowerCase();
  return v === 'n/a' || v === 'na' || v === '-' || v === 'none' || v === 'not assigned';
}

function parseOptionalImportDate(input: string | undefined | null): Date | null {
  if (isEmptyImportValue(input)) {
    return null;
  }
  return parseFlexibleDate(input);
}

/** Parse "Mon-Sat 7PM to 12AM" or "8:00 PM to 12:00 AM" into HH:mm start/end. */
export function parseAvailabilityTimings(
  input: string | undefined | null
): { startTime: string | null; endTime: string | null } {
  if (!input?.trim()) {
    return { startTime: null, endTime: null };
  }

  const to24h = (hour: number, minute: number, meridiem: string): string => {
    let h = hour;
    const m = meridiem.toLowerCase();
    if (m.startsWith('p') && h < 12) {
      h += 12;
    }
    if (m.startsWith('a') && h === 12) {
      h = 0;
    }
    return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };

  const match = input.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:to|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i
  );
  if (!match) {
    return { startTime: null, endTime: null };
  }

  const startHour = parseInt(match[1], 10);
  const startMin = parseInt(match[2] ?? '0', 10);
  const startMer = match[3];
  const endHour = parseInt(match[4], 10);
  const endMin = parseInt(match[5] ?? '0', 10);
  const endMer = match[6];

  return {
    startTime: to24h(startHour, startMin, startMer),
    endTime: to24h(endHour, endMin, endMer),
  };
}

function normalizeGender(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  const v = value.trim().toLowerCase();
  if (v === 'm' || v === 'male') return 'Male';
  if (v === 'f' || v === 'female') return 'Female';
  if (v === 'other') return 'Other';
  return value.trim();
}

function normalizeDuration(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (VALID_DURATIONS.has(v)) {
    return v;
  }
  const map: Record<string, string> = {
    monthly: '1 month',
    '1 month': '1 month',
    '1month': '1 month',
    '1 mo': '1 month',
    quarterly: '3 months',
    '3 month': '3 months',
    '3 months': '3 months',
    '6 month': '6 months',
    '6 months': '6 months',
    yearly: '12 months',
    annual: '12 months',
    '12 month': '12 months',
    '12 months': '12 months',
    '1 year': '12 months',
  };
  return map[v] ?? null;
}

function normalizeStatus(value: string | undefined): boolean {
  if (!value?.trim()) {
    return true;
  }
  const v = value.trim().toLowerCase();
  return !(
    v === 'inactive' ||
    v === 'expired' ||
    v === 'disabled' ||
    v === 'frozen' ||
    v === 'no'
  );
}

/** Normalize names for import matching (Excel NBSP, extra spaces, trailing punctuation). */
export function normalizeImportNameKey(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.,;]+$/g, '')
    .replace(/\s+/g, ' ');
}

function normalizeNameKey(value: string): string {
  return normalizeImportNameKey(value);
}

function normalizePhoneKey(phone: string): string {
  return phone.replace(/\D/g, '');
}

type TrainerLookup = {
  id: number;
  name: string;
  charges: number | null;
};

function resolveTrainerByName(
  trainerName: string,
  trainerByName: Map<string, TrainerLookup>,
  trainers: TrainerLookup[]
): TrainerLookup | undefined {
  const key = normalizeNameKey(trainerName);
  const exact = trainerByName.get(key);
  if (exact) {
    return exact;
  }

  const withoutPrefix = key.replace(/^(mr|mrs|ms|miss|dr)\.?\s+/, '');
  if (withoutPrefix !== key) {
    const prefixed = trainerByName.get(withoutPrefix);
    if (prefixed) {
      return prefixed;
    }
  }

  const fuzzy = trainers.filter((t) => {
    const tn = normalizeNameKey(t.name);
    return tn === key || tn === withoutPrefix || key.includes(tn) || tn.includes(key);
  });
  if (fuzzy.length === 1) {
    return fuzzy[0];
  }

  return undefined;
}

type MemberLookup = {
  id: number;
  name: string;
  phone: string | null;
};

function buildMemberLookupIndexes(members: MemberLookup[]): {
  byPhone: Map<string, MemberLookup[]>;
  byName: Map<string, MemberLookup[]>;
} {
  const byPhone = new Map<string, MemberLookup[]>();
  const byName = new Map<string, MemberLookup[]>();

  for (const member of members) {
    if (member.phone) {
      const phoneKey = normalizePhoneKey(member.phone);
      if (phoneKey.length >= 7) {
        const list = byPhone.get(phoneKey) ?? [];
        list.push(member);
        byPhone.set(phoneKey, list);
      }
    }
    const nameKey = normalizeNameKey(member.name);
    const list = byName.get(nameKey) ?? [];
    list.push(member);
    byName.set(nameKey, list);
  }

  return { byPhone, byName };
}

function resolveMemberForTrainerAssign(
  name: string,
  phone: string | null,
  indexes: ReturnType<typeof buildMemberLookupIndexes>
): { member: MemberLookup } | { error: string } {
  if (phone) {
    const phoneKey = normalizePhoneKey(phone);
    if (phoneKey.length >= 7) {
      const byPhone = indexes.byPhone.get(phoneKey) ?? [];
      if (byPhone.length === 1) {
        return { member: byPhone[0] };
      }
      if (byPhone.length > 1) {
        return { error: `Multiple members share phone ${phone}` };
      }
    }
  }

  const byName = indexes.byName.get(normalizeNameKey(name)) ?? [];
  if (byName.length === 1) {
    return { member: byName[0] };
  }
  if (byName.length > 1) {
    return { error: `Multiple members named "${name}" — include a unique phone in CSV` };
  }

  return { error: `Member not found: ${name}` };
}

type PackageLookup = {
  id: number;
  name: string;
  price: number;
  discount: number | null;
  duration: string;
};

function resolvePackageByName(
  packageName: string,
  packageByName: Map<string, PackageLookup>,
  packageByDuration: Map<string, PackageLookup>
): PackageLookup | undefined {
  const byName = packageByName.get(normalizeNameKey(packageName));
  if (byName) {
    return byName;
  }
  const duration = normalizeDuration(packageName);
  if (duration) {
    return packageByDuration.get(duration);
  }
  return undefined;
}

function summarize(results: ImportRowResult[], gymId: number, dryRun: boolean): BulkImportResult {
  return {
    gymId,
    dryRun,
    totalRows: results.length,
    created: results.filter((r) => r.status === 'created').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
    rows: results,
  };
}

export async function importPackagesFromCsv(
  gymId: number,
  csvText: string,
  dryRun = false
): Promise<BulkImportResult> {
  const { rows } = parseCsv(csvText);
  const results: ImportRowResult[] = [];

  const existing = await prisma.package.findMany({
    where: { gymId },
    select: { id: true, name: true },
  });
  const byName = new Map(existing.map((p) => [normalizeNameKey(p.name), p.id]));
  const seenInFile = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const mapped = mapPackageRow(rows[i]);
    const name = mapped.name?.trim();

    if (!name) {
      results.push({ row: rowNum, status: 'failed', message: 'Package name is required' });
      continue;
    }

    const key = normalizeNameKey(name);
    if (seenInFile.has(key)) {
      results.push({ row: rowNum, status: 'skipped', name, message: 'Duplicate name in file' });
      continue;
    }
    seenInFile.add(key);

    if (byName.has(key)) {
      results.push({ row: rowNum, status: 'skipped', name, message: 'Package already exists in this gym' });
      continue;
    }

    const price = parseAmount(mapped.price);
    if (price <= 0) {
      results.push({ row: rowNum, status: 'failed', name, message: 'Valid price is required' });
      continue;
    }

    const duration = normalizeDuration(mapped.duration ?? '1 month');
    if (!duration) {
      results.push({
        row: rowNum,
        status: 'failed',
        name,
        message: 'Duration must be one of: 1 month, 3 months, 6 months, 12 months',
      });
      continue;
    }

    const discount = parseAmount(mapped.discount);

    if (dryRun) {
      results.push({ row: rowNum, status: 'created', name, message: 'Would create package' });
      continue;
    }

    const created = await prisma.package.create({
      data: { gymId, name, price, discount, duration },
      select: { id: true },
    });
    byName.set(key, created.id);
    results.push({ row: rowNum, status: 'created', name, id: created.id });
  }

  return summarize(results, gymId, dryRun);
}

export async function importTrainersFromCsv(
  gymId: number,
  csvText: string,
  dryRun = false
): Promise<BulkImportResult> {
  const { rows } = parseCsv(csvText);
  const results: ImportRowResult[] = [];

  const existing = await prisma.trainer.findMany({
    where: { gymId },
    select: { id: true, name: true },
  });
  const byName = new Map(existing.map((t) => [normalizeNameKey(t.name), t.id]));
  const seenInFile = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const mapped = mapTrainerRow(rows[i]);
    const name = mapped.name?.trim();

    if (!name) {
      results.push({ row: rowNum, status: 'failed', message: 'Trainer name is required' });
      continue;
    }

    const key = normalizeNameKey(name);
    if (seenInFile.has(key)) {
      results.push({ row: rowNum, status: 'skipped', name, message: 'Duplicate name in file' });
      continue;
    }
    seenInFile.add(key);

    if (byName.has(key)) {
      results.push({ row: rowNum, status: 'skipped', name, message: 'Trainer already exists in this gym' });
      continue;
    }

    let dateOfBirth: Date | null = null;
    try {
      dateOfBirth = parseOptionalImportDate(mapped.dateOfBirth);
    } catch (e) {
      results.push({
        row: rowNum,
        status: 'failed',
        name,
        message: e instanceof Error ? e.message : 'Invalid date of birth',
      });
      continue;
    }

    const charges = mapped.charges ? parseAmount(mapped.charges) : null;
    const parsedTimings = parseAvailabilityTimings(mapped.availableTimings);
    const startTime =
      mapped.startTime?.trim() || parsedTimings.startTime || null;
    const endTime = mapped.endTime?.trim() || parsedTimings.endTime || null;

    if (dryRun) {
      results.push({ row: rowNum, status: 'created', name, message: 'Would create trainer' });
      continue;
    }

    const created = await prisma.trainer.create({
      data: {
        gymId,
        name,
        gender: normalizeGender(mapped.gender),
        dateOfBirth,
        specialization: mapped.specialization?.trim() || null,
        charges: charges && charges > 0 ? charges : null,
        startTime,
        endTime,
      },
      select: { id: true },
    });
    byName.set(key, created.id);
    results.push({ row: rowNum, status: 'created', name, id: created.id });
  }

  return summarize(results, gymId, dryRun);
}

async function applyImportedPaidAmount(
  gymId: number,
  memberId: number,
  memberName: string,
  paidAmount: number,
  collectedAt: Date
): Promise<void> {
  if (paidAmount <= 0) {
    return;
  }

  let remaining = paidAmount;

  while (remaining > 0.01) {
    const next = await prisma.payment.findFirst({
      where: { gymId, memberId, status: { in: ['PENDING', 'OVERDUE'] } },
      orderBy: { dueDate: 'asc' },
    });
    if (!next || next.amount > remaining + 0.01) {
      break;
    }

    const paidDate = new Date(collectedAt);
    paidDate.setUTCHours(0, 0, 0, 0);

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: next.id },
        data: { status: 'PAID', paidDate },
      });
      await recordMonthlyFeeCollection(tx, {
        gymId,
        memberId,
        memberName,
        paymentId: next.id,
        amount: next.amount,
        billingMonth: next.month,
        collectedAt: paidDate,
      });
    });

    remaining -= next.amount;
  }
}

export async function importMembersFromCsv(
  gymId: number,
  csvText: string,
  options: MemberImportOptions = {}
): Promise<BulkImportResult> {
  const dryRun = options.dryRun === true;
  const admissionFeeWaived = options.admissionFeeWaived !== false;
  const createMissingTrainers = options.createMissingTrainers === true;
  const { rows } = parseCsv(csvText);
  const results: ImportRowResult[] = [];

  const [packages, trainers, gym] = await Promise.all([
    prisma.package.findMany({
      where: { gymId },
      select: { id: true, name: true, price: true, discount: true, duration: true },
    }),
    prisma.trainer.findMany({ where: { gymId }, select: { id: true, name: true, charges: true } }),
    prisma.gym.findUnique({ where: { id: gymId }, select: { admissionFee: true } }),
  ]);

  const packageByName = new Map(packages.map((p) => [normalizeNameKey(p.name), p]));
  const packageByDuration = new Map(packages.map((p) => [p.duration, p]));
  const trainerByName = new Map(trainers.map((t) => [normalizeNameKey(t.name), t]));

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const mapped = mapMemberRow(rows[i]);
    const name = mapped.name?.trim();

    if (!name) {
      results.push({ row: rowNum, status: 'failed', message: 'Member name is required' });
      continue;
    }

    const phoneRaw = mapped.phone?.trim() || null;

    let joiningDate: Date;
    let expiryDate: Date | null = null;
    let dateOfBirth: Date | null = null;
    try {
      joiningDate = parseFlexibleDate(mapped.joiningDate) ?? new Date();
      joiningDate.setUTCHours(0, 0, 0, 0);
      expiryDate = parseFlexibleDate(mapped.expiryDate);
      if (expiryDate) {
        expiryDate.setUTCHours(0, 0, 0, 0);
      }
      dateOfBirth = parseOptionalImportDate(mapped.dateOfBirth);
    } catch (e) {
      results.push({
        row: rowNum,
        status: 'failed',
        name,
        message: e instanceof Error ? e.message : 'Invalid date',
      });
      continue;
    }

    const packageData = mapped.packageName
      ? resolvePackageByName(mapped.packageName, packageByName, packageByDuration)
      : undefined;
    if (mapped.packageName && !packageData) {
      results.push({
        row: rowNum,
        status: 'failed',
        name,
        message: `Package not found: ${mapped.packageName}. Import packages first (name can match plan label e.g. "1 Month").`,
      });
      continue;
    }

    let trainer = mapped.trainerName
      ? resolveTrainerByName(mapped.trainerName, trainerByName, trainers)
      : undefined;
    if (mapped.trainerName && !trainer) {
      const trainerName = mapped.trainerName.trim();
      if (createMissingTrainers) {
        if (dryRun) {
          results.push({
            row: rowNum,
            status: 'created',
            name,
            message: `Would create member and trainer "${trainerName}"`,
          });
          continue;
        }
        const createdTrainer = await prisma.trainer.create({
          data: { gymId, name: trainerName },
          select: { id: true, name: true, charges: true },
        });
        trainer = createdTrainer;
        trainerByName.set(normalizeNameKey(trainerName), createdTrainer);
      } else {
        results.push({
          row: rowNum,
          status: 'failed',
          name,
          message: `Trainer not found: ${trainerName}. Import trainers first or use ?createMissingTrainers=true.`,
        });
        continue;
      }
    }

    const discount = parseAmount(mapped.discount) || null;
    const paidAmount = parseAmount(mapped.paidAmount);
    const isActive = normalizeStatus(mapped.status);
    const trainerList = trainer ? [trainer] : [];

    if (dryRun) {
      results.push({ row: rowNum, status: 'created', name, message: 'Would create member' });
      continue;
    }

    try {
      const admissionFee = gym?.admissionFee ?? 0;
      const admissionFeePaid = admissionFeeWaived ? 0 : admissionFee;
      const signupFees = computeSignupOneTimeFees({
        admissionFeePaid,
        packageData: packageData ?? null,
        trainers: trainerList,
        memberDiscount: discount,
      });

      const signupPaid = paidAmount >= signupFees.totalAmount && signupFees.totalAmount > 0;

      const member = await prisma.member.create({
        data: {
          gymId,
          name,
          phone: phoneRaw,
          email: mapped.email?.trim() || null,
          gender: normalizeGender(mapped.gender),
          dateOfBirth,
          cnic: mapped.cnic?.replace(/\D/g, '').slice(0, 13) || null,
          comments: mapped.comments?.trim() || null,
          packageId: packageData?.id ?? null,
          discount,
          membershipStart: joiningDate,
          membershipEnd: expiryDate,
          billingResumeFrom: joiningDate,
          isActive,
          inactiveFrom: isActive ? null : joiningDate,
          admissionFeeWaived,
          admissionFeePaid,
          oneTimePaymentAmount: signupFees.totalAmount,
          monthlyPaymentAmount: signupFees.monthlyInstallmentAmount,
          oneTimePaymentPaid: signupPaid,
          trainers: trainer ? { create: [{ trainerId: trainer.id }] } : undefined,
        } as any,
        select: { id: true },
      });

      if (signupFees.admissionFee > 0 || signupFees.firstMonthRecurring > 0) {
        const oneTime = await prisma.oneTimePayment.create({
          data: {
            gymId,
            memberId: member.id,
            admissionFee: signupFees.admissionFee,
            packageFee: signupFees.packageFee,
            trainerFee: signupFees.trainerFee,
            totalAmount: signupFees.totalAmount,
            status: signupPaid ? 'PAID' : 'PENDING',
            paidDate: signupPaid ? joiningDate : null,
          },
        });
        if (signupPaid) {
          await recordOneTimeFeeCollection(prisma, {
            gymId,
            memberId: member.id,
            memberName: name,
            oneTimePaymentId: oneTime.id,
            admissionFee: signupFees.admissionFee,
            packageFee: signupFees.packageFee,
            trainerFee: signupFees.trainerFee,
            totalAmount: signupFees.totalAmount,
            collectedAt: joiningDate,
            billingMonth: formatMonth(joiningDate),
          });
        }
      }

      if (packageData) {
        if (signupPaid && signupFees.firstMonthRecurring > 0) {
          await seedMonthlyBillingAfterOneTimePaid(member.id, gymId);
        } else {
          await generatePaymentsForMember(member.id, gymId, packageData.id, joiningDate, {
            skipFirstInstallment: false,
          });
        }
        if (expiryDate) {
          await prisma.member.update({
            where: { id: member.id },
            data: { membershipEnd: expiryDate },
          });
        }
        await syncMissingNextMonthlyInstallment(member.id, gymId);

        let remainingPaid = paidAmount;
        if (signupPaid && signupFees.totalAmount > 0) {
          remainingPaid = paidAmount - signupFees.totalAmount;
        }
        if (remainingPaid > 0) {
          await applyImportedPaidAmount(gymId, member.id, name, remainingPaid, joiningDate);
        }
      }

      results.push({ row: rowNum, status: 'created', name, id: member.id });
    } catch (e) {
      results.push({
        row: rowNum,
        status: 'failed',
        name,
        message: e instanceof Error ? e.message : 'Import failed',
      });
    }
  }

  return summarize(results, gymId, dryRun);
}

export async function assignMemberTrainersFromCsv(
  gymId: number,
  csvText: string,
  options: Pick<MemberImportOptions, 'dryRun' | 'createMissingTrainers'> = {}
): Promise<BulkImportResult> {
  const dryRun = options.dryRun === true;
  const createMissingTrainers = options.createMissingTrainers === true;
  const { rows } = parseCsv(csvText);
  const results: ImportRowResult[] = [];

  const [trainers, members] = await Promise.all([
    prisma.trainer.findMany({ where: { gymId }, select: { id: true, name: true, charges: true } }),
    prisma.member.findMany({
      where: { gymId },
      select: { id: true, name: true, phone: true },
    }),
  ]);

  const trainerByName = new Map(trainers.map((t) => [normalizeNameKey(t.name), t]));
  const memberIndexes = buildMemberLookupIndexes(members);

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const mapped = mapMemberRow(rows[i]);
    const name = mapped.name?.trim();

    if (!name) {
      results.push({ row: rowNum, status: 'failed', message: 'Member name is required' });
      continue;
    }

    if (!mapped.trainerName) {
      results.push({ row: rowNum, status: 'skipped', name, message: 'No trainer in row' });
      continue;
    }

    const phoneRaw = mapped.phone?.trim() || null;
    const memberResult = resolveMemberForTrainerAssign(name, phoneRaw, memberIndexes);
    if ('error' in memberResult) {
      results.push({ row: rowNum, status: 'failed', name, message: memberResult.error });
      continue;
    }

    let trainer = resolveTrainerByName(mapped.trainerName, trainerByName, trainers);
    if (!trainer) {
      const trainerName = mapped.trainerName.trim();
      if (createMissingTrainers) {
        if (dryRun) {
          results.push({
            row: rowNum,
            status: 'created',
            name,
            message: `Would assign trainer "${trainerName}"`,
          });
          continue;
        }
        const createdTrainer = await prisma.trainer.create({
          data: { gymId, name: trainerName },
          select: { id: true, name: true, charges: true },
        });
        trainer = createdTrainer;
        trainers.push(createdTrainer);
        trainerByName.set(normalizeNameKey(trainerName), createdTrainer);
      } else {
        results.push({
          row: rowNum,
          status: 'failed',
          name,
          message: `Trainer not found: ${trainerName}. Import trainers first or use ?createMissingTrainers=true.`,
        });
        continue;
      }
    }

    if (dryRun) {
      results.push({
        row: rowNum,
        status: 'created',
        name,
        message: `Would assign ${trainer.name}`,
      });
      continue;
    }

    try {
      await prisma.memberTrainer.deleteMany({ where: { memberId: memberResult.member.id } });
      await prisma.memberTrainer.create({
        data: {
          memberId: memberResult.member.id,
          trainerId: trainer.id,
        },
      });
      results.push({
        row: rowNum,
        status: 'created',
        name,
        id: memberResult.member.id,
        message: `Assigned ${trainer.name}`,
      });
    } catch (e) {
      results.push({
        row: rowNum,
        status: 'failed',
        name,
        message: e instanceof Error ? e.message : 'Trainer assignment failed',
      });
    }
  }

  return summarize(results, gymId, dryRun);
}

function resolveImportedPaymentStatus(
  dueDate: Date,
  paidDate: Date | null,
  timeZone: string
): { status: 'PAID' | 'PENDING' | 'OVERDUE'; paidDate: Date | null } {
  if (paidDate) {
    return { status: 'PAID', paidDate };
  }
  return {
    status: initialOpenInstallmentStatus(dueDate, timeZone),
    paidDate: null,
  };
}

export async function importPaymentsFromCsv(
  gymId: number,
  csvText: string,
  dryRun = false
): Promise<BulkImportResult> {
  const { rows } = parseCsv(csvText);
  const results: ImportRowResult[] = [];
  const tz = getGymTimezone();
  const affectedMemberIds = new Set<number>();

  const members = await prisma.member.findMany({
    where: { gymId },
    select: { id: true, name: true, phone: true },
  });
  const memberIndexes = buildMemberLookupIndexes(members);

  for (let i = 0; i < rows.length; i++) {
    const rowNum = i + 2;
    const mapped = mapPaymentRow(rows[i]);
    const name = mapped.memberName?.trim();

    if (!name) {
      results.push({ row: rowNum, status: 'failed', message: 'Member name is required' });
      continue;
    }

    const phoneRaw = mapped.phone?.trim() || null;
    const memberResult = resolveMemberForTrainerAssign(name, phoneRaw, memberIndexes);
    if ('error' in memberResult) {
      results.push({ row: rowNum, status: 'failed', name, message: memberResult.error });
      continue;
    }

    let dueDate: Date;
    let paidDate: Date | null = null;
    try {
      const parsedDue = parseFlexibleDate(mapped.dueDate);
      if (!parsedDue) {
        results.push({ row: rowNum, status: 'failed', name, message: 'Due date is required' });
        continue;
      }
      dueDate = parsedDue;
      dueDate.setUTCHours(0, 0, 0, 0);
      paidDate = parseFlexibleDate(mapped.paidDate);
      if (paidDate) {
        paidDate.setUTCHours(0, 0, 0, 0);
      }
    } catch (e) {
      results.push({
        row: rowNum,
        status: 'failed',
        name,
        message: e instanceof Error ? e.message : 'Invalid date',
      });
      continue;
    }

    const amount = parseAmount(mapped.amount);
    if (amount < 0) {
      results.push({ row: rowNum, status: 'failed', name, message: 'Amount cannot be negative' });
      continue;
    }
    if (amount === 0 && !paidDate) {
      results.push({
        row: rowNum,
        status: 'skipped',
        name,
        message: 'Zero amount with no paid date — skipped',
      });
      continue;
    }

    const month = formatMonth(dueDate);
    const { status, paidDate: resolvedPaidDate } = resolveImportedPaymentStatus(
      dueDate,
      paidDate,
      tz
    );

    if (dryRun) {
      results.push({
        row: rowNum,
        status: 'created',
        name,
        message: `Would import ${status} payment for ${month} (Rs. ${amount})`,
      });
      continue;
    }

    try {
      const memberId = memberResult.member.id;
      const existing = await prisma.payment.findFirst({
        where: { gymId, memberId, month },
      });

      let paymentId: number;
      if (existing) {
        const updated = await prisma.payment.update({
          where: { id: existing.id },
          data: {
            amount,
            dueDate,
            status,
            paidDate: resolvedPaidDate,
          },
        });
        paymentId = updated.id;
        results.push({
          row: rowNum,
          status: 'created',
          name,
          id: paymentId,
          message: `Updated ${status} payment for ${month}`,
        });
      } else {
        const created = await prisma.payment.create({
          data: {
            gymId,
            memberId,
            month,
            amount,
            dueDate,
            status,
            paidDate: resolvedPaidDate,
          },
        });
        paymentId = created.id;
        results.push({
          row: rowNum,
          status: 'created',
          name,
          id: paymentId,
          message: `Imported ${status} payment for ${month}`,
        });
      }

      if (status === 'PAID' && resolvedPaidDate) {
        await prisma.$transaction(async (tx) => {
          await recordMonthlyFeeCollection(tx, {
            gymId,
            memberId,
            memberName: name,
            paymentId,
            amount,
            billingMonth: month,
            collectedAt: resolvedPaidDate,
          });
        });
      }

      affectedMemberIds.add(memberId);
    } catch (e) {
      results.push({
        row: rowNum,
        status: 'failed',
        name,
        message: e instanceof Error ? e.message : 'Payment import failed',
      });
    }
  }

  if (!dryRun && affectedMemberIds.size > 0) {
    for (const memberId of affectedMemberIds) {
      await refreshMemberOpenInstallmentAmounts(memberId, gymId);
      await syncMissingNextMonthlyInstallment(memberId, gymId);
    }
    await markOverduePayments(gymId);
  }

  return summarize(results, gymId, dryRun);
}
