/**
 * Request Correlation & Distributed Tracing for Hono + LogTape
 * 
 * Provides W3C Trace Context propagation and automatic log correlation for Hono.js APIs.
 * Implements W3C Trace Context (traceparent/tracestate headers) for distributed tracing
 * and integrates with LogTape's implicit context for automatic correlation ID injection.
 * 
 * Key responsibilities:
 * - Extract or generate W3C Trace Context from incoming requests
 * - Attach correlation IDs (requestId, traceId, spanId) to LogTape's implicit context
 * - Propagate trace context headers to downstream services
 * - Set response headers for client-side correlation
 * 
 * @see https://www.w3.org/TR/trace-context/
 * @see https://logtape.org/manual/contexts
 */

import type { Context } from 'hono'
import { getLogger as logtapeLogger, withContext } from '@logtape/logtape'

/**
 * Request correlation context carrying IDs for tracing across services.
 * 
 * These IDs follow W3C Trace Context specification and enable:
 * - End-to-end request tracing across service boundaries
 * - Log correlation within and across services
 * - Performance monitoring and debugging of distributed requests
 */
export interface RequestCorrelation {
  /** Unique identifier for this specific request (UUID format) */
  requestId: string
  
  /** 
   * Trace ID identifying the entire distributed transaction (32 hex chars).
   * All spans within the same trace share this ID.
   */
  traceId: string
  
  /**
   * Span ID for this service's portion of the trace (16 hex chars).
   * Each service generates a new span ID for its work.
   */
  spanId: string
  
  /**
   * Parent span ID if this request is part of a larger trace.
   * Used to build the parent-child relationship in distributed traces.
   */
  parentSpanId?: string
  
  /** ISO 8601 timestamp when the request entered this service */
  timestamp: string
}

/**
 * Variables attached to Hono context by correlation middleware.
 * Use type augmentation to add these to your app's Variables interface.
 */
export interface CorrelationVariables { 
  /** Extracted or generated correlation context */
  correlation: RequestCorrelation

  /** Service name */
  serviceName: string
  
  /** 
   * Headers to propagate trace context to downstream services.
   * Include these when making HTTP requests to other services.
   */
  traceHeaders: Headers
}

/**
 * Middleware to extract W3C Trace Context and attach correlation IDs to LogTape's implicit context.
 * 
 * This middleware MUST be applied early in the middleware stack (after secureHeaders, before auth).
 * 
 * It performs three key operations:
 * 1. Extracts or generates W3C Trace Context (traceId, spanId, parentSpanId)
 * 2. Attaches correlation IDs to LogTape's implicit context (all logs automatically include these)
 * 3. Sets up headers for propagating trace context to downstream services
 * 
 * After this middleware runs, all LogTape loggers will automatically include:
 * - request_id: Unique ID for this request
 * - trace_id: Distributed trace identifier
 * - span_id: This service's span in the trace
 * - parent_span_id: Parent span if this is part of a distributed trace
 * - service: Service name for identification
 * 
 * @param serviceName - Name of this service (used in logs and trace context)
 * @returns Hono middleware function
 * 
 * @example
 * ```typescript
 * // In createApp or your main app setup:
 * app.use('*', correlationMiddleware('likes-service'))
 * 
 * // Later in any handler:
 * import { getLogger } from '@logtape/logtape'
 * 
 * const logger = getLogger(['likes-service'])
 * logger.info`Processing request` 
 * // Automatically includes: request_id, trace_id, span_id, service
 * 
 * // Access raw correlation data if needed:
 * const correlation = getCorrelation(c)
 * console.log(correlation.traceId)
 * 
 * // Propagate to downstream services:
 * const headers = getPropagationHeaders(c)
 * await fetch('http://other-service/api', { headers })
 * ```
 */
export function correlationMiddleware(serviceName: string) {
  return async (c: Context, next: () => Promise<void>) => {
    const correlation = extractTraceContext(c)
    
    // Create headers for propagating trace context downstream
    // These follow W3C Trace Context format for interoperability
    const traceHeaders = new Headers()
    traceHeaders.set('x-request-id', correlation.requestId)
    traceHeaders.set(
      'traceparent',
      `00-${correlation.traceId}-${correlation.spanId}-01`
    )
    if (correlation.parentSpanId) {
      traceHeaders.set('tracestate', `parent=${correlation.parentSpanId}`)
    }

    // Attach to Hono context for handler access
    c.set('correlation', correlation)
    c.set('traceHeaders', traceHeaders)
    c.set('serviceName', serviceName)
    

    // Set response header so clients can correlate their requests with our logs
    c.header('X-Request-ID', correlation.requestId)

    // Use LogTape's implicit context to automatically inject correlation IDs
    // into all logs within this request scope (including nested function calls)
    await withContext({
      request_id: correlation.requestId,
      trace_id: correlation.traceId,
      span_id: correlation.spanId,
      ...(correlation.parentSpanId && { parent_span_id: correlation.parentSpanId }),
      service: serviceName,
    }, () => next())
  }
}

