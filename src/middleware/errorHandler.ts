import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors';
import { sendError } from '../utils/response';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof AppError) {
    sendError(res, err);
    return;
  }

  // Log unexpected errors
  console.error('Unexpected error:', err);

  // Send generic error response
  sendError(res, err);
}

