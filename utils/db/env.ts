import { z } from 'zod'
import { getEnv } from '@utils/env'

function blankStringToUndefined(input: unknown): unknown {
	if (typeof input !== 'string') {
		return input
	}

	const value = input.trim()
	return value === '' ? undefined : value
}

/** Raw database env shape before validation and normalization. */
export interface DatabaseEnvInput {
	/** PostgreSQL connection string used to create the shared Drizzle client. */
	DATABASE_URL: string | undefined
}

/** Structured database runtime config consumed by the shared client factory. */
export interface DatabaseConfig {
	/** Canonical PostgreSQL connection string after env normalization. */
	connectionString: string
}

/**
 * Reads database env values lazily so importing the DB package does not require
 * environment permissions until a caller actually asks for DB config.
 */
export function readDatabaseEnv(
	overrides: Partial<DatabaseEnvInput> = {},
): DatabaseEnvInput {
	return Object.assign({
		DATABASE_URL: getEnv('DATABASE_URL'),
	}, overrides)
}

/**
 * Validates the database env surface before a client or Drizzle wrapper is created.
 *
 * This keeps the runtime boundary honest: callers either provide a usable
 * PostgreSQL connection string or get a clear error before any connection work
 * begins.
 */
const databaseEnvSchema = z.object({
	DATABASE_URL: z.preprocess(
		blankStringToUndefined,
		z.string({ error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
	),
})

/**
 * Normalized database config derived from raw env strings.
 *
 * The database package only needs one runtime input today, so the structured
 * output stays intentionally small.
 */
const databaseConfigSchema = databaseEnvSchema.transform((env): DatabaseConfig => ({
	connectionString: env.DATABASE_URL,
}))

/**
 * Parses a raw database env object into the config used by the shared client
 * factories.
 *
 * @example Explicit env object
 * ```ts
 * const config = parseDatabaseConfig({
 *   DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/finance_app',
 * })
 * ```
 *
 * @example Missing connection string
 * ```ts
 * parseDatabaseConfig({ DATABASE_URL: undefined })
 * // throws: DATABASE_URL is required
 * ```
 */
export function parseDatabaseConfig(rawEnv: DatabaseEnvInput): DatabaseConfig {
	return databaseConfigSchema.parse(rawEnv)
}

/**
 * Reads the current runtime env and returns the normalized database config.
 *
 * This is the convenience path for server code that wants the shared database
 * defaults without manually reading from `Deno.env` or `process.env`.
 */
export function createDatabaseConfig(
	overrides: Partial<DatabaseEnvInput> = {},
): DatabaseConfig {
	return parseDatabaseConfig(readDatabaseEnv(overrides))
}