import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { ValidationError } from '../../utils/errors';

export const PRODUCT_IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_IMAGE_MAX_DIMENSION = 1200;
export const PRODUCT_IMAGE_TARGET_MAX_BYTES = 400 * 1024;

const ALLOWED_INPUT_MIME = /^image\/(jpeg|png|webp)$/i;

export type CompressedProductImage = {
  buffer: Buffer;
  width: number;
  height: number;
  mimeType: 'image/jpeg';
  sizeBytes: number;
};

function localUploadRoot(): string {
  if (process.env.VERCEL === '1') {
    return path.join('/tmp', 'fitnix-uploads', 'products');
  }
  return path.join(process.cwd(), 'uploads', 'products');
}

function useBlobStorage(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim());
}

export function assertAllowedProductImageMime(mimetype: string): void {
  if (!ALLOWED_INPUT_MIME.test(mimetype)) {
    throw new ValidationError('Only JPEG, PNG, and WebP images are allowed for product images');
  }
}

export async function compressProductImage(input: Buffer): Promise<CompressedProductImage> {
  if (!input?.length) {
    throw new ValidationError('Uploaded image file is empty');
  }

  let pipeline = sharp(input, { failOn: 'none' }).rotate();
  const meta = await pipeline.metadata();
  const width = meta.width ?? PRODUCT_IMAGE_MAX_DIMENSION;
  const height = meta.height ?? PRODUCT_IMAGE_MAX_DIMENSION;

  if (width > PRODUCT_IMAGE_MAX_DIMENSION || height > PRODUCT_IMAGE_MAX_DIMENSION) {
    pipeline = pipeline.resize({
      width: PRODUCT_IMAGE_MAX_DIMENSION,
      height: PRODUCT_IMAGE_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    });
  }

  const qualities = [82, 74, 66, 58];
  let best: CompressedProductImage | null = null;

  for (const quality of qualities) {
    const buffer = await pipeline
      .clone()
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer();
    const info = await sharp(buffer).metadata();
    const candidate: CompressedProductImage = {
      buffer,
      width: info.width ?? 0,
      height: info.height ?? 0,
      mimeType: 'image/jpeg',
      sizeBytes: buffer.length,
    };
    best = candidate;
    if (buffer.length <= PRODUCT_IMAGE_TARGET_MAX_BYTES) {
      return candidate;
    }
  }

  if (!best) {
    throw new ValidationError('Could not compress product image');
  }
  return best;
}

export async function storeProductImage(
  compressed: CompressedProductImage,
  gymId: number
): Promise<string> {
  const filename = `${randomUUID()}.jpg`;
  const blobPath = `products/${gymId}/${filename}`;

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
      'Failed to store image: configure BLOB_READ_WRITE_TOKEN (Vercel Blob) for product image uploads in production'
    );
  }

  const dir = localUploadRoot();
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, compressed.buffer);
  return `/uploads/products/${filename}`;
}

export async function deleteStoredProductImage(imageUrl: string | null | undefined): Promise<void> {
  if (!imageUrl) return;

  try {
    if (useBlobStorage() && /^https?:\/\//i.test(imageUrl)) {
      const { del } = await import('@vercel/blob');
      await del(imageUrl);
      return;
    }

    const localPrefix = '/uploads/products/';
    if (imageUrl.startsWith(localPrefix)) {
      const filename = path.basename(imageUrl);
      if (!/^[a-zA-Z0-9._-]+\.jpe?g$/i.test(filename)) return;
      const fullPath = path.join(localUploadRoot(), filename);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
  } catch {
    // Non-fatal
  }
}

export function resolveLocalProductImagePath(imageUrl: string): string | null {
  const localPrefix = '/uploads/products/';
  if (!imageUrl.startsWith(localPrefix)) return null;
  const filename = path.basename(imageUrl);
  if (!/^[a-zA-Z0-9._-]+\.jpe?g$/i.test(filename)) return null;
  const fullPath = path.join(localUploadRoot(), filename);
  return fs.existsSync(fullPath) ? fullPath : null;
}
