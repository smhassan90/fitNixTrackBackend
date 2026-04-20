import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import multer from 'multer';
import type { FileFilterCallback } from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../utils/errors';
import { sendError } from '../utils/response';

const UPLOAD_SUBDIR = path.join('uploads', 'logos');

function uploadRoot(): string {
  if (process.env.VERCEL === '1') {
    return path.join('/tmp', 'fitnix-uploads', 'logos');
  }
  return path.join(process.cwd(), UPLOAD_SUBDIR);
}

const allowedExt = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = uploadRoot();
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safe = allowedExt.has(ext) ? ext : '.dat';
    cb(null, `${randomUUID()}${safe}`);
  },
});

const fileFilter = (_req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
  if (/^image\/(jpeg|png|webp|gif)$/i.test(file.mimetype)) {
    cb(null, true);
    return;
  }
  cb(new ValidationError('Only JPEG, PNG, WebP, and GIF images are allowed'));
};

/** Single optional field `logo` (max 2 MB). */
export const gymLogoUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter,
});

export function isMultipartRequest(req: Request): boolean {
  const ct = req.headers['content-type'] || '';
  return ct.toLowerCase().includes('multipart/form-data');
}

/**
 * For `POST /api/platform/gyms` or `PATCH /api/platform/gyms/:id`:
 * - `application/json`: no-op (body already parsed).
 * - `multipart/form-data`: field `data` = JSON string (same shape as JSON body); optional file field `logo`.
 *   After parse, `req.body` is the JSON object; if `logo` was uploaded, `logoUrl` is set to `/uploads/logos/<file>`.
 */
export function parsePlatformGymMultipart(req: Request, res: Response, next: NextFunction): void {
  if (!isMultipartRequest(req)) {
    next();
    return;
  }

  gymLogoUpload.single('logo')(req, res, (err: unknown) => {
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
      if (file?.filename) {
        req.body.logoUrl = `/uploads/logos/${file.filename}`;
      }
      next();
    } catch {
      sendError(res, new ValidationError('Invalid JSON in field "data"'));
    }
  });
}
