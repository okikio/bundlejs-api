# Backend Utilities - Type Signatures

Complete reference of all utilities from the `supabase/functions/_shared` directory.

## Execution Module (`execution/`)

### SPARQL Execution (`execution/sparql.ts`)

```typescript
// Core query function
async function querySparql<T extends BindingMap = BindingMap>(
  endpoint: string,
  query: ReturnType<typeof select>,
  options?: Partial<SparqlQueryOptions>
): Promise<QueryResult<T>>

// Query with base patterns (security/scoping)
async function querySparqlWithBase<T extends BindingMap = BindingMap>(
  endpoint: string,
  query: ReturnType<typeof select>,
  options: SparqlQueryOptions
): Promise<QueryResult<T>>

// Generate preview of SPARQL query for debugging
function queryPreview(query: string, maxLen?: number): string

// Map SPARQL errors to problem details
function mapSparqlQueryErrorToProblem(
  error: QueryError,
  context?: Record<string, unknown>
): ProblemDetails

// Exported types
interface BaseSparqlPattern {
  subject: TripleSubject
  predicate: TriplePredicate
  object: TripleObject
}

interface SparqlQueryOptions {
  endpoint: string
  basePatterns?: BaseSparqlPattern[]
  timeout?: number
  additionalPrefixes?: Record<string, string>
}

type SparqlErrorKind = 'syntax' | 'timeout' | 'unavailable' | 'database' | 'unknown'
```

### Supabase Execution (`execution/supabase.ts`)

```typescript
// Query options for Supabase collections
interface CollectionQueryOptions {
  /** User client (for RLS) or admin client */
  client: SupabaseClient
  /** Table/view name */
  from: string
  /** Query specification (filters, sorts, pagination, fields) */
  spec: QuerySpec
  /** Count strategy for pagination */
  count?: 'exact' | 'planned' | 'estimated'
}

// Type helpers for Supabase schema inference
type SchemaName = Extract<keyof PublicDatabase, string>

type TableName<TSchema extends SchemaName = "public"> = Extract<
  keyof PublicDatabase[TSchema]['Tables'],
  string
>

type ViewName<TSchema extends SchemaName = "public"> = Extract<
  keyof PublicDatabase[TSchema]['Views'],
  string
>

type RelationName<TSchema extends SchemaName = "public"> =
  | TableName<TSchema>
  | ViewName<TSchema>

type RelationRow<
  TSchema extends SchemaName,
  TRelation extends RelationName<TSchema>
> = TRelation extends TableName<TSchema>
  ? PublicDatabase[TSchema]['Tables'][TRelation]['Row']
  : TRelation extends ViewName<TSchema>
  ? PublicDatabase[TSchema]['Views'][TRelation]['Row']
  : never

type SupabaseClientType<TSchema extends SchemaName> = 
  SupabaseClient<Database, 'public', TSchema>

type RestClient<TSchema extends SchemaName> =
  ReturnType<SupabaseClientType<TSchema>['rest']>

type SupabaseClientSelectType<TSchema extends SchemaName> = 
  ReturnType<ReturnType<SupabaseClientType<TSchema>['from']>['select']>

// Query building functions
function buildSelectClause(
  fields?: FieldSelectionNormalized
): string

function applySorts<
  TClient extends SupabaseClientSelectType<any>
>(
  query: TClient,
  sorts: SortsNormalized
): TClient

function applyFilters<
  TClient extends SupabaseClientSelectType<any>
>(
  query: TClient,
  filters: FiltersNormalized
): TClient

function applyCursorPagination<
  TClient extends SupabaseClientSelectType<any>
>(
  query: TClient,
  pagination: CursorPaginationNormalized
): TClient

function applyOffsetPagination<
  TClient extends SupabaseClientSelectType<any>
>(
  query: TClient,
  pagination: OffsetPaginationNormalized
): TClient

function applyPagination<
  TClient extends SupabaseClientSelectType<any>
>(
  query: TClient,
  pagination: PaginationNormalized
): TClient

function applyQuerySpec<
  TClient extends SupabaseClientSelectType<any>
>(
  query: TClient,
  spec: QuerySpec
): TClient

// Execution functions
async function executeCollectionQuery<T>(
  options: CollectionQueryOptions
): Promise<{ data: T[] | null; error: PostgrestError | null }>

function queryCollection<T>(
  client: SupabaseClient,
  from: string,
  spec: QuerySpec
): Promise<{ data: T[] | null; error: PostgrestError | null }>

function queryCollectionWithCount<T>(
  client: SupabaseClient,
  from: string,
  spec: QuerySpec,
  count?: 'exact' | 'planned' | 'estimated'
): Promise<{
  data: T[] | null
  error: PostgrestError | null
  count: number | null
}>
```

