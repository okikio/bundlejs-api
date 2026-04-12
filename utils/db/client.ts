import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import type { PostgresType, Sql } from 'postgres'

import { getLogger } from '@logtape/drizzle-orm'
import { configure, getConsoleSink } from '@logtape/logtape'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import * as dbSchema from './schemas/mod.ts'
import { createDatabaseConfig } from './env.ts'

/** Default postgres.js pool size used by shared helpers when callers do not override it. */
export const DEFAULT_MAX_CONNECTIONS: number = 10

/** LogTape category path used for shared Drizzle query logging. */
export const DRIZZLE_LOG_CATEGORY: readonly ['drizzle-orm'] = Object.freeze(['drizzle-orm'])

/** Supported log levels for explicit SQL query logging setup. */
export type DatabaseLogLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal'

/** Shared Drizzle schema for auth, execution helpers, and workflow services. */
export const schema: typeof dbSchema = dbSchema

/**
 * Options for building a PostgreSQL client or Drizzle wrapper inside this repo.
 *
 * These options keep connection behavior explicit so shared packages can choose
 * sensible defaults without hiding operational decisions inside module import
 * side effects.
 */
export interface CreateDatabaseOptions {
	/** Connection string for PostgreSQL or OrioleDB-compatible PostgreSQL. */
	connectionString: string
	/** Maximum number of open connections for the postgres.js pool. */
	max?: number
	/** Disable prepared statements when a proxy or pooler makes them awkward. */
	prepare?: boolean
	/**
	 * Enable Drizzle query logging through LogTape.
	 *
	 * Call `configureDatabaseLogging()` during startup if you want the default
	 * console sink configured for these query logs.
	 */
	logQueries?: boolean
}

/** @ignore Drizzle database instances are runtime plumbing, not reader-facing API docs. */
export type Database = PostgresJsDatabase<typeof schema>

/** @ignore postgres.js client instances are internal runtime plumbing. */
export type DatabaseClient = Sql<Record<string, PostgresType>>

/**
 * Options for configuring the repo's default SQL query logging path.
 *
 * This is intentionally separate from database creation so importing the DB
 * package does not silently mutate global logging state.
 */
export interface ConfigureDatabaseLoggingOptions {
	/** Lowest LogTape level that should be emitted for Drizzle query logs. */
	lowestLevel?: DatabaseLogLevel
}

/**
 * Configures the default console-backed LogTape sink for Drizzle query logs.
 *
 * Call this from an application entrypoint when you want shared database code
 * to emit SQL logs during development or debugging. It is explicit on purpose:
 * importing the database package should not perform global logger setup.
 *
 * @example Enable verbose SQL logs during local development
 * ```ts
 * await configureDatabaseLogging({ lowestLevel: 'debug' })
 * ```
 *
 * @example Keep query logging quieter
 * ```ts
 * await configureDatabaseLogging({ lowestLevel: 'info' })
 * ```
 */
export async function configureDatabaseLogging(
	options: ConfigureDatabaseLoggingOptions = {},
): Promise<void> {
	await configure({
		sinks: { console: getConsoleSink() },
		loggers: [
			{
				category: [...DRIZZLE_LOG_CATEGORY],
				sinks: ['console'],
				lowestLevel: options.lowestLevel ?? 'debug',
			},
		],
	})
}

/**
 * Creates the low-level postgres.js client with defaults that work well across
 * local development, pooled connections, and managed PostgreSQL variants.
 *
 * The goal is to keep the transport layer explicit and reusable. Callers that
 * need raw SQL access can stop here, while Drizzle users can build on top of
 * the same client settings through `createDatabase()`.
 *
 * @example Standard local connection
 * ```ts
 * const client = createSqlClient({
 *   connectionString: 'postgresql://postgres:postgres@localhost:5432/finance_app',
 * })
 * ```
 *
 * @example Disable prepared statements behind a proxy
 * ```ts
 * const client = createSqlClient({
 *   connectionString: 'postgresql://postgres:postgres@localhost:5432/finance_app',
 *   prepare: false,
 * })
 * ```
 */
export function createSqlClient(options: CreateDatabaseOptions): DatabaseClient {
	return postgres(options.connectionString, {
		max: options.max ?? DEFAULT_MAX_CONNECTIONS,
		prepare: options.prepare ?? false,
	})
}

/**
 * Creates the Drizzle database wrapper used by Better Auth and the backend
 * services.
 *
 * The shared schema is attached here so Better Auth joins and service-side
 * query helpers operate on the same table metadata instead of drifting into
 * separate copies.
 *
 * Query logging is explicit. If `logQueries` is enabled, this function wires
 * Drizzle into LogTape, but it does not configure sinks for you.
 */
export function createDatabase(options: CreateDatabaseOptions): Database {
	const client = createSqlClient(options)

	return drizzle({
		client,
		schema,
		logger: options.logQueries ? getLogger() : undefined,
	})
}

/**
 * Builds the shared database instance from the current runtime environment.
 *
 * This is the convenience path for services that want the repo's default
 * `DATABASE_URL` handling without manually parsing env vars first. Callers can
 * still override connection settings when a test, CLI, or one-off task needs a
 * different transport shape.
 *
 * @example Use the shared runtime connection string
 * ```ts
 * const db = createDatabaseFromEnv()
 * ```
 *
 * @example Override connection behavior in a test or script
 * ```ts
 * const db = createDatabaseFromEnv({
 *   connectionString: 'postgresql://postgres:postgres@localhost:5432/test_db',
 *   prepare: false,
 * })
 * ```
 */
export function createDatabaseFromEnv(
	overrides: Partial<CreateDatabaseOptions> = {},
): Database {
	const connectionString = overrides.connectionString
		?? createDatabaseConfig().connectionString

	return createDatabase({
		connectionString,
		max: overrides.max,
		prepare: overrides.prepare,
		logQueries: overrides.logQueries,
	})
}