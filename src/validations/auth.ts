import { z } from 'zod';

export const loginSchema = z.object({
  body: z.object({
    email: z.string().email('Invalid email format'),
    password: z.string().min(1, 'Password is required'),
  }),
});

export const meSchema = z.object({
  params: z.object({}),
  query: z.object({}),
  body: z.object({}),
});

