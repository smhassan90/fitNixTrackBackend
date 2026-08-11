import crypto from 'crypto';
import { AppError } from '../../utils/errors';

const PREFIX = 'v1';

/** Derive AES key from product JWT_SECRET only (no marketing-specific env keys). */
function getKey(): Buffer {
  const material = process.env.JWT_SECRET?.trim() || '';
  if (!material) {
    throw new AppError(
      'ENCRYPTION_NOT_CONFIGURED',
      'JWT_SECRET is required to encrypt marketing secrets',
      503
    );
  }
  return crypto.createHash('sha256').update(`fitnix-marketing:${material}`).digest();
}

/** Encrypt a secret string (AES-256-GCM). */
export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

/** Decrypt ciphertext from encryptSecret. */
export function decryptSecret(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new AppError('TOKEN_DECRYPT_FAILED', 'Invalid encrypted token format', 500);
  }
  const key = getKey();
  const iv = Buffer.from(parts[1], 'base64url');
  const tag = Buffer.from(parts[2], 'base64url');
  const data = Buffer.from(parts[3], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Mask a secret for API responses, e.g. ••••ab12 */
export function secretHint(plainOrNull: string | null | undefined): string | null {
  if (!plainOrNull || plainOrNull.length < 4) return null;
  return `••••${plainOrNull.slice(-4)}`;
}
