import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { ValidationError } from '../utils/errors';

/** Hard cap for stored member portraits (storage cost control). */
export const MEMBER_PHOTO_TARGET_MAX_BYTES = 50 * 1024;

/** Max edge length after resize — face remains identifiable at ~50KB JPEG. */
export const MEMBER_PHOTO_MAX_DIMENSION = 480;

/** Lowest JPEG quality we will use while trying to hit the size budget. */
export const MEMBER_PHOTO_MIN_QUALITY = 48;

/** Incoming camera / gallery files can be large before compression. */
export const MEMBER_PHOTO_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

const ALLOWED_INPUT_MIME = /^image\/(jpeg|png|webp)$/i;

export type CompressedMemberPhoto = {
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: 'image/jpeg';
  sizeBytes: number;
};

function localUploadRoot(): string {
  if (process.env.VERCEL === '1') {
    return path.join('/tmp', 'fitnix-uploads', 'members');
  }
  return path.join(process.cwd(), 'uploads', 'members');
}

export function useBlobStorage(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

/**
 * Resize + JPEG-compress a portrait toward ~50KB while keeping a recognizable face.
 * Always outputs JPEG for consistent size and storage.
 */
export async function compressMemberPhoto(input: Buffer): Promise<CompressedMemberPhoto> {
  if (!input?.length) {
    throw new ValidationError('Uploaded photo file is empty');
  }

  let pipeline = sharp(input, { failOn: 'none' }).rotate();
  const meta = await pipeline.metadata();

  const width = meta.width ?? MEMBER_PHOTO_MAX_DIMENSION;
  const height = meta.height ?? MEMBER_PHOTO_MAX_DIMENSION;
  const needsResize = width > MEMBER_PHOTO_MAX_DIMENSION || height > MEMBER_PHOTO_MAX_DIMENSION;

  if (needsResize) {
    pipeline = pipeline.resize({
      width: MEMBER_PHOTO_MAX_DIMENSION,
      height: MEMBER_PHOTO_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  // Prefer quality that usually lands near the budget; step down if still large.
  const qualities = [72, 64, 56, MEMBER_PHOTO_MIN_QUALITY];
  let best: CompressedMemberPhoto | null = null;

  for (const quality of qualities) {
    const buffer = await pipeline
      .clone()
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer();

    const info = await sharp(buffer).metadata();
    const candidate: CompressedMemberPhoto = {
      buffer,
      width: info.width ?? 0,
      height: info.height ?? 0,
      mimeType: 'image/jpeg',
      sizeBytes: buffer.length,
    };
    best = candidate;
    if (buffer.length <= MEMBER_PHOTO_TARGET_MAX_BYTES) {
      return candidate;
    }
  }

  // Still over budget: shrink dimensions further and retry at min quality.
  for (const dim of [360, 280, 220]) {
    const buffer = await sharp(input, { failOn: 'none' })
      .rotate()
      .resize({
        width: dim,
        height: dim,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: MEMBER_PHOTO_MIN_QUALITY, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer();

    const info = await sharp(buffer).metadata();
    const candidate: CompressedMemberPhoto = {
      buffer,
      width: info.width ?? 0,
      height: info.height ?? 0,
      mimeType: 'image/jpeg',
      sizeBytes: buffer.length,
    };
    best = candidate;
    if (buffer.length <= MEMBER_PHOTO_TARGET_MAX_BYTES) {
      return candidate;
    }
  }

  if (!best) {
    throw new ValidationError('Could not compress member photo');
  }

  // Accept best effort if still slightly over — rare for face crops at 220px.
  if (best.sizeBytes > MEMBER_PHOTO_TARGET_MAX_BYTES * 1.4) {
    throw new ValidationError(
      `Photo could not be compressed under ~${MEMBER_PHOTO_TARGET_MAX_BYTES / 1024}KB. Crop closer to the face and try again.`
    );
  }

  return best;
}

export function assertAllowedMemberPhotoMime(mimetype: string): void {
  if (!ALLOWED_INPUT_MIME.test(mimetype)) {
    throw new ValidationError('Only JPEG, PNG, and WebP images are allowed for member photos');
  }
}

/**
 * Persist a compressed member photo. Returns URL for `Member.photoUrl`.
 */
export async function storeMemberPhoto(
  compressed: CompressedMemberPhoto,
  gymId: number
): Promise<string> {
  const filename = `${randomUUID()}.jpg`;
  const blobPath = `members/${gymId}/${filename}`;

  if (useBlobStorage()) {
    const { put } = await import('@vercel/blob');
    const blob = await put(blobPath, compressed.buffer, {
      access: 'public',
      contentType: compressed.mimeType,
    });
    return blob.url;
  }

  if (process.env.VERCEL === '1') {
    throw new Error(
      'Failed to store image: configure BLOB_READ_WRITE_TOKEN (Vercel Blob) for member photo uploads in production'
    );
  }

  const dir = localUploadRoot();
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, compressed.buffer);
  return `/uploads/members/${filename}`;
}

/** Best-effort delete of a previously stored member photo (ignores missing files). */
export async function deleteStoredMemberPhoto(photoUrl: string | null | undefined): Promise<void> {
  if (!photoUrl) return;

  try {
    if (useBlobStorage() && /^https?:\/\//i.test(photoUrl)) {
      const { del } = await import('@vercel/blob');
      await del(photoUrl);
      return;
    }

    const localPrefix = '/uploads/members/';
    if (photoUrl.startsWith(localPrefix)) {
      const filename = path.basename(photoUrl);
      if (!/^[a-zA-Z0-9._-]+\.jpe?g$/i.test(filename)) return;
      const fullPath = path.join(localUploadRoot(), filename);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch {
    // Non-fatal: orphaned blobs are acceptable vs failing the API write.
  }
}

export function isMemberPhotoUrl(value: string): boolean {
  return (
    /^https?:\/\/.+/i.test(value) || /^\/uploads\/members\/[a-zA-Z0-9._-]+$/i.test(value)
  );
}