/**
 * Generate or extract W3C Trace Context from request headers.
 * 
 * Follows W3C Trace Context specification for distributed tracing:
 * https://w3c.github.io/trace-context/
 * 
 * **Priority order:**
 * 1. If client provides `traceparent` header, extract traceId and parentSpanId
 *    - Preserves distributed trace across service boundaries
 *    - Generates new spanId for this service's work
 * 2. If client provides `x-request-id` header, use it but generate new trace
 * 3. Otherwise, generate completely new trace context
 * 
 * **traceparent format:** `00-<trace-id>-<parent-span-id>-<flags>`
 * - Version: 00 (current W3C spec version)
 * - trace-id: 32 lowercase hex chars (128 bits)
 * - parent-span-id: 16 lowercase hex chars (64 bits)
 * - flags: 01 = sampled, 00 = not sampled
 * 
 * @param c - Hono context with request headers
 * @returns Correlation context for this request
 * 
 * @example
 * ```typescript
 * // Example incoming request with trace context:
 * // traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 * //              ^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^ ^^
 * //              |  trace-id (32 chars)              parent-span      flags
 * 
 * const correlation = extractTraceContext(c)
 * // Returns:
 * // {
 * //   requestId: "auto-generated-uuid",
 * //   traceId: "4bf92f3577b34da6a3ce929d0e0e4736",  // from header
 * //   spanId: "a1b2c3d4e5f67890",                   // generated for this service
 * //   parentSpanId: "00f067aa0ba902b7",             // from header
 * //   timestamp: "2025-01-14T12:34:56.789Z"
 * // }
 * ```
 */
export function extractTraceContext(c: Context): RequestCorrelation {
  const timestamp = new Date().toISOString()

  // Try to extract from W3C Trace Context header (traceparent)
  const traceparent = c.req.header('traceparent')

  if (traceparent) {
    try {
      // Parse: 00-<trace-id>-<parent-span-id>-<flags>
      const parts = traceparent.split('-')
      if (parts.length >= 4) {
        const [_version, traceId, parentSpanId, _flags] = parts
        return {
          requestId: c.req.header('x-request-id') || crypto.randomUUID(),
          traceId,
          spanId: generateSpanId(), // Generate new span for this service
          parentSpanId,
          timestamp,
        }
      }
    } catch {
      // Invalid traceparent format, fall through to generate new trace
    }
  }

  // No valid traceparent header, start a new trace
  const requestId = c.req.header('x-request-id') || crypto.randomUUID()
  const traceId = generateTraceId()

  return {
    requestId,
    traceId,
    spanId: generateSpanId(),
    timestamp,
  }
}

/**
 * Generate a 128-bit trace ID as a 32-character hex string.
 * 
 * W3C Trace Context requires trace IDs to be:
 * - 32 lowercase hexadecimal characters
 * - 128 bits (16 bytes) of randomness
 * - Non-zero (all zeros is invalid)
 * 
 * @returns 32-character hex string (e.g., "4bf92f3577b34da6a3ce929d0e0e4736")
 */
function generateTraceId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/**
 * Generate a 64-bit span ID as a 16-character hex string.
 * 
 * W3C Trace Context requires span IDs to be:
 * - 16 lowercase hexadecimal characters
 * - 64 bits (8 bytes) of randomness
 * - Non-zero (all zeros is invalid)
 * 
 * @returns 16-character hex string (e.g., "00f067aa0ba902b7")
 */
function generateSpanId(): string {
  return Math.random().toString(16).substring(2, 18).padEnd(16, '0')
}

/**
 * Helper to extract correlation context from Hono context.
 * 
 * Provides type-safe access to correlation IDs after correlationMiddleware runs.
 * Useful when you need raw access to trace IDs (e.g., for custom integrations).
 * 
 * @param c - Hono context
 * @returns Correlation context containing request/trace/span IDs
 * 
 * @example
 * ```typescript
 * export const handler = (c) => {
 *   const correlation = getCorrelation(c)
 *   
 *   // Use in custom integrations
 *   await sendToMetrics({
 *     traceId: correlation.traceId,
 *     spanId: correlation.spanId,
 *     // ...
 *   })
 * }
 * ```
 */
export function getCorrelation(c: Context): RequestCorrelation {
  return c.get('correlation') as RequestCorrelation
}

/**
 * Helper to extract logger from Hono context
 * 
 * Provides type-safe logger access in handlers after correlationMiddleware.
 * 
 * @param c - Hono context
 * @returns Logger instance
 * 
 * @example
 * export const handler: EndpointHandler = (c) => {
 *   const logger = getLogger(c)
 *   logger.info('Processing request')
 * }
 */
export function getLogger(c: Context, categories?: Parameters<typeof logtapeLogger>[0]) {
  const serviceName: string = c.get('serviceName')
  if (typeof categories === "string")
    return logtapeLogger(["service", serviceName, categories])
  else if (Array.isArray(categories))
    return logtapeLogger(["service", serviceName, ...categories])
  return logtapeLogger(["service", serviceName])
}


/**
 * Helper to get headers for propagating trace context to downstream services.
 * 
 * Returns headers that include:
 * - `x-request-id`: Request identifier for correlation
 * - `traceparent`: W3C Trace Context header with trace/span IDs
 * - `tracestate`: Optional vendor-specific trace state
 * 
 * Include these headers when making HTTP requests to other services to maintain
 * trace continuity across service boundaries.
 * 
 * @param c - Hono context
 * @returns Headers object ready to use in fetch/HTTP clients
 * 
 * @example
 * ```typescript
 * // Propagate trace context to downstream service
 * export const handler = async (c) => {
 *   const headers = getPropagationHeaders(c)
 *   
 *   const response = await fetch('http://other-service/api/data', {
 *     headers: {
 *       ...headers,
 *       'Authorization': `Bearer ${token}`,
 *       'Content-Type': 'application/json',
 *     }
 *   })
 *   
 *   // The downstream service can now:
 *   // 1. Extract the traceparent header to continue the trace
 *   // 2. See this request as a child span in distributed tracing tools
 *   // 3. Correlate its logs with this service's logs via trace_id
 * }
 * ```
 */
export function getPropagationHeaders(c: Context): Record<string, string> {
  const traceHeaders = c.get('traceHeaders') as Headers
  const headers: Record<string, string> = {}

  traceHeaders?.forEach((value, key) => {
    headers[key] = value
  })

  return headers
}