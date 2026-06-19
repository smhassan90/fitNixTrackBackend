import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function localUploadRoot(): string {
  if (process.env.VERCEL === '1') {
    return path.join('/tmp', 'fitnix-uploads', 'logos');
  }
  return path.join(process.cwd(), 'uploads', 'logos');
}

export function useBlobStorage(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

export function safeLogoFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  const safe = ALLOWED_EXT.has(ext) ? ext : '.jpg';
  return `${randomUUID()}${safe}`;
}

/**
 * Persist a gym logo and return a URL suitable for `logoUrl` (https blob URL or `/uploads/logos/...`).
 * On Vercel, `BLOB_READ_WRITE_TOKEN` is required — local disk is ephemeral and not served reliably.
 */
export async function storeLogoFile(
  buffer: Buffer,
  originalName: string,
  mimetype: string
): Promise<string> {
  const filename = safeLogoFilename(originalName);

  if (useBlobStorage()) {
    const { put } = await import('@vercel/blob');
    const blob = await put(`logos/${filename}`, buffer, {
      access: 'public',
      contentType: mimetype,
    });
    return blob.url;
  }

  if (process.env.VERCEL === '1') {
    throw new Error(
      'Failed to store image: configure BLOB_READ_WRITE_TOKEN (Vercel Blob) for logo uploads in production'
    );
  }

  const dir = localUploadRoot();
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, buffer);
  return `/uploads/logos/${filename}`;
}
