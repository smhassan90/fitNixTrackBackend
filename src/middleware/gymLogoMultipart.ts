import multer from 'multer';
import type { FileFilterCallback } from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../utils/errors';
import { sendError, sendSuccess } from '../utils/response';
import { storeLogoFile } from '../services/logoStorageService';

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  if (/^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)) {
    cb(null, true);
    return;
  }
  cb(new ValidationError('Only JPEG, PNG, WebP, and GIF images are allowed'));
};

/** Single optional field `logo` (max 2 MB), held in memory then persisted via logo storage. */
export const gymLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter,
});

export function isMultipartRequest(req: Request): boolean {
  const ct = req.headers['content-type'] || '';
  return ct.toLowerCase().includes('multipart/form-data');
}

async function persistUploadedLogo(file: Express.Multer.File): Promise<string> {
  if (!file.buffer?.length) {
    throw new ValidationError('Uploaded logo file is empty');
  }
  try {
    return await storeLogoFile(file.buffer, file.originalname, file.mimetype);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.includes('Failed to store image')) {
      throw new Error(message);
    }
    throw new Error(`Failed to store image: ${message}`);
  }
}

/**
 * For `POST /api/platform/gyms` or `PATCH /api/platform/gyms/:id`:
 * - `application/json`: no-op (body already parsed).
 * - `multipart/form-data`: field `data` = JSON string (same shape as JSON body); optional file field `logo`.
 *   After parse, `req.body` is the JSON object; if `logo` was uploaded, `logoUrl` is set to the stored URL.
 */
export function parsePlatformGymMultipart(req: Request, res: Response, next: NextFunction): void {
  if (!isMultipartRequest(req)) {
    next();
    return;
  }

  gymLogoUpload.single('logo')(req, res, async (err: unknown) => {
    if (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      sendError(res, new ValidationError(msg));
      return;
    }
    try {
      const raw = req.body?.data;
      if (typeof raw !== 'string' || !raw.trim()) {
        sendError(
          res,
          new ValidationError(
            'Multipart requests must include a text field "data" containing JSON (same shape as the JSON API body).'
          )
        );
        return;
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object') {
        sendError(res, new ValidationError('Invalid JSON in field "data"'));
        return;
      }
      req.body = parsed;
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (file) {
        req.body.logoUrl = await persistUploadedLogo(file);
      }
      next();
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(res, error);
        return;
      }
      sendError(res, error as Error);
    }
  });
}

/** `POST /api/platform/upload/logo` — field `logo`, returns `{ url }`. */
export function handleLogoUpload(req: Request, res: Response): void {
  gymLogoUpload.single('logo')(req, res, async (err: unknown) => {
    if (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed';
      sendError(res, new ValidationError(msg));
      return;
    }
    try {
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) {
        sendError(res, new ValidationError('Missing file field "logo"'));
        return;
      }
      const url = await persistUploadedLogo(file);
      sendSuccess(res, { url }, 'Logo uploaded', 201);
    } catch (error) {
      if (error instanceof ValidationError) {
        sendError(res, error);
        return;
      }
      sendError(res, error as Error);
    }
  });
}
