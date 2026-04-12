import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import { HTTPException } from 'hono/http-exception'

import { createApp, createServer } from './mod.ts'

describe('createServer', () => {
  it('keeps createApp as a backward-compatible alias', () => {
    expect(createApp).toBe(createServer)
  })

  it('serves the health check under the function base path', async () => {
    const app = createServer('svc', { showRoutes: false })

    const response = await app.request('/svc/health')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.service).toBe('svc')
    expect(typeof body.timestamp).toBe('string')
  })

  it('supports a custom health check path and preflight response', async () => {
    const app = createServer('svc', {
      showRoutes: false,
      healthCheckPath: '/healthz',
    })

    const getResponse = await app.request('/svc/healthz')
    const optionsResponse = await app.request('/svc/healthz', { method: 'OPTIONS' })

    expect(getResponse.status).toBe(200)
    expect(optionsResponse.status).toBe(204)
  })

  it('omits the health route when health checks are disabled', async () => {
    const app = createServer('svc', {
      showRoutes: false,
      healthCheck: false,
    })

    const response = await app.request('/svc/health')

    expect(response.status).toBe(404)
  })

  it('returns RFC 7807 responses for unexpected errors', async () => {
    const app = createServer('svc', { showRoutes: false })

    app.get('/boom', () => {
      throw new Error('kaboom')
    })

    const response = await app.request('/svc/boom')
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(response.headers.get('Content-Type')).toContain('application/problem+json')
    expect(body.title).toBe('Internal Server Error')
    expect(body.detail).toBe('Internal server error')
  })

  it('preserves HTTPException status and message when no custom response exists', async () => {
    const app = createServer('svc', { showRoutes: false })

    app.get('/teapot', () => {
      throw new HTTPException(418, { message: 'short and stout' })
    })

    const response = await app.request('/svc/teapot')
    const body = await response.json()

    expect(response.status).toBe(418)
    expect(body.detail).toBe('short and stout')
  })
})