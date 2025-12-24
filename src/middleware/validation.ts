import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from '../utils/errors';
import { sendError } from '../utils/response';

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      
      // Store transformed values back to request object
      if (result.body) req.body = result.body;
      if (result.query) req.query = result.query as any;
      if (result.params) req.params = result.params;
      
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const details = error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        }));
        sendError(res, new ValidationError('Validation failed', details));
        return;
      }
      next(error);
    }
  };
}

