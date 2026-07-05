import { Response } from 'express';
import { AppError } from './errors';
import { serializeBigInt } from './serializeBigInt';

export interface SuccessResponse<T = any> {
  success: true;
  data: T;
  message?: string;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
    /** Flattened multi-line troubleshooting text (tablet/dashboard) */
    diagnosticText?: string;
  };
}

export function sendSuccess<T>(
  res: Response,
  data: T,
  message?: string,
  statusCode: number = 200
): Response {
  // Prevent caching
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  
  const response: SuccessResponse<T> = {
    success: true,
    data: serializeBigInt(data),
    ...(message && { message }),
  };
  return res.status(statusCode).json(response);
}

export function sendError(
  res: Response,
  error: AppError | Error
): Response {
  if (error instanceof AppError) {
    const diagnostic = error.details?.diagnostic as { diagnosticText?: string } | undefined;
    const response: ErrorResponse = {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && { details: serializeBigInt(error.details) }),
        ...(diagnostic?.diagnosticText && { diagnosticText: diagnostic.diagnosticText }),
      },
    };
    return res.status(error.statusCode).json(response);
  }

  // Unknown error
  const response: ErrorResponse = {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: error.message || 'An unexpected error occurred',
    },
  };
  return res.status(500).json(response);
}

