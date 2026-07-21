import { prisma } from '../lib/prisma';

const CACHE_TTL_MS = 5 * 60 * 1000;
const timezoneCache = new Map<number, { timezone: string; expiresAt: number }>();

const FALLBACK_TIMEZONES = [
  'UTC',
  'Asia/Karachi',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Riyadh',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
];

export function isValidIanaTimezone(timezone: string): boolean {
  if (!timezone || typeof timezone !== 'string' || timezone.length > 64) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function invalidateGymTimezoneCache(gymId: number): void {
  timezoneCache.delete(gymId);
}

export async function getGymTimezoneById(gymId: number): Promise<string> {
  const now = Date.now();
  const cached = timezoneCache.get(gymId);
  if (cached && cached.expiresAt > now) {
    return cached.timezone;
  }

  const gym = await prisma.gym.findUnique({
    where: { id: gymId },
    select: { timezone: true },
  });

  const timezone =
    gym?.timezone && isValidIanaTimezone(gym.timezone) ? gym.timezone : 'UTC';
  timezoneCache.set(gymId, { timezone, expiresAt: now + CACHE_TTL_MS });
  return timezone;
}

export function listIanaTimezones(): string[] {
  const intlWithSupported = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof intlWithSupported.supportedValuesOf === 'function') {
    return intlWithSupported.supportedValuesOf('timeZone').sort();
  }
  return [...FALLBACK_TIMEZONES];
}
