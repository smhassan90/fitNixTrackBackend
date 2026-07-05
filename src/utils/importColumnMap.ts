import { CsvRow, normalizeHeaderKey } from './csvParse';

export type MappedRow = Record<string, string>;

const PACKAGE_ALIASES: Record<string, string[]> = {
  name: ['name', 'package', 'package name', 'plan', 'plan name'],
  price: ['price', 'amount', 'fee', 'package price', 'total amount', 'total'],
  discount: ['discount', 'package discount'],
  duration: ['duration', 'validity', 'period', 'package duration'],
};

const TRAINER_ALIASES: Record<string, string[]> = {
  name: ['name', 'trainer', 'trainer name', 'full name'],
  gender: ['gender', 'sex'],
  dateOfBirth: ['date of birth', 'dob', 'birth date'],
  specialization: ['specialization', 'speciality', 'specialty', 'expertise'],
  charges: ['charges', 'fee', 'monthly charges', 'trainer fee'],
  startTime: ['start time', 'start', 'from time'],
  endTime: ['end time', 'end', 'to time'],
  availableTimings: ['available timings', 'availability', 'timings', 'schedule', 'working hours'],
};

const MEMBER_ALIASES: Record<string, string[]> = {
  name: ['name', 'member name', 'full name', 'member'],
  legacyMemberId: ['member id', 'id', 'serial', 'sr no', 'sr', 's no', 'sno'],
  phone: ['phone', 'mobile', 'mobile no', 'mobile number', 'contact', 'contact no', 'cell'],
  email: ['email', 'email address'],
  gender: ['gender', 'sex'],
  dateOfBirth: ['date of birth', 'dob', 'birth date', 'age'],
  joiningDate: [
    'joining date',
    'join date',
    'date of joining',
    'membership start',
    'start date',
    'registration date',
    'admission date',
  ],
  expiryDate: [
    'expiry date',
    'expire date',
    'date of expiry',
    'expiration date',
    'membership end',
    'end date',
  ],
  packageName: ['package', 'package name', 'plan', 'plan name', 'membership plan', 'current package'],
  trainerName: ['trainer', 'trainer name', 'assigned trainer'],
  status: ['status', 'membership status', 'member status'],
  monthlyFee: ['monthly fee', 'monthly amount', 'recurring fee'],
  paidAmount: ['paid amount', 'paid', 'amount paid', 'received'],
  dueAmount: ['due amount', 'due', 'balance', 'outstanding', 'pending amount'],
  discount: ['discount', 'member discount'],
  cnic: ['cnic', 'nic', 'id number'],
  comments: ['comments', 'notes', 'remarks'],
};

const PAYMENT_ALIASES: Record<string, string[]> = {
  memberName: ['member name', 'name', 'full name', 'member'],
  legacyMemberId: ['member id', 'id', 'serial', 'sr no', 'sr', 's no', 'sno'],
  phone: ['phone', 'mobile', 'mobile no', 'mobile number', 'contact', 'contact no', 'cell'],
  amount: ['amount', 'amount rs', 'amount rs.', 'fee', 'monthly fee', 'payment amount'],
  dueDate: ['due date', 'due', 'payment due', 'installment due'],
  paidDate: ['paid date', 'date paid', 'payment date', 'received date', 'paid on'],
};

function buildReverseMap(aliases: Record<string, string[]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [field, keys] of Object.entries(aliases)) {
    for (const key of keys) {
      map.set(normalizeHeaderKey(key), field);
    }
  }
  return map;
}

const PACKAGE_MAP = buildReverseMap(PACKAGE_ALIASES);
const TRAINER_MAP = buildReverseMap(TRAINER_ALIASES);
const MEMBER_MAP = buildReverseMap(MEMBER_ALIASES);
const PAYMENT_MAP = buildReverseMap(PAYMENT_ALIASES);

function isSkippableCell(value: string): boolean {
  const v = value
    .replace(/\u00a0/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[.,;]+$/g, '');
  return (
    v === '' ||
    v === 'n/a' ||
    v === 'na' ||
    v === '-' ||
    v === 'none' ||
    v === 'not assigned' ||
    v === 'unassigned' ||
    v === 'no trainer' ||
    v === 'no' ||
    v === 'nil' ||
    v === 'null'
  );
}

function mapRow(row: CsvRow, reverseMap: Map<string, string>): MappedRow {
  const mapped: MappedRow = {};
  for (const [header, value] of Object.entries(row)) {
    const field = reverseMap.get(normalizeHeaderKey(header));
    if (field && !isSkippableCell(value)) {
      mapped[field] = value;
    }
  }
  return mapped;
}

export function mapPackageRow(row: CsvRow): MappedRow {
  return mapRow(row, PACKAGE_MAP);
}

export function mapTrainerRow(row: CsvRow): MappedRow {
  return mapRow(row, TRAINER_MAP);
}

export function mapMemberRow(row: CsvRow): MappedRow {
  return mapRow(row, MEMBER_MAP);
}

export function mapPaymentRow(row: CsvRow): MappedRow {
  return mapRow(row, PAYMENT_MAP);
}

export const IMPORT_TEMPLATES = {
  packages: 'name,price,discount,duration\nMonthly Plan,5000,0,1 month\nQuarterly Plan,14000,0,3 months\nAnnual Plan,50000,0,12 months',
  trainers:
    'Full Name,Gender,Specialization,Charges,Available Timings\nAli Warsi,Male,Strength training (Body building),Rs. 2000,Mon-Sat 7PM to 12AM',
  members:
    'Member ID,Name,Gender,Phone,Joining Date,Expiry Date,Package,Trainer,Status\n1,Ali Khan,Male,03001234567,15-05-2023,15-06-2023,1 Month,John Trainer,Active',
  payments:
    'Member ID,Member Name,Amount (Rs.),Due Date,Paid Date\n10,Blank 10,5000.00,04-Mar-2026,25-Feb-2026\n11,Shan Naseem,1000.00,04-Apr-2026,04-Mar-2026',
} as const;
