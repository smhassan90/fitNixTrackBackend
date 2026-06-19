import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../utils/errors';
import { sendError } from '../utils/response';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const name = file.originalname.toLowerCase();
    const ok =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'text/plain' ||
      name.endsWith('.csv');
    if (!ok) {
      cb(new ValidationError('Only CSV files are allowed. Save Excel as CSV before upload.'));
      return;
    }
    cb(null, true);
  },
});

export function uploadCsvSingle(fieldName = 'file') {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.single(fieldName)(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : 'File upload failed';
        sendError(res, new ValidationError(message));
        return;
      }
      next();
    });
  };
}

export function readUploadedCsv(req: { file?: Express.Multer.File; body?: { csv?: string } }): string {
  if (req.file?.buffer) {
    return req.file.buffer.toString('utf8');
  }
  if (typeof req.body?.csv === 'string' && req.body.csv.trim()) {
    return req.body.csv;
  }
  throw new ValidationError('CSV file is required (field name: file) or provide body.csv text');
}