---

## Middleware Module (`middleware/`)

### Authentication (`middleware/auth.ts`)

```typescript
// User auth variables (JWT-authenticated)
type AuthUserVariables = {
  user: User
}

// Admin auth variables (service role)
type AuthAdminVariables = {
  admin: true
}

// User authentication middleware
const authUserMiddleware: MiddlewareHandler

// Admin authentication middleware  
const authAdminMiddleware: MiddlewareHandler
```

### Correlation (`middleware/correlation.ts`)

```typescript
// Request correlation data
interface RequestCorrelation {
  requestId: string
  traceId: string
  spanId: string
  parentSpanId?: string
  service: string
  timestamp: number
}

// Correlation context variables
interface CorrelationVariables { 
  correlation: RequestCorrelation
}

// Create correlation middleware
function correlationMiddleware(serviceName: string): MiddlewareHandler

// Extract trace context from request
function extractTraceContext(c: Context): RequestCorrelation

// Get correlation from context
function getCorrelation(c: Context): RequestCorrelation

// Get logger with correlation
function getLogger(
  c: Context, 
  categories?: Parameters<typeof logtapeLogger>[0]
): Logger

// Get propagation headers for outgoing requests
function getPropagationHeaders(c: Context): Record<string, string>
```

### Validation (`middleware/validation.ts`)

```typescript
// Create validation middleware
function createValidator<
  TSchema extends z.ZodType,
  TLocation extends 'query' | 'json' | 'form' | 'header' | 'cookie' | 'param'
>(
  location: TLocation,
  schema: TSchema
): MiddlewareHandler

// Transform validation errors to problem details
function toErrs(
  error: z.ZodError
): ValidationErrorDetail[]
```

---

## Query Module (`query/`)

### Query Schemas (`query/schemas.ts`)

