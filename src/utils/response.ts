import { Response } from 'express';
import { AppError } from './errors';

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
    data,
    ...(message && { message }),
  };
  return res.status(statusCode).json(response);
}

export function sendError(
  res: Response,
  error: AppError | Error
): Response {
  if (error instanceof AppError) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details && { details: error.details }),
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

