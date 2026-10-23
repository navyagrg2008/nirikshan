import { ZodType } from 'zod';
import { AppError } from './errors';

/** Validate untrusted input. Errors list the path and rule only, never the submitted value. */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw new AppError(422, 'VALIDATION_FAILED', {
    errors: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), code: i.code, message: i.message })),
  });
}
