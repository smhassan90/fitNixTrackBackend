import multer from 'multer';
import type { FileFilterCallback } from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../utils/errors';
import { sendError } from '../utils/response';
import {
  MEMBER_PHOTO_UPLOAD_MAX_BYTES,
  assertAllowedMemberPhotoMime,
} from '../services/memberPhotoService';

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  try {
    assertAllowedMemberPhotoMime(file.mimetype);
    cb(null, true);
  } catch (err) {
    cb(err instanceof Error ? err : new ValidationError('Invalid image type'));
  }
};

/** Single required field `photo` (max 8 MB raw), held in memory then compressed + stored. */
export const memberPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEMBER_PHOTO_UPLOAD_MAX_BYTES },
  fileFilter,
});

/**
 * Parse multipart field `photo` into `req.file`.
 * Call before the route handler that compresses and saves.
 */
export function parseMemberPhotoUpload(req: Request, res: Response, next: NextFunction): void {
  memberPhotoUpload.single('photo')(req, res, (err: unknown) => {
    if (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      if (/file too large/i.test(msg)) {
        sendError(
          res,
          new ValidationError(
            `Photo must be under ${Math.round(MEMBER_PHOTO_UPLOAD_MAX_BYTES / (1024 * 1024))}MB before compression`
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