```typescript
// Core types
type SupabaseClientType = SupabaseClient<Database>
type SupabaseClientSelectType = ReturnType<ReturnType<SupabaseClientType['from']>['select']>

const NonEmptyStringSchema: z.ZodString

// Filter operators
const FilterOperatorSchema: z.ZodEnum<[
  'eq', 'ne', 
  'gt', 'gte', 'lt', 'lte',
  'like', 'ilike', 
  'in', 'is', 
  'contains', 'containedBy', 'overlaps'
]>
type FilterOperator = z.infer<typeof FilterOperatorSchema>

// Filter schemas
const FilterNormalizedSchema: z.ZodObject<{
  field: string
  operator: FilterOperator
  value: unknown
}>
type FilterNormalized = z.infer<typeof FilterNormalizedSchema>

const FiltersNormalizedSchema: z.ZodArray<typeof FilterNormalizedSchema>
type FiltersNormalized = z.infer<typeof FiltersNormalizedSchema>

const BaseFilterNormalizedSchema: z.ZodObject<{
  field: string
  operator: FilterOperator  
  value: unknown
  baseFilter: true
}>
type BaseFilterNormalized = z.infer<typeof BaseFilterNormalizedSchema>

const BaseFiltersNormalizedSchema: z.ZodArray<typeof BaseFilterNormalizedSchema>
type BaseFiltersNormalized = z.infer<typeof BaseFiltersNormalizedSchema>

// Operator definitions for filter registry
const OperatorDefinitionSchema: z.ZodObject<{
  type: FilterOperator
  description?: string
  valueType?: 'string' | 'number' | 'boolean' | 'array' | 'null'
  examples?: unknown[]
}>
type OperatorDefinition = z.infer<typeof OperatorDefinitionSchema>

const FilterRegistrySchema: z.ZodRecord<
  z.ZodString,
  z.ZodArray<typeof OperatorDefinitionSchema>
>
type FilterRegistry = z.infer<typeof FilterRegistrySchema>

// Sort schemas
const SortDirectionSchema: z.ZodEnum<['asc', 'desc']>
type SortDirection = z.infer<typeof SortDirectionSchema>

const SortNormalizedSchema: z.ZodObject<{
  field: string
  direction: SortDirection
}>
type SortNormalized = z.infer<typeof SortNormalizedSchema>

const SortsNormalizedSchema: z.ZodArray<typeof SortNormalizedSchema>
type SortsNormalized = z.infer<typeof SortsNormalizedSchema>

// Field selection schemas
const SimpleFieldSelectionSchema: z.ZodObject<{
  type: 'simple'
  fields: string[]
}>

const JsonApiFieldSelectionSchema: z.ZodObject<{
  type: 'json-api'
  include: string[]
  fields: Record<string, string[]>
}>

const FieldSelectionNormalizedSchema: z.ZodDiscriminatedUnion<'type', [
  typeof SimpleFieldSelectionSchema,
  typeof JsonApiFieldSelectionSchema
]>
type FieldSelectionNormalized = z.infer<typeof FieldSelectionNormalizedSchema>

// Pagination schemas
const CursorDataSchema: z.ZodObject<{
  sortValues: Record<string, unknown>
  id: string
  direction: 'next' | 'prev'
  expiresAt: number
  hmac: string
}>
type CursorData = z.infer<typeof CursorDataSchema>

const OffsetPaginationNormalizedSchema: z.ZodObject<{
  type: 'offset'
  limit: number
  offset: number
}>
type OffsetPaginationNormalized = z.infer<typeof OffsetPaginationNormalizedSchema>

const CursorPaginationNormalizedSchema: z.ZodObject<{
  type: 'cursor'
  limit: number
  cursor?: CursorData
  direction: 'next' | 'prev'
}>
type CursorPaginationNormalized = z.infer<typeof CursorPaginationNormalizedSchema>

const PaginationNormalizedSchema: z.ZodDiscriminatedUnion<'type', [
  typeof OffsetPaginationNormalizedSchema,
  typeof CursorPaginationNormalizedSchema
]>
type PaginationNormalized = z.infer<typeof PaginationNormalizedSchema>

// Configuration schemas
const PaginationConfigSchema: z.ZodObject<{
  strategy: 'cursor' | 'offset'
  defaultLimit: number
  maxLimit: number
  sortFields: string[]
  cursorSecret?: string
  cursorTtl?: number
}>
type PaginationConfig = z.infer<typeof PaginationConfigSchema>

const FiltersConfigSchema: z.ZodObject<{
  allowedFields: string[]
  registry: FilterRegistry
  baseFilters?: BaseFiltersNormalized
}>
type FiltersConfig = z.input<typeof FiltersConfigSchema>

const SortsConfigSchema: z.ZodObject<{
  allowedFields: string[]
  defaultSort?: SortsNormalized
  maxSorts?: number
}>
type SortsConfig = z.input<typeof SortsConfigSchema>

const FieldsConfigSchema: z.ZodObject<{
  allowedFields: string[]
  defaultFields?: string[]
}>
type FieldsConfig = z.input<typeof FieldsConfigSchema>

// Main QuerySpec schema
const QuerySpecSchema: z.ZodObject<{
  filters?: FiltersNormalized
  sorts?: SortsNormalized
  pagination?: PaginationNormalized
  fields?: FieldSelectionNormalized
}>
type QuerySpec = z.infer<typeof QuerySpecSchema>

// Endpoint query configuration
const EndpointQueryConfigSchema: z.ZodObject<{
  pagination: PaginationConfig
  filters?: FiltersConfig
  sorts?: SortsConfig
  fields?: FieldsConfig
}>
type EndpointQueryConfig = z.input<typeof EndpointQueryConfigSchema>
```

### Fields (`query/fields.ts`)

```typescript
// Wire format schemas
const FieldsQueryWire: z.ZodObject // Query string format
const FieldsJsonWire: z.ZodObject   // JSON body format
const FieldsFormWire: z.ZodObject   // Form data format

// Adapters - transform wire format to normalized
function createFieldsQueryAdapter(): (input: unknown) => FieldSelectionNormalized
function createFieldsJsonAdapter(): (input: unknown) => FieldSelectionNormalized
function createFieldsFormAdapter(): (input: unknown) => FieldSelectionNormalized

// Create complete fields schema with validation
function createFieldsSchema(config: {
  allowedFields: string[]
  defaultFields?: string[]
}): z.ZodEffects<z.ZodObject, FieldSelectionNormalized>
```

### Filters (`query/filtering.ts`)

```typescript
// Wire format schemas
const FiltersQueryWire: z.ZodObject // Query string format
const FiltersJsonWire: z.ZodObject  // JSON body format
const FiltersFormWire: z.ZodObject  // Form data format

// Adapters - transform wire format to normalized
function createFiltersQueryAdapter(): (input: unknown) => FiltersNormalized
function createFiltersJsonAdapter(): (input: unknown) => FiltersNormalized
function createFiltersFormAdapter(): (input: unknown) => FiltersNormalized

// Create complete filters schema with validation
function createFiltersSchema(config: {
  allowedFields: string[]
  registry: FilterRegistry
  baseFilters?: BaseFiltersNormalized
}): z.ZodEffects<z.ZodObject, FiltersNormalized>
```

### Sorting (`query/sorting.ts`)

