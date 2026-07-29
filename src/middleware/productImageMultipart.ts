import multer from 'multer';
import type { FileFilterCallback } from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../utils/errors';
import { sendError } from '../utils/response';
import {
  PRODUCT_IMAGE_UPLOAD_MAX_BYTES,
  assertAllowedProductImageMime,
} from '../services/pos/posProductImageService';

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

/**
 * Parse multipart field `image` (also accepts `photo` / `file`).
 * Max 5 MB raw; compressed before storage.
 */
export function parseProductImageUpload(req: Request, res: Response, next: NextFunction): void {
  upload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'photo', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])(req, res, (err: unknown) => {
    if (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      if (/file too large|LIMIT_FILE_SIZE/i.test(msg) || (err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
        sendError(
          res,
          new ValidationError(
            `Image must be under ${Math.round(PRODUCT_IMAGE_UPLOAD_MAX_BYTES / (1024 * 1024))}MB before compression`
          )
        );
        return;
      }
      sendError(res, new ValidationError(msg));
      return;
    }

    const files = req.files as { [field: string]: Express.Multer.File[] } | undefined;
    const file =
      files?.image?.[0] ?? files?.photo?.[0] ?? files?.file?.[0] ?? undefined;

    if (file) {
      (req as Request & { file?: Express.Multer.File }).file = file;
    }

    next();
  });
}
