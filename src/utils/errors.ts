export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number = 500,
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any, statusCode: number = 400) {
    super('VALIDATION_ERROR', message, statusCode, details);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: any) {
    super('CONFLICT', message, 409, details);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string | number, details?: any) {
    super(
      'NOT_FOUND',
      id ? `${resource} with id ${id} not found` : `${resource} not found`,
      404,
      details
    );
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized', details?: any) {
    super('UNAUTHORIZED', message, 401, details);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden', details?: any) {
    super('FORBIDDEN', message, 403, details);
    this.name = 'ForbiddenError';
  }
}

export class BadRequestError extends AppError {
  constructor(message: string, details?: any) {
    super('BAD_REQUEST', message, 400, details);
    this.name = 'BadRequestError';
  }
}

export class DatabaseConnectionError extends AppError {
  constructor(message: string = 'Database connection failed', details?: any) {
    super('DATABASE_CONNECTION_ERROR', message, 503, details);
    this.name = 'DatabaseConnectionError';
  }
}

