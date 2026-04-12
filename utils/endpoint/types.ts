import type { ValidationTargets, Input, Env as SharedAppEnv } from 'hono'
import type { H, FormValue, HandlerResponse, ParsedFormValue } from 'hono/types'
import type z from 'zod'

export type EmptyShape = Record<PropertyKey, unknown>

/**
 * Zod schema that accepts a raw input shape and produces parsed output.
 * 
 * This stays intentionally broad so endpoint definitions can use plain objects,
 * pipes, transforms, unions, or intersections without losing the relationship
 * between the unparsed request input and the parsed handler output.
 *
 * No structural constraints. It accepts:
 * - Plain objects: z.object({ ... })
 * - Pipes: z.object({ ... }).pipe(...)
 * - Transforms: z.object({ ... }).transform(...)
 * - Unions, intersections, etc.
 * 
 * Use this when you need input type safety but want to allow transformations.
 */
export type SchemaFor<Input, Output = unknown> = z.ZodType<Output, Input>

/**
 * Normalize record-shaped inputs for schema compatibility checks.
 * 
 * This converts `Record<K, V>` to `{ [key: string]: V }` so catchall schemas
 * with index signatures can satisfy endpoint contracts that start from a more
 * specific key union.
 * 
 * This enables: z.object({}).catchall(z.string()) to satisfy
 * RecordSchemaFor<Record<RequestHeader, string>>
 */
type NormalizedRecordInput<T> =
  T extends Record<infer K, infer V>
  ? K extends string
  ? { [key: string]: V }
  : T
  : T

/**
 * Schema constrained to record-shaped raw input.
 * 
 * This is useful for query strings, headers, cookies, and similar request
 * inputs where a catchall schema is often a better runtime fit than spelling
 * out every possible key.
 * 
 * @example Catchall schema satisfies a specific record contract
 * const schema = z.object({}).catchall(z.string())
 *   satisfies RecordSchemaFor<Record<RequestHeader, string>>
 */
export type RecordSchemaFor<Input extends Record<string, unknown>, Output = unknown> =
  SchemaFor<NormalizedRecordInput<Input>, Output>

/**
 * @deprecated Use SchemaFor<I> instead - allows transformations
 */
export type AnySchemaFor<I> = SchemaFor<I>

/**
 * Validation schemas for each request input source.
 * 
 * Each schema must accept the raw input type from its source:
 * - Query: Record<string, string | string[]>
 * - Form: Record<string, FormValue | FormValue[]>
 * - Json: any
 * - Param: Record<P, string | undefined>
 * - Header: Record<RequestHeader | CustomHeader, string>
 * - Cookie: Record<string, string>
 * 
 * Schemas can transform to any output type (pipes/transforms allowed).
 */
export type EndpointDefinitionSchemas<T extends FormValue = ParsedFormValue, P extends string = string> = {
  [K in keyof ValidationTargets as Capitalize<K>]?:
  ValidationTargets[K] extends Record<string, unknown>
  ? RecordSchemaFor<ValidationTargets<T, P>[K]>
  : SchemaFor<ValidationTargets<T, P>[K]>
}

/**
 * Static endpoint contract used by shared endpoint helpers.
 *
 * The `Input`, `Output`, and `Schemas` fields all remain schema-based so the
 * endpoint description can drive both runtime validation and handler typing.
 */
export type EndpointDefinition = {
  Name: string
  Route: string
  Description?: string
  Methods: readonly ('GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH')[]
  Input: z.ZodType
  Output: z.ZodType
  Schemas: EndpointDefinitionSchemas
}

/**
 * Hono app environment narrowed to the middleware variables an endpoint expects.
 *
 * Middleware in this repo adds typed values onto `c.var`. This type lets an
 * endpoint express those guarantees without replacing the shared environment
 * contract from Hono.
 */
export type EnvVariables = NonNullable<SharedAppEnv['Variables']>

export interface FunctionAppEnv<Variables extends EnvVariables = EnvVariables> extends SharedAppEnv {
  Variables: EnvVariables & Variables
}

/**
 * Derive Hono's `Input` shape from endpoint validation schemas.
 *
 * The `in` branch reflects the raw values before validation. The `out` branch
 * reflects the parsed values after each schema has run. Using `z.input` and
 * `z.output` here keeps transforms and pipes aligned with the handler contract.
 */
export type BuildInput<Schemas extends Partial<EndpointDefinitionSchemas> = EmptyShape> = Input & {
  in: {
    [K in keyof Schemas as Lowercase<K & string>]:
      K extends keyof Schemas ? z.input<Schemas[K]> : never
  }
  out: {
    [K in keyof Schemas as Lowercase<K & string>]:
      K extends keyof Schemas ? z.output<Schemas[K]> : never
  }
}

/**
 * Hono handler specialized to a schema-backed endpoint definition.
 */
export type EndpointHandler<
  Env extends FunctionAppEnv = FunctionAppEnv,
  Definition extends Partial<EndpointDefinition> = Partial<EndpointDefinition>,
  _Route extends string = (Definition['Route'] extends string ? Definition['Route'] : string),
  _Input extends Input = Definition['Schemas'] extends EndpointDefinitionSchemas ? BuildInput<Definition['Schemas']> : Input,
  _HandlerResponse extends HandlerResponse<unknown> = Definition['Output'] extends z.ZodType ? HandlerResponse<z.output<Definition['Output']>> : HandlerResponse<unknown>
> = H<Env, _Route, _Input, _HandlerResponse>

/**
 * Hono middleware handler specialized to a schema-backed endpoint definition.
 */
export type EndpointMiddlewareHandler<
  Env extends FunctionAppEnv = FunctionAppEnv,
  Definition extends Partial<EndpointDefinition> = Partial<EndpointDefinition>,
  _Route extends string = (Definition['Route'] extends string ? Definition['Route'] : string),
  _Input extends Input = Definition['Schemas'] extends EndpointDefinitionSchemas ? BuildInput<Definition['Schemas']> : Input,
  _HandlerResponse extends HandlerResponse<unknown> = Definition['Output'] extends z.ZodType ? HandlerResponse<z.output<Definition['Output']>> : HandlerResponse<unknown>
> = H<Env, _Route, _Input, _HandlerResponse>

/**
 * Handler module contract with erased handler generics.
 * 
 * Module loading code often needs a uniform shape even when the underlying
 * handlers carry different endpoint-specific generics. This contract erases
 * those generics down to Hono's base `Handler` and `MiddlewareHandler` types
 * so route modules can still be described and imported consistently.
 */
export interface EndpointHandlerModule {
  Middleware?: H[],
  default: H
} 