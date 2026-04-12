import { expect } from '@std/expect'
import { describe, test } from '@std/testing/bdd'
import { Hono } from 'hono'

import Definition from './definition.ts'
import Handler from './handler.ts'

function createApp() {
	const app = new Hono()
	app.get(Definition.Route, Handler)
	return app
}

describe('static handler', () => {
	test('serves the OpenAPI document from the public directory', async () => {
		const app = createApp()

		const response = await app.request('http://localhost/.well-known/openapi.yaml')

		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toContain('application/')
		expect(await response.text()).toContain('openapi: 3.0.0')
	})

	test('returns 404 for the root path when no public index file exists', async () => {
		const app = createApp()

		const response = await app.request('http://localhost/')

		expect(response.status).toBe(404)
		expect(await response.text()).toContain('404 Not Found')
	})
})