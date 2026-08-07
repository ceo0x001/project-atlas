import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates request payloads with Zod.
 *
 * Chosen over class-validator so that request schemas and the environment schema use
 * one validation library, and so a DTO is a plain inferred type rather than a class
 * whose decorators must be kept in step with its fields.
 *
 * Reports every problem at once. A sync batch rejected one field at a time would
 * cost a mobile client on a flaky Nigerian 4G connection one round trip per mistake.
 */
export class ZodValidationPipe<TSchema extends ZodType> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): TSchema['_output'] {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        message: 'Request validation failed',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}
