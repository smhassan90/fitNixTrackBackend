import multer from 'multer';
import type { FileFilterCallback } from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../utils/errors';
import { sendError } from '../utils/response';
import {
  PRODUCT_IMAGE_UPLOAD_MAX_BYTES,
  assertAllowedProductImageMime,
} from '../services/pos/posProductImageService';
import { PRODUCT_GALLERY_MAX_IMAGES } from '../services/pos/posProductGalleryService';

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  try {
    assertAllowedProductImageMime(file.mimetype);
    cb(null, true);
  } catch (err) {
    cb(err instanceof Error ? err : new ValidationError('Invalid image type'));
  }
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PRODUCT_IMAGE_UPLOAD_MAX_BYTES },
  fileFilter,
});

function handleMulterError(err: unknown, res: Response): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : 'Upload failed';
  if (/file too large|LIMIT_FILE_SIZE/i.test(msg) || (err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
    sendError(
      res,
      new ValidationError(
        `Image must be under ${Math.round(PRODUCT_IMAGE_UPLOAD_MAX_BYTES / (1024 * 1024))}MB before compression`
      )
    );
    return true;
  }
  sendError(res, new ValidationError(msg));
  return true;
}

/**
 * Parse multipart field `image` (also accepts `photo` / `file`).
 * Max 5 MB raw; compressed before storage. Single file → req.file
 */
export function parseProductImageUpload(req: Request, res: Response, next: NextFunction): void {
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'photo', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])(req, res, (err: unknown) => {
    if (handleMulterError(err, res)) return;

    const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
    const file =
      files?.image?.[0] ?? files?.photo?.[0] ?? files?.file?.[0] ?? undefined;

    if (file) {
      (req as Request & { file?: Express.Multer.File }).file = file;
    }

    next();
  });
}

/**
 * Parse multipart gallery upload: `images` (preferred), or `image` / `photo` / `file`.
 * Up to 5 files total across fields → req.filesList
 * Optional text field `isFeatured` / `featured` = "true" → req.setFeatured
 */
export function parseProductGalleryUpload(req: Request, res: Response, next: NextFunction): void {
  upload.fields([
    { name: 'images', maxCount: PRODUCT_GALLERY_MAX_IMAGES },
    { name: 'image', maxCount: PRODUCT_GALLERY_MAX_IMAGES },
    { name: 'photo', maxCount: PRODUCT_GALLERY_MAX_IMAGES },
    { name: 'file', maxCount: PRODUCT_GALLERY_MAX_IMAGES },
  ])(req, res, (err: unknown) => {
    if (handleMulterError(err, res)) return;

    const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
    const collected = [
      ...(files?.images ?? []),
      ...(files?.image ?? []),
      ...(files?.photo ?? []),
      ...(files?.file ?? []),
    ];

    if (collected.length > PRODUCT_GALLERY_MAX_IMAGES) {
      sendError(
        res,
        new ValidationError(`You can upload at most ${PRODUCT_GALLERY_MAX_IMAGES} images at once`)
      );
      return;
    }

    const body = req.body as { isFeatured?: string; featured?: string };
    const featuredRaw = String(body?.isFeatured ?? body?.featured ?? '').toLowerCase();
    const setFeatured = featuredRaw === 'true' || featuredRaw === '1' || featuredRaw === 'yes';

    (req as Request & {
      filesList?: Express.Multer.File[];
      setFeatured?: boolean;
    }).filesList = collected;
    (req as Request & { setFeatured?: boolean }).setFeatured = setFeatured;

    next();
  });
}
