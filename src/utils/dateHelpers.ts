/**
 * Format date to YYYY-MM-DD string
 */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Parse YYYY-MM-DD string to Date
 */
export function parseDate(dateString: string): Date {
  return new Date(dateString + 'T00:00:00.000Z');
}

/**
 * Get start of day in UTC
 */
export function getStartOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Get end of day in UTC
 */
export function getEndOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/**
 * Add months to a date (UTC calendar month; matches due dates stored as UTC midnight)
 */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/**
 * Parse duration string to months (e.g., "1 month" -> 1, "3 months" -> 3)
 */
export function parseDurationToMonths(duration: string): number {
  const match = duration.match(/(\d+)\s*month/i);
  if (!match) return 0;
  return parseInt(match[1], 10);
}

/**
 * Format month as YYYY-MM (UTC; matches payment dueDate / month field)
 */
export function formatMonth(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