```typescript
// Wire format schemas
const SortsQueryWire: z.ZodObject // Query string format
const SortsJsonWire: z.ZodObject  // JSON body format
const SortsFormWire: z.ZodObject  // Form data format

// Adapters - transform wire format to normalized
function createSortsQueryAdapter(): (input: unknown) => SortsNormalized
function createSortsJsonAdapter(): (input: unknown) => SortsNormalized
function createSortsFormAdapter(): (input: unknown) => SortsNormalized

// Create complete sorts schema with validation
function createSortsSchema(config: {
  allowedFields: string[]
  defaultSort?: SortsNormalized
  maxSorts?: number
}): z.ZodEffects<z.ZodObject, SortsNormalized>
```

### Pagination (`query/pagination.ts`)

```typescript
// Wire format schemas
const PaginationQueryWire: z.ZodObject // Query string format
const PaginationJsonWire: z.ZodObject  // JSON body format
const PaginationFormWire: z.ZodObject  // Form data format

// Adapters - transform wire format to normalized
function createPaginationQueryAdapter(
  defaultLimit?: number
): (input: unknown) => PaginationNormalized

function createPaginationJsonAdapter(
  defaultLimit?: number
): (input: unknown) => PaginationNormalized

function createPaginationFormAdapter(
  defaultLimit?: number
): (input: unknown) => PaginationNormalized

// Create complete pagination schema with validation
function createPaginationSchema(config: {
  strategy: 'cursor' | 'offset'
  defaultLimit: number
  maxLimit: number
  sortFields: string[]
  cursorSecret?: string
  cursorTtl?: number
}): z.ZodEffects<z.ZodObject, PaginationNormalized>

// Cursor utilities
function sortObject<T>(obj: T): T

const Base64UrlJsonCursorCodec: z.ZodType<CursorData>

function hmacSha256Hex(secret: string, payload: unknown): string

function decodeAndVerifyCursor(
  cursorToken: string,
  secret: string
): CursorData

function encodeCursor(data: CursorData, secret: string): string

function cursorFromRow<Row extends Record<string, unknown>>(
  row: Row, 
  cfg: {
    sortFields: string[]
    idField: string
    direction: 'next' | 'prev'
    secret: string
    ttl: number
  }
): string

function makeCursorTokens<Row extends Record<string, unknown>>(args: {
  rows: Row[]
  sortFields: string[]
  idField: string
  secret: string
  ttl: number
}): { prev: string | null; next: string | null }

function computeExpiresAt(opts: {
  ttl: number
  now?: number
}): number

// Pagination metadata builder
function buildPaginationMeta<Row extends Record<string, unknown>>(args: {
  rows: Row[]
  count?: number | null
  config: PaginationConfig
  pagination: PaginationNormalized
  baseUrl: string
  queryParams?: Record<string, string | string[]>
}): PaginationMetadata & { links: LinkMap }
```

### Query Builder (`query/query.ts`)

```typescript
// Main query spec creator
function createQuerySpec(
  config: EndpointQueryConfig,
  input: {
    filters?: unknown
    sorts?: unknown
    pagination?: unknown
    fields?: unknown
  }
): QuerySpec

// Create endpoint query schema (all-in-one)
function createEndpointQuerySchema(
  config: EndpointQueryConfig
): z.ZodObject<{
  filters: z.ZodEffects
  sorts: z.ZodEffects
  pagination: z.ZodEffects
  fields: z.ZodEffects
}>
```

---

## Response Module (`response/`)

### Status Codes (`response/status-codes.ts`)

```typescript
// Status code schemas
const InfoStatusCodeSchema: z.ZodUnion // 1xx
type InfoStatusCode = z.infer<typeof InfoStatusCodeSchema>

const SuccessStatusCodeSchema: z.ZodUnion // 2xx
type SuccessStatusCode = z.infer<typeof SuccessStatusCodeSchema>

const DeprecatedStatusCodeSchema: z.ZodUnion // 3xx deprecated
type DeprecatedStatusCode = z.infer<typeof DeprecatedStatusCodeSchema>

const RedirectStatusCodeSchema: z.ZodUnion // 3xx
type RedirectStatusCode = z.infer<typeof RedirectStatusCodeSchema>

const ClientErrorStatusCodeSchema: z.ZodUnion // 4xx
type ClientErrorStatusCode = z.infer<typeof ClientErrorStatusCodeSchema>

const ServerErrorStatusCodeSchema: z.ZodUnion // 5xx
type ServerErrorStatusCode = z.infer<typeof ServerErrorStatusCodeSchema>

const UnofficialStatusCodeSchema: z.ZodLiteral<-1>
type UnofficialStatusCode = z.infer<typeof UnofficialStatusCodeSchema>

const StatusCodeSchema: z.ZodUnion // All status codes
type StatusCode = z.infer<typeof StatusCodeSchema>

const ContentlessStatusCodeSchema: z.ZodUnion // 204, 205, 304
type ContentlessStatusCode = z.infer<typeof ContentlessStatusCodeSchema>

const ContentfulStatusCodeSchema: z.ZodEffects // All except contentless
type ContentfulStatusCode = z.infer<typeof ContentfulStatusCodeSchema>
```

