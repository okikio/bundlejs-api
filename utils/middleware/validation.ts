/**
 * Validation middleware helpers that normalize schema failures into the repo's
 * RFC 7807 problem-details response shape.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { MiddlewareHandler, ValidationTargets } from 'hono'
import type { ValidationErrorDetail } from '@utils/response/schemas'

import { sValidator } from '@hono/standard-validator'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'

import { getLogger } from './correlation.ts'
import { internalServerError, validationFailed } from '@utils/response'

import { getDotPath } from '@standard-schema/utils'

/**
 * Creates a Hono validation middleware that always turns schema failures into
 * the repo's standard RFC 7807 validation response.
 *
 * This wrapper exists because validation failures can surface through two
 * different paths in this codebase:
 *
 * - normal Standard Schema failures returned by `sValidator`
 * - thrown `ZodError` instances that escape from transforms or nested schemas
 *
 * Callers get one predictable behavior either way: a 422 response with a
 * normalized `errors` array, plus correlated warning logs.
 *
 * @example Validate query parameters
 * ```ts
 * const QueryValidator = createValidator('query', QuerySchema)
 * app.get('/accounts', QueryValidator, handler)
 * ```
 *
 * @example Validate JSON bodies with Zod-backed transforms
 * ```ts
 * const BodyValidator = createValidator('json', BodySchema)
 * app.post('/accounts', BodyValidator, handler)
 * ```
 */
export function createValidator<
  T extends StandardSchemaV1,
  Target extends keyof ValidationTargets = keyof ValidationTargets
>(
  target: Target,
  schema: T,
): MiddlewareHandler {
  // Inner validator provided by @hono/standard-validator
  const validator = sValidator(target, schema, (result, c) => {
    if (!result.success) {
      const logger = getLogger(c)

      // Transform Standard Schema issues to validation error details
      const errors = toErrs(result.error)

      logger.warn('Validation failed', {
        target: String(target),
        path: c.req.path,
        error_count: errors.length,
        errors: errors.map((e) => `${e.field}: ${e.message}`),
      })

      // RFC 7807 validation error array
      return c.json(...validationFailed(c.req.path, errors))
    }
  })

  // Wrap the validator to catch thrown ZodErrors and convert them to 422s
  return async (c, next) => {
    try {
      // Important: await so we catch async rejections
      return await validator(c, next)
    } catch (err) {
      // If we already turned it into an HTTPException, let it bubble
      if (err instanceof HTTPException) {
        throw err
      }

      const logger = getLogger(c)

      // If a raw ZodError leaked out from inside a schema, treat it as a validation failure
      if (err instanceof ZodError) {
        const errors = err?.issues?.map(issue => ({
          field: (issue.path?.length ?? 0) > 0 ? issue.path.join('.') : '_root',
          message: issue.message,
        })) ?? []

        logger.warn('Validation failed (ZodError)', {
          target: String(target),
          path: c.req.path,
          error_count: errors.length,
          errors: errors.map((e) => `${e.field}: ${e.message}`),
        })

        return c.json(...validationFailed(c.req.path, errors))
      }

      // Anything else is a genuine server error → 500
      logger.error('Unexpected error in validation middleware', {
        path: c.req.path,
        target: String(target),
        error_name: err?.constructor?.name,
        message: err instanceof Error ? err.message : String(err),
      })

      return c.json(...internalServerError(c.req.path))
    }
  }
}

/**
 * Converts Standard Schema issues into the flat field/message entries used by
 * the shared validation error response helpers.
 *
 * This keeps boundary formatting in one place so middleware and handlers do not
 * need to know how nested schema paths are rendered for clients.
 */
export function toErrs(
  issues: StandardSchemaV1.Issue[] | readonly StandardSchemaV1.Issue[],
): ValidationErrorDetail[] {
  return issues.map<ValidationErrorDetail>((issue) => ({
    field: getDotPath(issue) ?? '_root',
    message: issue.message,
  }))
}
