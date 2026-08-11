import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { useBlobStorage } from '../logoStorageService';
import { AppError } from '../../utils/errors';

function extForMime(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  return '.png';
}

function localMarketingUploadRoot(): string {
  if (process.env.VERCEL === '1') {
    return path.join('/tmp', 'fitnix-uploads', 'marketing');
  }
  return path.join(process.cwd(), 'uploads', 'marketing');
}

/** Store a generated marketing image; returns public URL (Blob or local path). */
export async function storeMarketingImageFile(params: {
  gymId: number;
  contentId: number;
  buffer: Buffer;
  mimeType: string;
}): Promise<string> {
  const ext = extForMime(params.mimeType);
  const filename = `${randomUUID()}${ext}`;
  const blobPath = `marketing/${params.gymId}/${params.contentId}/${filename}`;

  if (useBlobStorage()) {
    const { put } = await import('@vercel/blob');
    const blob = await put(blobPath, params.buffer, {
      access: 'public',
      contentType: params.mimeType || 'image/png',
    });
    return blob.url;
  }

  if (process.env.VERCEL === '1') {
    throw new AppError(
      'STORAGE_NOT_CONFIGURED',
      'BLOB_READ_WRITE_TOKEN is required for marketing image storage on Vercel',
      503
    );
  }

  const dir = path.join(localMarketingUploadRoot(), String(params.gymId), String(params.contentId));
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, params.buffer);
  return `/uploads/marketing/${params.gymId}/${params.contentId}/${filename}`;
}