### Response Schemas (`response/schemas.ts`)

```typescript
// Validation error detail
const ValidationErrorDetailSchema: z.ZodObject<{
  field: string
  message: string
  code?: string
}>
type ValidationErrorDetail = z.infer<typeof ValidationErrorDetailSchema>

// Problem details (RFC 7807)
const ProblemDetailsSchema: z.ZodObject<{
  type: string
  title: string
  status: number
  detail?: string
  instance?: string
  [key: string]: unknown
}>
type ProblemDetails = z.infer<typeof ProblemDetailsSchema>

const ProblemDetailsWithErrorsSchema: z.ZodObject // Extends ProblemDetails with errors array
type ProblemDetailsWithErrors = z.infer<typeof ProblemDetailsWithErrorsSchema>

// Pagination metadata
const PaginationSchema: z.ZodObject<{
  page: number
  pageSize: number
  total: number
  totalPages: number
  hasNext: boolean
  hasPrev: boolean
}>
type Pagination = z.infer<typeof PaginationSchema>

const DataMetadataSchema: z.ZodObject // Catchall for custom metadata
type DataMetadata = z.infer<typeof DataMetadataSchema>

const PaginationMetadataSchema: z.ZodObject // Extends DataMetadata
type PaginationMetadata = z.infer<typeof PaginationMetadataSchema>

// Link relations (RFC 5988)
const LinkMapSchema: z.ZodRecord<string, { href: string; title?: string }>
type LinkMap = z.infer<typeof LinkMapSchema>

// Headers
const StandardHeadersSchema: z.ZodObject
type StandardHeaders = Record<string, string>

const JsonHeadersSchema: z.ZodObject<{
  'content-type': 'application/json'
}>
type JsonHeaders = z.infer<typeof JsonHeadersSchema>

const JsonHeadersWithLinksSchema: z.ZodObject // Extends JsonHeaders with Link header
type JsonHeadersWithLinks = z.infer<typeof JsonHeadersWithLinksSchema>

const ProblemHeadersSchema: z.ZodObject<{
  'content-type': 'application/problem+json'
}>
type ProblemHeaders = z.infer<typeof ProblemHeadersSchema>

// Envelopes
interface SuccessEnvelope<T = unknown, M extends DataMetadata = DataMetadata> {
  data: T
  meta?: M
}

function makeSuccessEnvelopeSchema<
  TData extends z.ZodType
>(dataSchema: TData): z.ZodObject

type PaginationEnvelope<T = unknown> = SuccessEnvelope<T, PaginationMetadata>

function makePaginationEnvelopeSchema<TData extends z.ZodType>(
  dataSchema: TData
): z.ZodObject

// Results (tuple of [status, body, headers])
const ContentlessResultSchema: z.ZodTuple<[
  ContentlessStatusCode,
  undefined,
  StandardHeaders
]>
type ContentlessResult = readonly [
  ContentlessStatusCode,
  undefined,
  StandardHeaders
]

function makeSuccessResultSchema<
  TEnvelope extends z.ZodType,
  THeaders extends z.ZodType = typeof JsonHeadersSchema
>(
  envelopeSchema: TEnvelope,
  headersSchema?: THeaders
): z.ZodTuple

type GenericSuccessResult<
  E extends SuccessEnvelope = SuccessEnvelope, 
  H extends JsonHeaders = JsonHeaders
> = readonly [SuccessStatusCode, E, H]

type SuccessResult<T = unknown, M extends DataMetadata = DataMetadata> = 
  GenericSuccessResult<SuccessEnvelope<T, M>>

function makePaginationResultSchema<TData extends z.ZodType>(
  dataSchema: TData
): z.ZodTuple

type PaginationResult<T = unknown> = 
  GenericSuccessResult<PaginationEnvelope<T>, JsonHeadersWithLinks>

const ErrorResultSchema: z.ZodTuple<[
  ClientErrorStatusCode | ServerErrorStatusCode,
  ProblemDetails,
  ProblemHeaders
]>
type ErrorResult = readonly [
  ClientErrorStatusCode | ServerErrorStatusCode,
  ProblemDetails,
  ProblemHeaders
]

const ErrorsResultSchema: z.ZodTuple<[
  ClientErrorStatusCode | ServerErrorStatusCode,
  ProblemDetailsWithErrors,
  ProblemHeaders
]>
type ErrorsResult = readonly [
  ClientErrorStatusCode | ServerErrorStatusCode,
  ProblemDetailsWithErrors,
  ProblemHeaders
]

// Response types
function makeSuccessResponseSchema<TData extends z.ZodType>(
  dataSchema: TData
): z.ZodUnion

type SuccessResponse<T = unknown> =
  | SuccessResult<T>
  | ContentlessResult

const ErrorResponseSchema: z.ZodUnion<[
  typeof ErrorResultSchema,
  typeof ErrorsResultSchema
]>
type ErrorResponse = ErrorResult | ErrorsResult

function makeResponseResultSchema<TData extends z.ZodType>(
  dataSchema: TData
): z.ZodUnion

type ResponseResult<T = unknown> =
  | SuccessResponse<T>
  | ErrorResponse
```

