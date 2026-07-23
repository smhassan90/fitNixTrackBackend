/** Normalize phone to digits only for lookup (keeps last 10 digits for local match). */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

export function phonesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  return na === nb || na.endsWith(nb) || nb.endsWith(na);
}

/**
 * WhatsApp Cloud API expects digits with country code, no "+".
 * Pakistan default: 03001234567 / 3001234567 → 923001234567
 */
export function toWhatsAppRecipient(raw: string, defaultCountryCode = '92'): string {
  let digits = raw.replace(/\D/g, '');
  if (!digits) {
    throw new Error('Phone number is empty');
  }

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  const cc = defaultCountryCode.replace(/\D/g, '') || '92';

  if (digits.startsWith(cc) && digits.length >= cc.length + 10) {
    return digits;
  }

  if (digits.startsWith('0') && digits.length >= 11) {
    return `${cc}${digits.slice(1)}`;
  }

  if (digits.length === 10) {
    return `${cc}${digits}`;
  }

  if (digits.length >= 11) {
    return digits;
  }

  return `${cc}${digits}`;
}
