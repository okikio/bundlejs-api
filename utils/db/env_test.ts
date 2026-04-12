import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import { parseDatabaseConfig, type DatabaseEnvInput } from './env.ts'

function makeDatabaseEnv(overrides: Partial<DatabaseEnvInput> = {}): DatabaseEnvInput {
	return Object.assign({
		DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/finance_app',
	}, overrides)
}

describe('parseDatabaseConfig', () => {
	it('normalizes the raw database env into a connection config', () => {
		const config = parseDatabaseConfig(makeDatabaseEnv({
			DATABASE_URL: '  postgresql://postgres:postgres@localhost:5432/custom_db  ',
		}))

		expect(config).toEqual({
			connectionString: 'postgresql://postgres:postgres@localhost:5432/custom_db',
		})
	})

	it('rejects a missing database connection string', () => {
		expect(() => parseDatabaseConfig(makeDatabaseEnv({ DATABASE_URL: undefined }))).toThrow(
			/DATABASE_URL is required/,
		)
	})
})