### Success Responses (`response/success.ts`)

```typescript
// Success response builders
function ok<T = unknown, M extends DataMetadata = DataMetadata>(
  data: T,
  meta?: M
): SuccessResult<T, M>

function created<T = unknown, M extends DataMetadata = DataMetadata>(
  data: T,
  meta?: M
): SuccessResult<T, M>

function accepted<T = unknown, M extends DataMetadata = DataMetadata>(
  data: T,
  meta?: M
): SuccessResult<T, M>

function noContent(): ContentlessResult

// Pagination helper
function paginate<T = unknown>(
  data: T[],
  pagination: PaginationNormalized,
  config: {
    count?: number | null
    baseUrl: string
    sortFields: string[]
    idField: string
    secret: string
    ttl: number
    queryParams?: Record<string, string | string[]>
  }
): PaginationResult<T[]>

// URL builders
function buildUrlWithParams(
  baseUrl: string,
  params: Record<string, string | string[] | undefined>
): string

function buildCursorUrl(
  baseUrl: string,
  cursor: string | null,
  params: Record<string, string | string[]>
): string | null

function buildOffsetUrl(
  baseUrl: string,
  offset: number,
  limit: number,
  params: Record<string, string | string[]>
): string

// Response transformers
function withHeaders<
  TResult extends SuccessResult | ContentlessResult
>(
  result: TResult,
  headers: Record<string, string>
): TResult

function withMeta<
  T,
  M1 extends DataMetadata,
  M2 extends DataMetadata
>(
  result: SuccessResult<T, M1>,
  meta: M2
): SuccessResult<T, M1 & M2>

// Type guard
function isSuccessResponse<T>(
  response: ResponseResult<T>
): response is SuccessResponse<T>
```

### Error Responses (`response/errors.ts`)

```typescript
// Error URL bases
const BASE_ERROR_URL: string
const BASE_DOCS_URL: string

// Error type registry
const ERROR_TYPES: Record<string, string>
const ERROR_DOCS: Record<string, string>

// Status titles
const STATUS_TITLES: Record<number, string>
function titleFor(status: number): string

// Status to function map
const STATUS_TO_FUNCTION_MAP: Record<number, Function>
type KnownErrorStatus = keyof typeof STATUS_TO_FUNCTION_MAP

// Extension interfaces
interface MethodNotAllowedExtension { allowed: string[] }
interface UnsupportedMediaTypeExtension { supported?: string[] }
interface PayloadTooLargeExtension { limitBytes?: number }
interface RateLimitExtension { retryAfter: number }
interface ServiceUnavailableExtension { service: string }

// Base problem builder
function baseProblem(
  status: number,
  title?: string,
  type?: string,
  detail?: string,
  extensions?: Record<string, unknown>
): ProblemDetails

// Validation error
function errs(
  errors: ValidationErrorDetail[]
): ErrorsResult

function validationFailed(
  errors: ValidationErrorDetail[]
): ErrorsResult

// 4xx errors
function badRequest(detail?: string): ErrorResult
function unauthorized(detail?: string): ErrorResult
function forbidden(detail?: string): ErrorResult
function notFound(detail?: string): ErrorResult

function methodNotAllowed(
  allowed: string[],
  detail?: string
): ErrorResult

function notAcceptable(detail?: string): ErrorResult
function requestTimeout(detail?: string): ErrorResult
function conflict(detail?: string): ErrorResult
function gone(detail?: string): ErrorResult
function preconditionFailed(detail?: string): ErrorResult

function payloadTooLarge(
  limitBytes?: number,
  detail?: string
): ErrorResult

function uriTooLong(detail?: string): ErrorResult

function unsupportedMediaType(
  supported?: string[],
  detail?: string
): ErrorResult

function rangeNotSatisfiable(detail?: string): ErrorResult
function unprocessableEntity(detail?: string): ErrorResult
function preconditionRequired(detail?: string): ErrorResult

function rateLimitExceeded(
  retryAfter: number,
  detail?: string
): ErrorResult

function requestHeaderFieldsTooLarge(
  fields?: string[],
  detail?: string
): ErrorResult

function unavailableForLegalReasons(
  resource?: string,
  detail?: string
): ErrorResult

// 5xx errors
function internalServerError(detail?: string): ErrorResult
function notImplemented(detail?: string): ErrorResult
function badGateway(detail?: string): ErrorResult

function serviceUnavailable(
  service: string,
  detail?: string
): ErrorResult

function gatewayTimeout(
  service?: string,
  detail?: string
): ErrorResult

// Generic error builder
function err(
  status: number,
  title?: string,
  detail?: string,
  type?: string,
  extensions?: Record<string, unknown>
): ErrorResult

// Headers for problem responses
function extraProblemHeaders(
  problem: ProblemDetails
): Record<string, string>

// Exception wrapper
function exception(err: ErrorResponse): never

// Type guard
function isErrorResponse(
  response: ResponseResult
): response is ErrorResponse
```

