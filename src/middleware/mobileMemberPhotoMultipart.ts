import multer from 'multer';
import type { FileFilterCallback } from 'multer';
import type { Request, Response, NextFunction } from 'express';
import {
  InvalidImageTypeError,
  PayloadTooLargeError,
  ValidationError,
} from '../utils/errors';
import { sendError } from '../utils/response';

/** Hard cap for mobile-uploaded portraits (client targets ≤50KB). */
export const MOBILE_MEMBER_PHOTO_MAX_BYTES = 100 * 1024;

const ALLOWED = /^image\/(jpeg|png|webp)$/i;

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  if (!ALLOWED.test(file.mimetype)) {
    cb(new InvalidImageTypeError('Only JPEG, PNG, and WebP images are allowed'));
    return;
  }
  cb(null, true);
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MOBILE_MEMBER_PHOTO_MAX_BYTES },
  fileFilter,
});

/**
 * Parse multipart field `photo` for mobile profile overwrite.
 * Max 100KB raw payload.
 */
export function parseMobileMemberPhotoUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single('photo')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof InvalidImageTypeError) {
        sendError(res, err);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Upload failed';
      if (/file too large|File too large|LIMIT_FILE_SIZE/i.test(msg) || (err as { code?: string }).code === 'LIMIT_FILE_SIZE') {
        sendError(
          res,
          new PayloadTooLargeError(
            `Photo must be under ${MOBILE_MEMBER_PHOTO_MAX_BYTES / 1024}KB`
          )
        );
        return;
      }
      sendError(res, new ValidationError(msg));
      return;
    }
    next();
  });
}
