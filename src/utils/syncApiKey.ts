import { randomBytes } from 'crypto';

/** Permanent per-gym key for tablet offline sync (no expiry). */
export function generateSyncApiKey(gymId: number): string {
  return `fnx_${gymId}_${randomBytes(24).toString('base64url')}`;
}