---

## Server Module (`server/`)

### Create App (`server/create-app.ts`)

```typescript
// App variables
interface AppVariables extends
  CorrelationVariables,
  Record<string, unknown> {}

// App environment
interface AppEnv {
  Bindings: Record<string, string>
  Variables: AppVariables
}

// App creation options
interface CreateAppOptions {
  serviceName?: string
  cors?: boolean | {
    origin: string | string[]
    methods?: string[]
    credentials?: boolean
  }
  timeout?: number
  middleware?: MiddlewareHandler[]
}

// Create Hono app with standard middleware
function createApp(
  options?: CreateAppOptions
): Hono<AppEnv>

type AppType<T extends Hono<any>> = T
```

### Server Types (`server/types.ts`)

```typescript
// Base form value types
type FormValue = File | string

// Parsed form value (specific for endpoint inputs)
type ParsedFormValue = FormValue

// Schema helpers
type SchemaFor<Input, Output = any> = z.ZodType<Output, Input>

type RecordSchemaFor<Input extends Record<string, any>, Output = any> =
  z.ZodObject<{ [K in keyof Input]: z.ZodType<Output[K], Input[K]> }>

type AnySchemaFor<I> = SchemaFor<I>

// Endpoint definition schemas
type EndpointDefinitionSchemas<
  T extends FormValue = ParsedFormValue,
  P extends string = string
> = {
  Query?: z.ZodType
  Json?: z.ZodType
  Form?: z.ZodType<T>
  Header?: z.ZodType
  Cookie?: z.ZodType
  Param?: z.ZodType
  Output?: z.ZodType
}

// Endpoint definition
type EndpointDefinition = {
  method: string
  path: string
  schemas: EndpointDefinitionSchemas
  middleware?: MiddlewareHandler[]
}

// Function app environment
interface FunctionAppEnv<Variables extends object = {}> 
  extends SharedAppEnv {
  Variables: AppVariables & Variables
}

// Build input type from schemas
type BuildInput<Schemas extends Partial<EndpointDefinitionSchemas> = {}> = 
  Input & {
    [K in keyof Schemas]: z.infer<Schemas[K]>
  }

// Endpoint handler
interface EndpointHandler<
  TEnv extends Env = Env,
  TDefinition extends EndpointDefinition = EndpointDefinition
> {
  (c: Context<TEnv, TDefinition['path'], BuildInput<TDefinition['schemas']>>):
    | Response
    | Promise<Response>
    | ResponseResult
    | Promise<ResponseResult>
}

// Endpoint middleware handler
interface EndpointMiddlewareHandler<
  TEnv extends Env = Env,
  TDefinition extends EndpointDefinition = EndpointDefinition
> {
  (
    c: Context<TEnv, TDefinition['path'], BuildInput<TDefinition['schemas']>>,
    next: Next
  ): Promise<void | Response>
}

// Handler module structure
interface EndpointHandlerModule {
  Definition: EndpointDefinition
  Handler: EndpointHandler
  Middleware?: EndpointMiddlewareHandler[]
}
```

### Server Schemas (`server/schemas.ts`)

