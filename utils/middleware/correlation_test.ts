import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import { Hono } from 'hono'

import {
  correlationMiddleware,
  extractTraceContext,
  getCorrelation,
  getPropagationHeaders,
} from './correlation.ts'

describe('extractTraceContext', () => {
  it('continues an incoming W3C trace context when traceparent is present', async () => {
    const app = new Hono()

    app.get('/trace', (c) => c.json(extractTraceContext(c)))

    const response = await app.request('/trace', {
      headers: {
        'traceparent': '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'x-request-id': 'req_123',
      },
    })
    const body = await response.json()

    expect(body.requestId).toBe('req_123')
    expect(body.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    expect(body.parentSpanId).toBe('00f067aa0ba902b7')
    expect(typeof body.spanId).toBe('string')
    expect(body.spanId).toHaveLength(16)
  })
})

describe('correlationMiddleware', () => {
  it('attaches correlation data and downstream propagation headers', async () => {
    const app = new Hono()

    app.use('*', correlationMiddleware('billing-service'))
    app.get('/trace', (c) => c.json({
      correlation: getCorrelation(c),
      headers: getPropagationHeaders(c),
    }))

    const response = await app.request('/trace')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Request-ID')).toBe(body.correlation.requestId)
    expect(body.headers['x-request-id']).toBe(body.correlation.requestId)
    expect(body.headers.traceparent).toContain(body.correlation.traceId)
    expect(body.headers.traceparent).toContain(body.correlation.spanId)
  })
})