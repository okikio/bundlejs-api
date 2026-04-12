// utils/response/errors_test.ts
/**
 * Comprehensive unit tests for error response utilities
 *
 * Test Structure (Effect-TS inspired - precise behavioral contracts):
 * 
 * 1. PROBLEM DETAILS CONSTRUCTION
 *    - baseProblem() - RFC 7807 compliance
 *    - Return tuple structure
 * 
 * 2. CONVENIENCE FACTORIES
 *    - All status-specific factories (badRequest, notFound, etc.)
 *    - Factories with required extensions (methodNotAllowed, rateLimitExceeded)
 * 
 * 3. MULTI-ERROR RESPONSES
 *    - validationFailed() - 422 with field errors
 *    - errs() - generic multi-error builder
 * 
 * 4. TYPE GUARDS AND HELPERS
 *    - isErrorResponse() - discriminates error from success
 *    - exception() - HTTPException wrapper
 *    - extraProblemHeaders() - additional headers for certain statuses
 */

import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import {
  baseProblem,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  methodNotAllowed,
  notAcceptable,
  requestTimeout,
  conflict,
  gone,
  preconditionFailed,
  payloadTooLarge,
  uriTooLong,
  unsupportedMediaType,
  rangeNotSatisfiable,
  unprocessableEntity,
  preconditionRequired,
  rateLimitExceeded,
  requestHeaderFieldsTooLarge,
  unavailableForLegalReasons,
  internalServerError,
  notImplemented,
  badGateway,
  serviceUnavailable,
  gatewayTimeout,
  err,
  errs,
  validationFailed,
  isErrorResponse,
  exception,
  extraProblemHeaders,
  ERROR_TYPES,
  ERROR_DOCS,
  STATUS_TITLES,
  titleFor,
} from './errors.ts'

import { ok, paginate } from './success.ts'
import type { ErrorResult, ValidationErrorDetail } from './schemas.ts'

// ============================================================================
// TEST FIXTURES
// ============================================================================

const TEST_INSTANCE = '/api/test/123'

function makeValidationErrors(count: number): ValidationErrorDetail[] {
  return Array.from({ length: count }, (_, i) => ({
    field: `field${i}`,
    message: `Error message ${i}`
  }))
}

// ============================================================================
// 1. PROBLEM DETAILS CONSTRUCTION
// ============================================================================

