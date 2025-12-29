import { Request, Response, NextFunction } from 'express';
import { AppError, DatabaseConnectionError } from '../utils/errors';
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

  // Handle Prisma database connection errors
  const prismaError = err as any;
  if (
    prismaError?.code === 'P1001' || // Can't reach database server
    prismaError?.code === 'P1017' || // Server has closed the connection
    prismaError?.message?.includes("Can't reach database server") ||
    prismaError?.message?.includes('connection') ||
    prismaError?.message?.includes('timeout')
  ) {
    const dbError = new DatabaseConnectionError(
      'Unable to connect to the database. Please check your database connection settings and ensure the database server is running.',
      {
        code: prismaError?.code,
        originalMessage: prismaError?.message,
      }
    );
    sendError(res, dbError);
    return;
  }

  // Log unexpected errors
  console.error('Unexpected error:', err);

  // Send generic error response
  sendError(res, err);
}