```typescript
// String or string array helper
const ZStringOrStringArray: z.ZodUnion<[
  z.ZodString,
  z.ZodArray<z.ZodString>
]>

// Base schemas for different input sources
const BaseJsonSchema: z.ZodAny

function makeBaseFormSchema<T extends FormValue = ParsedFormValue>(): z.ZodType<T>
const BaseFormSchema: ReturnType<typeof makeBaseFormSchema>

const BaseQuerySchema: z.ZodRecord<
  z.ZodString,
  typeof ZStringOrStringArray
>

const BaseHeaderSchema: z.ZodRecord<z.ZodString, z.ZodString>

function makeHeaderSchema<
  TRequired extends Record<string, z.ZodString>,
  TOptional extends Record<string, z.ZodString> = {}
>(
  required: TRequired,
  optional?: TOptional
): z.ZodObject

const BaseCookieSchema: z.ZodRecord<z.ZodString, z.ZodString>

const BaseParamSchema: z.ZodRecord<z.ZodString, z.ZodString>
```

---

## Utils Module (`utils/`)

### Clients (`utils/clients.ts`)

```typescript
// Create admin Supabase client (service role)
function createAdminClient(): SupabaseClient

// Create user Supabase client (JWT auth)
function createUserClient(authHeader: string): SupabaseClient
```

### Config (`utils/config.ts`)

```typescript
// Supabase configuration
interface SupabaseConfig {
  url: string
  serviceRoleKey: string
  anonKey: string
}

function getSupabaseConfig(
  override?: Partial<SupabaseConfig>
): SupabaseConfig
```

### Environment (`utils/env.ts`)

```typescript
// Runtime detection
const isDeno: boolean
const isNode: boolean

// Environment variable access
function getEnv(key: string): string | undefined

function requireEnv(key: string): string
```

---

## Example Usage Patterns

### Complete Endpoint Example

```typescript
import { z } from 'zod'
import { 
  createEndpointQuerySchema,
  type QuerySpec,
  type PaginationResult,
  queryCollectionWithCount,
  buildPaginationMeta,
  paginate,
  ok,
  badRequest,
  notFound,
  createApp,
  authUserMiddleware,
  correlationMiddleware,
  type EndpointHandler,
  type FunctionAppEnv,
  type AuthUserVariables,
  BaseParamSchema,
  makeSuccessResponseSchema,
} from '../_shared/mod.ts'

// 1. Define schemas
const ParamSchema = BaseParamSchema.extend({
  id: z.string().uuid()
})

const EndpointQuerySchema = createEndpointQuerySchema({
  pagination: {
    strategy: 'cursor',
    defaultLimit: 20,
    maxLimit: 100,
    sortFields: ['created_at', 'id'],
    cursorSecret: 'secret',
    cursorTtl: 3600
  },
  filters: {
    allowedFields: ['status', 'user_id'],
    registry: {
      status: [
        { type: 'eq', valueType: 'string' },
        { type: 'in', valueType: 'array' }
      ],
      user_id: [
        { type: 'eq', valueType: 'string' }
      ]
    }
  },
  sorts: {
    allowedFields: ['created_at', 'title'],
    defaultSort: [{ field: 'created_at', direction: 'desc' }]
  }
})

const OutputSchema = makePaginationResultSchema(
  z.array(z.object({
    id: z.string(),
    title: z.string(),
    created_at: z.string()
  }))
)

const Definition = {
  method: 'GET',
  path: '/items/:id',
  schemas: {
    Param: ParamSchema,
    Query: EndpointQuerySchema,
    Output: OutputSchema
  }
}

// 2. Define handler
type AppEnv = FunctionAppEnv<AuthUserVariables>

const Handler: EndpointHandler<AppEnv, typeof Definition> = async (c) => {
  const { id } = c.req.param()
  const spec: QuerySpec = c.req.valid('query')
  const { user } = c.var
  
  // Query with filters
  const { data, error, count } = await queryCollectionWithCount(
    c.var.adminClient,
    'items',
    {
      ...spec,
      filters: [
        ...(spec.filters || []),
        { field: 'parent_id', operator: 'eq', value: id },
        { field: 'user_id', operator: 'eq', value: user.id }
      ]
    },
    'exact'
  )
  
  if (error) return badRequest(error.message)
  if (!data) return notFound()
  
  return paginate(data, spec.pagination!, {
    count,
    baseUrl: c.req.url,
    sortFields: ['created_at', 'id'],
    idField: 'id',
    secret: 'cursor-secret',
    ttl: 3600
  })
}

// 3. Mount endpoint
const app = createApp({
  serviceName: 'my-service',
  cors: true
})

app.get(
  Definition.path,
  authUserMiddleware,
  ...Definition.middleware ?? [],
  Handler
)

export default app
```

This comprehensive reference covers all utilities in the `_shared` directory with proper type signatures for Zod v4 (inferred as closely as possible).