describe('baseProblem', () => {
  describe('RFC 7807 compliance', () => {
    it('includes type URI', () => {
      const [body] = baseProblem(400, ERROR_TYPES.BAD_REQUEST, TEST_INSTANCE, 'Test error')

      expect(body.type).toBe(ERROR_TYPES.BAD_REQUEST)
    })

    it('includes title from STATUS_TITLES', () => {
      const [body] = baseProblem(404, ERROR_TYPES.NOT_FOUND, TEST_INSTANCE, 'Test error')

      expect(body.title).toBe('Not Found')
    })

    it('includes status code', () => {
      const [body] = baseProblem(500, ERROR_TYPES.INTERNAL_SERVER_ERROR, TEST_INSTANCE, 'Test error')

      expect(body.status).toBe(500)
    })

    it('includes detail message', () => {
      const [body] = baseProblem(400, ERROR_TYPES.BAD_REQUEST, TEST_INSTANCE, 'Custom detail message')

      expect(body.detail).toBe('Custom detail message')
    })

    it('includes instance (request path)', () => {
      const [body] = baseProblem(400, ERROR_TYPES.BAD_REQUEST, '/api/users/456', 'Test error')

      expect(body.instance).toBe('/api/users/456')
    })

    it('includes timestamp', () => {
      const before = new Date()
      const [body] = baseProblem(400, ERROR_TYPES.BAD_REQUEST, TEST_INSTANCE, 'Test error')
      const after = new Date()

      expect(body.timestamp).toBeInstanceOf(Date)
      expect(body.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(body.timestamp.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('includes docs URL when provided', () => {
      const [body] = baseProblem(
        400,
        ERROR_TYPES.BAD_REQUEST,
        TEST_INSTANCE,
        'Test error',
        ERROR_DOCS.BAD_REQUEST
      )

      expect(body.docs).toBe(ERROR_DOCS.BAD_REQUEST)
    })

    it('omits docs when not provided', () => {
      const [body] = baseProblem(400, ERROR_TYPES.BAD_REQUEST, TEST_INSTANCE, 'Test error')

      expect(body.docs).toBeUndefined()
    })

    it('includes extensions when provided', () => {
      const [body] = baseProblem(
        400,
        ERROR_TYPES.BAD_REQUEST,
        TEST_INSTANCE,
        'Test error',
        undefined,
        { customField: 'custom value', count: 42 }
      )

      expect((body as Record<string, unknown>).customField).toBe('custom value')
      expect((body as Record<string, unknown>).count).toBe(42)
    })
  })

  describe('return tuple structure', () => {
    it('returns [body, status, headers] tuple', () => {
      const result = baseProblem(400, ERROR_TYPES.BAD_REQUEST, TEST_INSTANCE, 'Test error')

      expect(result).toHaveLength(3)
      expect(typeof result[0]).toBe('object')
      expect(result[1]).toBe(400)
      expect(typeof result[2]).toBe('object')
    })

    it('sets Content-Type to application/problem+json', () => {
      const [, , headers] = baseProblem(400, ERROR_TYPES.BAD_REQUEST, TEST_INSTANCE, 'Test error')

      expect(headers['Content-Type']).toBe('application/problem+json')
    })
  })
})

describe('titleFor', () => {
  it('returns title for known status', () => {
    expect(titleFor(200)).toBe('OK')
    expect(titleFor(404)).toBe('Not Found')
    expect(titleFor(500)).toBe('Internal Server Error')
  })

  it('returns "Error" for unknown status', () => {
    expect(titleFor(999)).toBe('Error')
  })
})

// ============================================================================
// 2. CONVENIENCE FACTORIES
// ============================================================================

describe('convenience error factories', () => {
  // All factories follow the same pattern as baseProblem()
  // We test the pattern once thoroughly, then spot-check representatives

  describe('factory pattern verification', () => {
    // Test that all factories return the expected tuple structure
    const allFactories = [
      { fn: badRequest, status: 400 },
      { fn: unauthorized, status: 401 },
      { fn: forbidden, status: 403 },
      { fn: notFound, status: 404 },
      { fn: notAcceptable, status: 406 },
      { fn: requestTimeout, status: 408 },
      { fn: conflict, status: 409 },
      { fn: gone, status: 410 },
      { fn: preconditionFailed, status: 412 },
      { fn: uriTooLong, status: 414 },
      { fn: rangeNotSatisfiable, status: 416 },
      { fn: unprocessableEntity, status: 422 },
      { fn: preconditionRequired, status: 428 },
      { fn: requestHeaderFieldsTooLarge, status: 431 },
      { fn: unavailableForLegalReasons, status: 451 },
      { fn: internalServerError, status: 500 },
      { fn: notImplemented, status: 501 },
      { fn: badGateway, status: 502 },
      { fn: gatewayTimeout, status: 504 },
    ] as const

    it('all factories return correct status codes', () => {
      allFactories.forEach(({ fn, status }) => {
        const [, resultStatus] = fn(TEST_INSTANCE, 'Test error')
        expect(resultStatus).toBe(status)
      })
    })

    it('all factories return [body, status, headers] tuple', () => {
      allFactories.forEach(({ fn }) => {
        const result = fn(TEST_INSTANCE, 'Test error')
        expect(result).toHaveLength(3)
        expect(result[2]['Content-Type']).toBe('application/problem+json')
      })
    })

    it('all factories include RFC 7807 required fields', () => {
      allFactories.forEach(({ fn }) => {
        const [body] = fn(TEST_INSTANCE, 'Test error')
        expect(body.type).toBeDefined()
        expect(body.title).toBeDefined()
        expect(body.status).toBeDefined()
        expect(body.detail).toBeDefined()
        expect(body.instance).toBeDefined()
      })
    })
  })

  describe('spot-check: client errors (4xx)', () => {
    it('badRequest (400) - common validation error', () => {
      const [body, status] = badRequest(TEST_INSTANCE, 'Invalid input')
      
      expect(status).toBe(400)
      expect(body.type).toBe(ERROR_TYPES.BAD_REQUEST)
      expect(body.title).toBe('Bad Request')
      expect(body.detail).toBe('Invalid input')
    })

    it('notFound (404) - resource not found', () => {
      const [body, status] = notFound('/api/users/999', 'User not found')
      
      expect(status).toBe(404)
      expect(body.instance).toBe('/api/users/999')
    })

    it('unprocessableEntity (422) - semantic validation', () => {
      const [body, status] = unprocessableEntity(TEST_INSTANCE, 'Email already exists')
      
      expect(status).toBe(422)
      expect(body.detail).toBe('Email already exists')
    })
  })

  describe('spot-check: server errors (5xx)', () => {
    it('internalServerError (500) - unexpected error', () => {
      const [body, status] = internalServerError(TEST_INSTANCE, 'Unexpected error')
      
      expect(status).toBe(500)
      expect(body.type).toBe(ERROR_TYPES.INTERNAL_SERVER_ERROR)
    })
  })

  describe('extensions support', () => {
    it('all factories accept extensions', () => {
      const [body] = badRequest(TEST_INSTANCE, 'Test', { customField: 'value' })
      expect((body as Record<string, unknown>).customField).toBe('value')
    })
  })
})

describe('factories with required extensions', () => {
  describe('methodNotAllowed', () => {
    it('returns status 405', () => {
      const [, status] = methodNotAllowed(TEST_INSTANCE, ['GET', 'POST'])
      expect(status).toBe(405)
    })

    it('includes allowed methods array in extensions', () => {
      const [body] = methodNotAllowed(TEST_INSTANCE, ['GET', 'POST', 'PUT'])
      expect((body as Record<string, unknown>).allowed).toEqual(['GET', 'POST', 'PUT'])
    })

    it('accepts custom detail message', () => {
      const [body] = methodNotAllowed(TEST_INSTANCE, ['GET'], 'DELETE not allowed here')
      expect(body.detail).toBe('DELETE not allowed here')
    })
  })

  describe('payloadTooLarge', () => {
    it('returns status 413', () => {
      const [, status] = payloadTooLarge(TEST_INSTANCE, 1024 * 1024)
      expect(status).toBe(413)
    })

    it('includes limitBytes in extensions', () => {
      const [body] = payloadTooLarge(TEST_INSTANCE, 5 * 1024 * 1024)
      expect((body as Record<string, unknown>).limitBytes).toBe(5 * 1024 * 1024)
    })

    it('works without limitBytes', () => {
      const [body, status] = payloadTooLarge(TEST_INSTANCE)
      expect(status).toBe(413)
      expect((body as Record<string, unknown>).limitBytes).toBeUndefined()
    })
  })

  describe('unsupportedMediaType', () => {
    it('returns status 415', () => {
      const [, status] = unsupportedMediaType(TEST_INSTANCE, ['application/json'])
      expect(status).toBe(415)
    })

    it('includes supported media types in extensions', () => {
      const [body] = unsupportedMediaType(TEST_INSTANCE, ['application/json', 'application/xml'])
      expect((body as Record<string, unknown>).supported).toEqual(['application/json', 'application/xml'])
    })
  })

  describe('rateLimitExceeded', () => {
    it('returns status 429', () => {
      const [, status] = rateLimitExceeded(TEST_INSTANCE, 60)
      expect(status).toBe(429)
    })

    it('includes retryAfter in extensions', () => {
      const [body] = rateLimitExceeded(TEST_INSTANCE, 120)
      expect((body as Record<string, unknown>).retryAfter).toBe(120)
    })

    it('includes retryAfter in detail message', () => {
      const [body] = rateLimitExceeded(TEST_INSTANCE, 60)
      expect(body.detail).toContain('60')
    })
  })

  describe('serviceUnavailable', () => {
    it('returns status 503', () => {
      const [, status] = serviceUnavailable(TEST_INSTANCE, 'database')
      expect(status).toBe(503)
    })

    it('includes service name in extensions', () => {
      const [body] = serviceUnavailable(TEST_INSTANCE, 'redis-cache')
      expect((body as Record<string, unknown>).service).toBe('redis-cache')
    })

    it('includes service in default detail message', () => {
      const [body] = serviceUnavailable(TEST_INSTANCE, 'payment-gateway')
      expect(body.detail).toContain('payment-gateway')
    })

    it('accepts custom detail message', () => {
      const [body] = serviceUnavailable(TEST_INSTANCE, 'db', 'Custom unavailable message')
      expect(body.detail).toBe('Custom unavailable message')
    })
  })
})

describe('err (generic factory)', () => {
  it('delegates to appropriate factory for known status', () => {
    const [body, status] = err(404, TEST_INSTANCE, 'Resource not found')

    expect(status).toBe(404)
    expect(body.type).toBe(ERROR_TYPES.NOT_FOUND)
    expect(body.title).toBe('Not Found')
  })

  it('handles 405 with empty allowed array', () => {
    const [body] = err(405, TEST_INSTANCE, 'Method not allowed')
    expect((body as Record<string, unknown>).allowed).toEqual([])
  })

  it('handles 429 with retryAfter from extensions', () => {
    const [body] = err(429, TEST_INSTANCE, 'Rate limited', { retryAfter: 30 })
    expect((body as Record<string, unknown>).retryAfter).toBe(30)
  })

  it('handles 429 with default retryAfter when not in extensions', () => {
    const [body] = err(429, TEST_INSTANCE, 'Rate limited')
    expect((body as Record<string, unknown>).retryAfter).toBe(60)
  })

  it('handles 503 with service from extensions', () => {
    const [body] = err(503, TEST_INSTANCE, 'Service down', { service: 'api' })
    expect((body as Record<string, unknown>).service).toBe('api')
  })

  it('handles unknown status with generic fallback', () => {
    const [body, status] = err(418 as any, TEST_INSTANCE, "I'm a teapot")

    expect(status).toBe(418)
    expect(body.detail).toBe("I'm a teapot")
  })
})

// ============================================================================
// 3. MULTI-ERROR RESPONSES
// ============================================================================

describe('validationFailed', () => {
  it('returns 422 status', () => {
    const [, status] = validationFailed(TEST_INSTANCE, makeValidationErrors(1))

    expect(status).toBe(422)
  })

  it('includes errors array', () => {
    const errors = makeValidationErrors(3)
    const [body] = validationFailed(TEST_INSTANCE, errors)

    expect(body.errors).toEqual(errors)
  })

  it('formats detail as "1 validation error occurred" for single error', () => {
    const [body] = validationFailed(TEST_INSTANCE, makeValidationErrors(1))

    expect(body.detail).toBe('1 validation error occurred')
  })

  it('formats detail as "X validation errors occurred" for multiple errors', () => {
    const [body] = validationFailed(TEST_INSTANCE, makeValidationErrors(5))

    expect(body.detail).toBe('5 validation errors occurred')
  })

  it('accepts custom detail message', () => {
    const [body] = validationFailed(TEST_INSTANCE, makeValidationErrors(1), 'Custom validation message')

    expect(body.detail).toBe('Custom validation message')
  })

  it('uses VALIDATION_ERROR type', () => {
    const [body] = validationFailed(TEST_INSTANCE, makeValidationErrors(1))

    expect(body.type).toBe(ERROR_TYPES.VALIDATION_ERROR)
  })

  it('handles empty validation errors array', () => {
    // Edge case: what happens with zero errors?
    // This documents actual behavior - may want to reject empty arrays
    const [body] = validationFailed(TEST_INSTANCE, [])

    expect(body.errors).toEqual([])
    expect(body.detail).toBe('0 validation errors occurred')
  })
})

describe('errs', () => {
  it('accepts custom status and type', () => {
    const errors = makeValidationErrors(2)
    const [body, status] = errs(
      ERROR_TYPES.BAD_REQUEST,
      'Bad Request',
      400,
      TEST_INSTANCE,
      errors
    )

    expect(status).toBe(400)
    expect(body.type).toBe(ERROR_TYPES.BAD_REQUEST)
  })

  it('includes all validation error details', () => {
    const errors = [
      { field: 'email', message: 'Invalid email format' },
      { field: 'password', message: 'Too short' },
      { field: 'age', message: 'Must be positive' }
    ]

    const [body] = errs(
      ERROR_TYPES.UNPROCESSABLE_ENTITY,
      'Unprocessable Entity',
      422,
      TEST_INSTANCE,
      errors
    )

    expect(body.errors).toEqual(errors)
  })

  it('uses default detail based on error count', () => {
    const [body] = errs(
      ERROR_TYPES.VALIDATION_ERROR,
      'Validation Error',
      422,
      TEST_INSTANCE,
      makeValidationErrors(3)
    )

    expect(body.detail).toBe('3 errors occurred')
  })

  it('accepts custom detail', () => {
    const [body] = errs(
      ERROR_TYPES.VALIDATION_ERROR,
      'Validation Error',
      422,
      TEST_INSTANCE,
      makeValidationErrors(1),
      'Custom detail'
    )

    expect(body.detail).toBe('Custom detail')
  })

  it('includes docs when provided', () => {
    const [body] = errs(
      ERROR_TYPES.VALIDATION_ERROR,
      'Validation Error',
      422,
      TEST_INSTANCE,
      makeValidationErrors(1),
      undefined,
      ERROR_DOCS.VALIDATION_ERROR
    )

    expect(body.docs).toBe(ERROR_DOCS.VALIDATION_ERROR)
  })
})

// ============================================================================
// 4. TYPE GUARDS AND HELPERS
// ============================================================================

describe('isErrorResponse', () => {
  it('returns true for error tuples (problem+json)', () => {
    const errorResult = badRequest(TEST_INSTANCE, 'Test error')

    expect(isErrorResponse(errorResult)).toBe(true)
  })

  it('returns false for success tuples (application/json)', () => {
    const successResult = ok({ id: '123' })

    expect(isErrorResponse(successResult)).toBe(false)
  })

  it('returns false for pagination results', () => {
    const paginationResult = paginate('/api/items', [{ id: '1' }], {
      hasMore: false,
      limit: 20,
      count: 1
    })

    expect(isErrorResponse(paginationResult)).toBe(false)
  })

  it('works with validationFailed results', () => {
    const validationResult = validationFailed(TEST_INSTANCE, makeValidationErrors(1))

    expect(isErrorResponse(validationResult)).toBe(true)
  })

  it('correctly narrows type', () => {
    const result: ErrorResult | ReturnType<typeof ok> = badRequest(TEST_INSTANCE, 'error')

    if (isErrorResponse(result)) {
      // TypeScript should know this is ErrorResult
      const [body, status] = result
      expect(body.type).toBeDefined()
      expect(status).toBe(400)
    }
  })
})

describe('exception', () => {
  it('creates HTTPException with problem details', () => {
    const errorResult = notFound(TEST_INSTANCE, 'Resource not found')
    const httpException = exception(errorResult)

    expect(httpException).toBeInstanceOf(Error)
    expect(httpException.status).toBe(404)
  })

  it('includes response with correct body', async () => {
    const errorResult = badRequest(TEST_INSTANCE, 'Invalid input')
    const httpException = exception(errorResult)

    // Explicitly verify response exists before accessing
    expect(httpException.res).toBeDefined()
    if (!httpException.res) {
      throw new Error('Expected HTTPException to have a response')
    }

    const body = await httpException.res.json()
    expect(body.type).toBe(ERROR_TYPES.BAD_REQUEST)
    expect(body.detail).toBe('Invalid input')
  })

  it('includes problem+json content type', () => {
    const errorResult = forbidden(TEST_INSTANCE, 'Access denied')
    const httpException = exception(errorResult)

    expect(httpException.res).toBeDefined()
    expect(httpException.res?.headers.get('Content-Type')).toBe('application/problem+json')
  })
})

describe('extraProblemHeaders', () => {
  it('returns Retry-After for 429 with retryAfter extension', () => {
    const headers = extraProblemHeaders(429, { retryAfter: 60 })

    expect(headers['Retry-After']).toBe('60')
  })

  it('returns Retry-After for 503 with retryAfter extension', () => {
    const headers = extraProblemHeaders(503, { retryAfter: 120 })

    expect(headers['Retry-After']).toBe('120')
  })

  it('returns empty object for 429 without retryAfter', () => {
    const headers = extraProblemHeaders(429, {})

    expect(headers).toEqual({})
  })

  it('returns empty object for other status codes', () => {
    const headers = extraProblemHeaders(400, { retryAfter: 60 })

    expect(headers).toEqual({})
  })

  it('returns empty object when no extensions', () => {
    const headers = extraProblemHeaders(500)

    expect(headers).toEqual({})
  })
})

// ============================================================================
// EDGE CASES
// ============================================================================

describe('edge cases', () => {
  describe('empty and special values', () => {
    it('handles empty detail message', () => {
      const [body] = badRequest(TEST_INSTANCE, '')

      expect(body.detail).toBe('')
    })

    it('handles empty instance', () => {
      const [body] = badRequest('', 'Test error')

      expect(body.instance).toBe('')
    })

    it('handles very long detail message', () => {
      const longMessage = 'x'.repeat(10000)
      const [body] = badRequest(TEST_INSTANCE, longMessage)

      expect(body.detail).toBe(longMessage)
    })
  })

  describe('special characters', () => {
    it('handles unicode in detail', () => {
      const [body] = badRequest(TEST_INSTANCE, '日本語エラーメッセージ 🚫')

      expect(body.detail).toBe('日本語エラーメッセージ 🚫')
    })

    it('handles special characters in instance', () => {
      const [body] = badRequest('/api/users?name=John%20Doe&filter[status]=active', 'Test')

      expect(body.instance).toBe('/api/users?name=John%20Doe&filter[status]=active')
    })
  })

  describe('extension edge cases', () => {
    it('handles null in extensions', () => {
      const [body] = badRequest(TEST_INSTANCE, 'Test', { nullField: null })

      expect((body as Record<string, unknown>).nullField).toBeNull()
    })

    it('handles nested objects in extensions', () => {
      const [body] = badRequest(TEST_INSTANCE, 'Test', {
        nested: { deep: { value: 42 } }
      })

      expect((body as Record<string, unknown>).nested).toEqual({ deep: { value: 42 } })
    })

    it('handles arrays in extensions', () => {
      const [body] = badRequest(TEST_INSTANCE, 'Test', {
        items: [1, 2, 3]
      })

      expect((body as Record<string, unknown>).items).toEqual([1, 2, 3])
    })
  })

  describe('validation errors edge cases', () => {
    it('handles empty errors array', () => {
      const [body] = validationFailed(TEST_INSTANCE, [])

      expect(body.errors).toEqual([])
      expect(body.detail).toBe('0 validation errors occurred')
    })

    it('handles many errors', () => {
      const errors = makeValidationErrors(100)
      const [body] = validationFailed(TEST_INSTANCE, errors)

      expect(body.errors).toHaveLength(100)
    })
  })
})