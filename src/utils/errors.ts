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
  constructor(message: string, details?: any) {
    super('VALIDATION_ERROR', message, 400, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string | number) {
    super(
      'NOT_FOUND',
      id ? `${resource} with id ${id} not found` : `${resource} not found`,
      404
    );
    this.name = 'NotFoundError';
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Unauthorized') {
    super('UNAUTHORIZED', message, 401);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = 'Forbidden') {
    super('FORBIDDEN', message, 403);
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

