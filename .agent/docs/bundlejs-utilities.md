# BundleJS Utilities - Type Signatures

Complete reference of all utilities from the bundlejs monorepo (`core/`, `utils/`, `compress/`, `edge/`).

---

## Compress Module (`compress/`)

### Compression (`compress.ts`)

```typescript
// Main compression function
async function compress(
  inputs: Uint8Array[] | string[],
  opts?: CompressConfig
): Promise<{
  compressedSize: string
  uncompressedSize: string
  type: CompressionType
  data: Uint8Array[]
}>

// Main decompression function
async function decompress(
  inputs: Uint8Array[] | string[],
  opts?: CompressConfig
): Promise<{
  decompressedSize: string
  compressedSize: string
  type: CompressionType
  data: Uint8Array[]
}>
```

### Configuration (`config.ts`)

```typescript
const COMPRESS_CONFIG: CompressionOptions

function createCompressConfig<O extends CompressConfig>(
  opts?: O
): CompressionOptions
```

### Types (`types.ts`)

```typescript
type CompressionType = "gzip" | "brotli" | "zstd" | "lz4"

type CompressionOptions = {
  type: CompressionType
  quality: number
}

type CompressConfig = CompressionOptions | CompressionType

// Web Streams API types
declare class CompressionStream {
  constructor(format: string)
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
}

declare class DecompressionStream {
  constructor(format: string)
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
}
```

---

## Core Module (`core/`)

### Build (`build.ts`)

```typescript
interface BuildConfig extends CommonConfigOptions {
  entryPoints: string[]
  outdir?: string
  outfile?: string
  bundle?: boolean
  splitting?: boolean
  format?: Format
  platform?: Platform
  external?: string[]
  alias?: Record<string, string>
  define?: Record<string, string>
  loader?: Record<string, Loader>
  minify?: boolean
  sourcemap?: boolean | 'inline' | 'external' | 'both'
  treeShaking?: boolean
  metafile?: boolean
  write?: boolean
  plugins?: ESBUILD.Plugin[]
}

async function build(opts: BuildConfig): Promise<ESBUILD.BuildResult>
```

### Transform (`transform.ts`)

```typescript
interface TransformConfig extends CommonConfigOptions {
  loader?: Loader
  format?: Format
  platform?: Platform
  minify?: boolean
  sourcemap?: boolean | 'inline' | 'external'
  treeShaking?: boolean
}

const TRANSFORM_CONFIG: TransformConfig

async function transform(
  input: string | Uint8Array,
  opts?: TransformConfig
): Promise<ESBUILD.TransformResult>
```

### Context (`context.ts`)

```typescript
// Global context system for sharing state across plugins
type record<T = unknown> = Record<PropertyKey, T>
type Nullable<T> = T | null
type callback = Function

class Context<T extends record = record> extends EventTarget {
  constructor(state?: T)
  
  get state(): T
  set<K extends keyof T>(key: K, value: T[K]): this
  get<K extends keyof T>(key: K): T[K]
  has<K extends keyof T>(key: K): boolean
  delete<K extends keyof T>(key: K): boolean
  clear(): this
  
  toJSON(): T
  clone(): Context<T>
  merge<U extends record>(other: Context<U>): Context<T & U>
}

interface GlobalState extends record {
  cache?: Map<string, any>
  config?: any
  plugins?: ESBUILD.Plugin[]
  [key: string]: any
}

const GlobalContext: Context<GlobalState>

// Context utilities
function fromContext<T extends keyof GlobalState>(
  key: T
): GlobalState[T] | undefined

function fromContext<State extends record, T extends keyof State>(
  ctx: Context<State>,
  key: T
): State[T] | undefined

function toContext<T extends keyof GlobalState>(
  key: T,
  value: GlobalState[T]
): void

function toContext<State extends record, T extends keyof State>(
  ctx: Context<State>,
  key: T,
  value: State[T]
): void

function withContext<NewState extends record>(
  state: NewState
): Context<NewState>

function withContext<State extends record, NewState extends record>(
  ctx: Context<State>,
  state: NewState
): Context<State & NewState>
```

### Configuration (`configs/`)

#### Config (`configs/config.ts`)

```typescript
function createConfig<T extends "build", O extends BuildConfig>(
  type: T,
  opts?: O
): BuildConfig

function createConfig<T extends "transform", O extends TransformConfig>(
  type: T,
  opts?: O
): TransformConfig

function createConfig<T extends "context", O extends BuildConfig>(
  type: T,
  opts?: O
): BuildConfig
```

#### Events (`configs/events.ts`)

```typescript
const EVENT_NAME_PREFIX: string

function EventName<T extends string>(name: T): `bundlejs:${T}`

// Event names
const INIT_START: string
const INIT_COMPLETE: string
const INIT_ERROR: string
const INIT_LOADING: string

const LOGGER_LOG: string
const LOGGER_ERROR: string
const LOGGER_WARN: string
const LOGGER_INFO: string

const BUILD_ERROR: string
const TRANSFORM_ERROR: string

interface IEVENT_MAP {
  [INIT_START]: CustomEvent<{ timestamp: number }>
  [INIT_COMPLETE]: CustomEvent<{ duration: number }>
  [INIT_ERROR]: CustomEvent<Error>
  [LOGGER_LOG]: CustomEvent<unknown[]>
  [LOGGER_ERROR]: CustomEvent<unknown[]>
  [LOGGER_WARN]: CustomEvent<unknown[]>
  [LOGGER_INFO]: CustomEvent<unknown[]>
  [BUILD_ERROR]: CustomEvent<Error>
  [TRANSFORM_ERROR]: CustomEvent<Error>
}

const EVENT_TARGET: EventTarget

class CustomEvent<T = unknown> extends Event {
  detail: T
  constructor(type: string, options?: { detail?: T })
}

function addEventListener<K extends keyof IEVENT_MAP>(
  type: K,
  listener: (event: IEVENT_MAP[K]) => void,
  options?: AddEventListenerOptions
): void

function removeEventListener<K extends keyof IEVENT_MAP>(
  type: K,
  listener: (event: IEVENT_MAP[K]) => void
): void

function dispatchEvent<K extends keyof IEVENT_MAP, A extends IEVENT_MAP[K] = any>(
  type: K,
  detail?: A['detail']
): boolean
```

#### Logger (`configs/logger.ts`)

```typescript
const initLogger: Logger<'init'>
const buildLogger: Logger<'build'>
const generalLogger: Logger<'general'>

type LogTemplatePrefix = (
  level: LogLevel,
  loggerName: string,
  timestamp: Date
) => string

type LogCallback = (prefix: LogTemplatePrefix) => unknown[]

type LogLevel = "error" | "warn" | "info" | "debug" | "fatal"

interface LoggerOptions<L extends string> {
  name?: L
  level?: LogLevel
  prefix?: LogTemplatePrefix
  handlers?: {
    log?: LogCallback
    error?: LogCallback
    warn?: LogCallback
    info?: LogCallback
    debug?: LogCallback
    fatal?: LogCallback
  }
}

class Logger<L extends string = "general"> {
  constructor(options?: LoggerOptions<L>)
  
  log(...args: unknown[]): void
  error(...args: unknown[]): void
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
  debug(...args: unknown[]): void
  fatal(...args: unknown[]): void
  
  child<T extends string>(name: T): Logger<`${L}:${T}`>
  
  setLevel(level: LogLevel): this
  getLevel(): LogLevel
  
  toJSON(): LoggerOptions<L>
}

type LoggerWithCustomLoggers<L extends string> = Logger<L> & {
  [K in LogLevel]: (...args: unknown[]) => void
}

function createLogger<L extends string>(
  options?: LoggerOptions<L>
): LoggerWithCustomLoggers<L>
```

#### Platform (`configs/platform.ts`)

```typescript
type Platform = "browser" | "node" | "neutral"
type Format = "iife" | "cjs" | "esm"
type ImportKind =
  | "entry-point"
  | "import-statement"
  | "require-call"
  | "dynamic-import"
  | "require-resolve"
  | "import-rule"
  | "composes-from"
  | "url-token"

type ResolveRuntime =
  | "node"
  | "deno"
  | "bun"
  | "browser"
  | "edge-light"
  | "workerd"
  | "electron"
  | "electron-main"
  | "electron-renderer"
  | "react-native"

interface ResolverConditionInputs {
  runtime?: ResolveRuntime
  platform?: Platform
  importKind?: ImportKind
  format?: Format
  custom?: string[]
}

interface ResolverConditions {
  conditions: string[]
  runtime: ResolveRuntime
  platform: Platform
  format: Format
  importKind: ImportKind
}

interface RuntimeDefaults {
  platform: Platform
  format: Format
  conditions: string[]
  mainFields: string[]
}

const KNOWN_CONDITIONS: Record<string, string[]>
const DEFAULT_MAIN_FIELDS: Record<ResolveRuntime, string[]>

function detectRuntime(): ResolveRuntime | null

function getPlatformForRuntime(runtime: ResolveRuntime): Platform

function getRuntimeDefaults(
  runtime: ResolveRuntime,
  options?: {
    importKind?: ImportKind
    format?: Format
  }
): RuntimeDefaults

function isRequireKind(kind: ImportKind): boolean

function isRequireContext(
  runtime: ResolveRuntime,
  kind: ImportKind
): boolean

function getResolverConditions(
  inputs: ResolverConditionInputs
): ResolverConditions

function getLegacyMainFields(
  runtime: ResolveRuntime,
  format?: Format
): string[]

function conditionMatches(
  condition: string,
  conditions: string[]
): boolean

function mergeConditions(
  ...conditionSets: string[][]
): string[]

function describeCondition(condition: string): string
```

### Plugins (`plugins/`)

#### Alias Plugin (`plugins/alias.ts`)

```typescript
const ALIAS_NAMESPACE: string

interface AliasResolutionState<T> extends LocalState<T> {
  aliases: Record<string, string>
}

function isAlias(
  id: string,
  aliases?: Record<string, string>
): boolean

function AliasResolution<T>(
  StateContext: Context<AliasResolutionState<T>>
): ESBUILD.OnResolveResult

function AliasPlugin<T>(
  StateContext: Context<LocalState<T>>
): ESBUILD.Plugin
```

#### CDN Plugin (`plugins/cdn.ts`)

```typescript
type CDNStyle = "npm" | "jsr" | "github" | "deno" | "tarball" | "other"

type CDNScheme =
  | "unpkg"
  | "jsdelivr"
  | "esm.sh"
  | "skypack"
  | "jspm"
  | "ga.jspm.io"
  | "esm.run"
  | "jsr"
  | "github-raw"
  | "deno.land"

interface CDNUrlResult {
  url: string
  origin: string
  style: CDNStyle
  scheme: CDNScheme
  pathname: string
  search: string
  hash: string
}

const DEFAULT_CDN_HOST: string
const JSR_REGISTRY: string
const CDN_SCHEME_TO_ORIGIN: Record<CDNScheme, string>

function getCDNStyle(urlStr: string): CDNStyle

function isCDNStyle(urlStr: string, style: CDNStyle): boolean

function getCDNOrigin(
  importStr: string,
  cdn?: string
): string

function getPureImportPath(importStr: string): string

function getCDNUrl(
  importStr: string,
  cdn?: string
): CDNUrlResult

function parseJSRSpecifier(specifier: string): {
  scope: string
  name: string
  version: string
  path?: string
} | null

function getJSRDirectUrl(
  scope: string,
  name: string,
  version: string,
  path?: string
): string

function getJSRProxyUrl(
  scope: string,
  name: string,
  version: string,
  path?: string
): string

function isJSRSpecifier(str: string): boolean
function isNpmCDN(str: string): boolean
function isGitHubRaw(str: string): boolean
```

#### External Plugin (`plugins/external.ts`)

```typescript
interface ExternalPatternsOptions {
  runtime?: ResolveRuntime
  builtins?: boolean
  nodeProtocol?: boolean
  nodeBuiltinsOnly?: boolean
  includePolyfills?: boolean
}

function createExternalPatterns(
  options?: ExternalPatternsOptions
): string[]
```

#### HTTP Plugin (`plugins/http.ts`)

```typescript
// HTTP resolution plugin for fetching remote modules
function HttpPlugin(): ESBUILD.Plugin
```

#### Filesystem Plugin (`plugins/fs.ts`)

```typescript
// File System Access API types
interface FileSystemFileHandleWithPath extends FileSystemFileHandle {
  path?: string
}

type WriterableFileStreamData =
  | BufferSource
  | Blob
  | DataView
  | Uint8Array
  | String
  | string

type FileSystemWritableFileStreamData =
  | WriterableFileStreamData
  | {
      type: "write"
      position?: number
      data: WriterableFileStreamData
    }
  | {
      type: "seek"
      position: number
    }
  | {
      type: "truncate"
      size: number
    }

interface FileSystemWritableFileStream extends WritableStream {
  write(data: FileSystemWritableFileStreamData): Promise<void>
  seek(position: number): Promise<void>
  truncate(size: number): Promise<void>
}

interface FileSystemCreateWritableOptions {
  keepExistingData?: boolean
}

interface FileSystemReadWriteOptions {
  at?: number
}

interface FileSystemSyncAccessHandle {
  close(): void
  flush(): void
  getSize(): number
  read(buffer: ArrayBuffer | ArrayBufferView, options?: FileSystemReadWriteOptions): number
  truncate(newSize: number): void
  write(buffer: ArrayBuffer | ArrayBufferView, options?: FileSystemReadWriteOptions): number
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: "file"
  getFile(): Promise<File>
  createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>
  createSyncAccessHandle?(): Promise<FileSystemSyncAccessHandle>
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: "directory"
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>
  resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null>
  keys(): AsyncIterableIterator<string>
  values(): AsyncIterableIterator<FileSystemHandle>
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  [Symbol.asyncIterator](): AsyncIterableIterator<[string, FileSystemHandle]>
}
```

### Utils (`core/utils/`)

#### CDN Format (`utils/cdn-format.ts`)

```typescript
// Parse and format CDN URLs
function normalizePkgRelPath(input: string): string

function isJsLikePath(input: string): boolean
```

#### Create Notice (`utils/create-notice.ts`)

```typescript
async function createNotice(
  errors: PartialMessage[],
  kind?: "error" | "warning",
  color?: boolean
): Promise<string>
```

#### Loader (`utils/loader.ts`)

```typescript
const RESOLVE_EXTENSIONS: string[]

const inferLoader: (
  urlStr: string,
  contentType?: string | null
) => Loader
```

#### Side Effects (`utils/side-effects.ts`)

```typescript
interface SideEffectsMatchers {
  include: RegExp[]
  exclude: RegExp[]
}

function normalizeSideEffectsPattern(pattern: string): string

function compileSideEffectsMatchers(
  sideEffects: readonly string[]
): SideEffectsMatchers

function computeEsbuildSideEffects(
  matchers: SideEffectsMatchers,
  filepath: string
): boolean | undefined
```

---

## Utils Module (`utils/`)

### ANSI Rendering (`ansi.ts`)

```typescript
const ESCAPE_TO_COLOR: Record<string, string>

type Escape = "0" | "1" | "4" | keyof typeof ESCAPE_TO_COLOR
type Color = typeof ESCAPE_TO_COLOR[keyof typeof ESCAPE_TO_COLOR]

class AnsiBuffer {
  constructor()
  push(text: string, ...escapes: Escape[]): this
  toString(): string
}

function render(ansi: string): string

// Alias
export { render as ansi }
```

### Archive Detection (`archive-detect.ts`, `archive-spec.ts`)

```typescript
// Detect and parse archive formats (tar, zip, etc.)
// See @std/tar for implementation details
```

### Assertions (`assert.ts`)

```typescript
// Re-export from @std/assert
export * from "@std/assert"
```

### Async Utilities (`async.ts`)

```typescript
// Re-export from @std/async
export * from "@std/async"
```

### Bytes (`bytes.ts`)

```typescript
// Re-export from @std/bytes
export * from "@std/bytes"
```

### Deep Object Utilities (`deep-object.ts`)

```typescript
const isObject: (obj: unknown) => boolean
const isPrimitive: (val: unknown) => boolean
const isValidKey: (key: unknown) => boolean

function deepEqual(obj1: any, obj2: any): boolean

function deepDiff(obj1: any, obj2: any): any

const deepAssign: typeof deepMerge

function deepMerge<T, U>(obj1: T, obj2: U): T & U

type DeepMerge<T, U> = /* complex type */
```

### Encode/Decode (`encode-decode.ts`)

```typescript
const encode: (str: string) => Uint8Array
const decode: (buf: BufferSource) => string
```

### Encoding (`encoding.ts`)

```typescript
// Re-exports from @std/encoding
export * from "@std/encoding/ascii85"
export * from "@std/encoding/base32"
export * from "@std/encoding/base58"
export * from "@std/encoding/base64"
export * from "@std/encoding/base64url"
export * from "@std/encoding/hex"
export * from "@std/encoding/varint"

export * as ascii85 from "@std/encoding/ascii85"
export * as base32 from "@std/encoding/base32"
export * as base58 from "@std/encoding/base58"
export * as base64 from "@std/encoding/base64"
export * as base64url from "@std/encoding/base64url"
export * as hex from "@std/encoding/hex"
export * as varint from "@std/encoding/varint"
```

### Fetch and Cache (`fetch-and-cache.ts`)

```typescript
// Cached fetch utilities for HTTP requests
// Implementation details depend on runtime
```

### Formatting (`fmt.ts`)

```typescript
export * as bytes from "@std/fmt/bytes"
export * as duration from "@std/fmt/duration"
export * from "@std/fmt/colors"
export * from "@std/fmt/printf"
```

### HTML (`html.ts`)

```typescript
export * from "@std/html"
```

### JSON Streams (`json-streams.ts`)

```typescript
export * from "@std/json"
export * from "@std/jsonc"
```

### JSON5 (`json5.ts`)

```typescript
function parse<T = any>(
  text: string,
  reviver?: (this: any, key: string, value: any) => any | null
): T

function stringify(
  value: any,
  replacer?: (this: any, key: string, value: any) => any | null,
  space?: string | number
): string

function require(path: string | URL): any

async function requireAsync(path: string | URL): Promise<any>

const JSON5: {
  parse: typeof parse
  stringify: typeof stringify
}
```

### JSR Spec (`jsr-spec.ts`)

```typescript
interface JSRSpec {
  scope: string
  name: string
  version?: string
  path?: string
  fullName: string
  raw: string
}

interface JSRPackageMeta {
  scope: string
  name: string
  description?: string
  runtimeCompat: {
    deno?: string
    node?: string
    browser?: boolean
  }
  versions: Record<string, string>
  latest: string
}

interface JSRVersionSummary {
  version: string
  yanked: boolean
  createdAt: string
  updatedAt: string
}

interface JSRVersionMeta {
  scope: string
  name: string
  version: string
  manifest: Record<string, string>
  exports: Record<string, string>
  moduleGraph?: any
}

interface JSRFileInfo {
  path: string
  size: number
  checksum: string
}

interface JSRNpmMeta {
  package: string
  versions: string[]
}

interface JSRNpmVersionMeta {
  version: string
  dist: {
    tarball: string
  }
}

interface JSRNameValidation {
  valid: boolean
  error?: string
}

interface JSRSearchResult {
  items: JSRPackageInfo[]
  total: number
}

interface JSRPackageInfo {
  scope: string
  name: string
  description?: string
  runtimeCompat: {
    deno?: string
    node?: string
    browser?: boolean
  }
  score: number
}

const JSR_REGISTRY: string
const JSR_API: string
const JSR_NPM_REGISTRY: string

const JSR_SCOPE_RULES: {
  minLength: number
  maxLength: number
  pattern: RegExp
}

const JSR_PACKAGE_RULES: {
  minLength: number
  maxLength: number
  pattern: RegExp
}

function parseJSRSpec(input: string): JSRSpec | null

function isJSRSpec(input: string): boolean

function looksLikeJSRSpec(input: string): boolean

function validateJSRScope(scope: string): JSRNameValidation

function validateJSRPackageName(name: string): JSRNameValidation

function validateJSRFullName(fullName: string): JSRNameValidation

function getJSRPackageMetaUrl(scope: string, name: string): string

function getJSRVersionMetaUrl(
  scope: string,
  name: string,
  version: string
): string

function getJSRModuleUrl(
  scope: string,
  name: string,
  version: string,
  path: string
): string

function getJSRNpmUrl(scope: string, name: string): string

function getJSRTarballUrl(
  scope: string,
  name: string,
  version: string
): string

function getJSRUrls(spec: JSRSpec): {
  registry: string
  api: string
  package: string
  version: string
  module: string
  npm: string
  tarball: string
}

function toNpmCompatName(scope: string, name: string): string

function fromNpmCompatName(npmName: string): {
  scope: string
  name: string
  fullName: string
} | null

function jsrToEsmSh(spec: JSRSpec): string

function jsrSpecToEsmSh(input: string): string | null

async function getJSRPackage(
  scope: string,
  name: string
): Promise<JSRPackageMeta>

async function getJSRVersionMeta(
  scope: string,
  name: string,
  version: string
): Promise<JSRVersionMeta>

async function getJSRVersions(
  scope: string,
  name: string
): Promise<JSRVersionSummary[]>

async function resolveJSRVersion(
  scope: string,
  name: string,
  versionRange?: string
): Promise<string>

async function resolveJSRSpec(spec: JSRSpec): Promise<JSRSpec>

async function searchJSR(
  query: string,
  options?: {
    limit?: number
    offset?: number
  }
): Promise<JSRSearchResult>

function generateImportMapEntries(
  spec: JSRSpec,
  meta: JSRVersionMeta
): Record<string, string>
```

### LRU Cache (`lru.ts`)

```typescript
// LRU cache implementation
// Likely uses Velo or similar
```

### LZ-String (`lz-string.ts`)

```typescript
const keyStrBase64: string
const keyStrUriSafe: string
const baseReverseDic: Record<string, Record<string, number>>

function getBaseValue(alphabet: string, character: string): number

function compressToBase64(input: string): string

function decompressFromBase64(input: string): string | null

function compressToURL(input: string): string

function decompressFromURL(input: string): string | null

function compressToUTF16(input: string): string

function decompressFromUTF16(compressed: string): string | null

function compress(uncompressed: string): string

function decompress(compressed: string | null): string | null

// Internal compression/decompression
function _compress(
  uncompressed: string,
  bitsPerChar: number,
  getCharFromInt: (n: number) => string
): string

function _decompress(
  length: number,
  resetValue: number,
  getNextValue: (index: number) => number
): string | null
```

### Media Types (`media-types.ts`)

```typescript
export * from "@std/media-types"

type ParseIssueCode =
  | "invalid_syntax"
  | "invalid_value"
  | "missing_required"
  | "unexpected_extra"

type ParseIssue = {
  code: ParseIssueCode
  message: string
  path?: string[]
}

type ParseResult<T> =
  | { success: true; value: T }
  | { success: false; issues: ParseIssue[] }

type MediaType = {
  type: string
  subtype: string
  parameters: Map<string, string>
}

function parseContentTypeStrict(
  input: string
): ParseResult<MediaType>

function canonicalizeContentType(
  input: string
): string | null

type ContentCodingList = readonly string[]

function parseContentEncodingStrict(
  input: string
): ParseResult<ContentCodingList>

function getPrimaryContentCoding(
  input: string
): string | null

type ContentDisposition = {
  type: "inline" | "attachment"
  parameters: Map<string, string>
}

function parseContentDispositionStrict(
  input: string
): ParseResult<ContentDisposition>

function parseContentDispositionLenient(
  input: string
): ContentDisposition | null

function extractFilenameFromContentDisposition(
  input: string
): string | null

function decodeRfc8187Value(value: string): string | null

// Parser state and helpers
type ParserState = {
  input: string
  pos: number
  length: number
}

function skipOWS(state: ParserState): void

function isToken(value: string): boolean

function isTchar(ch: number): boolean

function consumeChar(state: ParserState, ch: string): boolean

function readToken(
  state: ParserState,
  allowEmpty?: boolean
): string | null

function readTokenOrQuotedString(state: ParserState): string | null

function readQuotedString(state: ParserState): string | null

function scanForParamValue(
  input: string,
  paramName: string
): string | null

function stripQuotes(value: string): string
```

### NPM Spec (`npm-spec.ts`)

```typescript
interface GitFragment {
  semver?: string
  committish?: string
}

interface HostedGitInfo {
  type: "github" | "gitlab" | "bitbucket" | "gist"
  user: string
  repo: string
  fragment?: GitFragment
  committish?: string
}

interface RegistrySpec {
  type: "registry"
  name: string
  version: string
  raw: string
}

interface AliasSpec {
  type: "alias"
  alias: string
  target: NpmDependencySpec
  raw: string
}

interface UrlSpec {
  type: "url"
  url: string
  raw: string
}

interface GitSpec {
  type: "git"
  hosted?: HostedGitInfo
  gitUrl: string
  committish?: string
  raw: string
}

interface FileSpec {
  type: "file"
  path: string
  raw: string
}

interface DirectorySpec {
  type: "directory"
  path: string
  raw: string
}

interface WorkspaceSpec {
  type: "workspace"
  name: string
  raw: string
}

interface LinkSpec {
  type: "link"
  path: string
  raw: string
}

interface UnknownSpec {
  type: "unknown"
  raw: string
}

type NpmDependencySpec =
  | RegistrySpec
  | AliasSpec
  | UrlSpec
  | GitSpec
  | FileSpec
  | DirectorySpec
  | WorkspaceSpec
  | LinkSpec
  | UnknownSpec

function isGitHubShorthand(arg: string): boolean

function parseGitFragment(fragment: string): GitFragment

function parseNpmSpec(raw: string): NpmDependencySpec

function isUrlSpec(spec: NpmDependencySpec): spec is UrlSpec

function isAliasSpec(spec: NpmDependencySpec): spec is AliasSpec

function isGitSpec(spec: NpmDependencySpec): spec is GitSpec

function isRegistrySpec(spec: NpmDependencySpec): spec is RegistrySpec

function isUnsupportedSpec(spec: NpmDependencySpec): boolean

function isNpmVersionSpec(spec: NpmDependencySpec): boolean

function joinSubpath(a: string, b: string): string

function appendUrlSubpath(baseUrl: string, subpath: string): string
```

### NPM Search (`npm-search.ts`)

```typescript
interface ParsedPackageName {
  name: string
  scope?: string
}

interface RegistryURLs {
  registry: string
  api: string
}

interface PackageURLs {
  package: string
  version: string
  tarball: string
}

interface PackageSearchResult {
  objects: SearchObject[]
  total: number
  time: string
}

interface SearchPackage {
  name: string
  scope: string
  version: string
  description: string
  keywords: string[]
  date: string
  links: Links
  author: Author
  publisher: Publisher
  maintainers: Maintainer[]
}

interface Links {
  npm?: string
  homepage?: string
  repository?: string
  bugs?: string
}

type Author = string | {
  name: string
  email?: string
  url?: string
}

interface Publisher {
  username: string
  email: string
}

interface Maintainer {
  username: string
  email: string
}

interface SearchInfo {
  quality: number
  popularity: number
  maintenance: number
}

interface SearchObject {
  package: SearchPackage
  score: Score
  searchScore: number
  flags?: Flags
}

interface Flags {
  insecure?: number
  unstable?: boolean
}

interface Score {
  final: number
  detail: Detail
}

interface Detail {
  quality: number
  popularity: number
  maintenance: number
}

interface PackageInfo {
  name: string
  versions: Record<string, FullPackageVersion>
  "dist-tags": Record<string, string>
  time: Record<string, string>
}

interface FullPackage {
  _id: string
  _rev: string
  name: string
  description: string
  "dist-tags": Record<string, string>
  versions: Record<string, FullPackageVersion>
  maintainers: Maintainer[]
  time: Record<string, string>
  author: Author
  repository: {
    type: string
    url: string
  }
  readme: string
  readmeFilename: string
  homepage: string
  keywords: string[]
  bugs: {
    url: string
  }
  license: string
}

interface FullPackageVersion {
  name: string
  version: string
  description: string
  main: string
  module?: string
  types?: string
  typings?: string
  exports?: Record<string, any>
  scripts: Record<string, string>
  repository: {
    type: string
    url: string
  }
  keywords: string[]
  author: Author
  license: string
  bugs: {
    url: string
  }
  homepage: string
  devDependencies: Record<string, string>
  dependencies: Record<string, string>
  peerDependencies?: Record<string, string>
  dist: {
    integrity: string
    shasum: string
    tarball: string
    fileCount: number
    unpackedSize: number
  }
  directories: Record<string, string>
  _id: string
  _nodeVersion: string
  _npmVersion: string
  _hasShrinkwrap: boolean
}

interface PackageJson {
  name: string
  version: string
  description?: string
  main?: string
  module?: string
  types?: string
  typings?: string
  exports?: Record<string, any>
  imports?: Record<string, any>
  browser?: string | Record<string, string | boolean>
  bin?: string | Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  bundledDependencies?: string[]
  bundleDependencies?: string[]
  engines?: Record<string, string>
  os?: string[]
  cpu?: string[]
  private?: boolean
  publishConfig?: Record<string, any>
  workspaces?: string[] | {
    packages: string[]
  }
  repository?: string | {
    type: string
    url: string
    directory?: string
  }
  keywords?: string[]
  author?: Author
  contributors?: Author[]
  license?: string
  bugs?: string | {
    url?: string
    email?: string
  }
  homepage?: string
  funding?: string | {
    type: string
    url: string
  } | Array<{
    type: string
    url: string
  }>
  files?: string[]
  man?: string | string[]
  directories?: {
    lib?: string
    bin?: string
    man?: string
    doc?: string
    example?: string
    test?: string
  }
  config?: Record<string, any>
  sideEffects?: boolean | string[]
}
```

### Outdent (`outdent.ts`)

```typescript
export * from "outdent"
export { default } from "outdent"
```

### Parse Package Name (`parse-package-name.ts`)

```typescript
const WHITESPACE_ENCODINGS: Record<string, string>

function encodeWhitespace(string: string): string

const urlJoin: (urlStr: string, ...args: string[]) => string

function toURLPath(url: string | URL, base?: URL | string): string
```

### Path (`path.ts`)

```typescript
// Re-export from @std/path
export * from "@std/path"
```

### Resolve Conditions (`resolve-conditions.ts`)

```typescript
// See Platform types above for condition resolution
```

### Resolve Exports/Imports (`resolve-exports-imports.ts`)

```typescript
// Re-export from resolve.exports
export * from "resolve.exports"
```

### Resolve Import Map (`resolve-import-map.ts`)

```typescript
interface ImportMap {
  imports?: Record<string, string>
  scopes?: Record<string, Record<string, string>>
  integrity?: Record<string, string>
}

interface GenerateImportMapOptions {
  cdn?: string
  scope?: string
  includeIntegrity?: boolean
}

interface ImportMapValidation {
  valid: boolean
  errors: string[]
  warnings: string[]
}

const CDN_TEMPLATES: Record<string, (name: string, version: string) => string>

function createImportMap(config: ImportMap): ImportMap

function generateImportMap(
  dependencies: Record<string, string>,
  options?: GenerateImportMapOptions
): Promise<ImportMap>

function mergeImportMaps(...maps: ImportMap[]): ImportMap

function addToImportMap(
  map: ImportMap,
  key: string,
  value: string,
  scope?: string
): ImportMap

function resolveImportMap(
  specifier: string,
  map: ImportMap,
  parentUrl?: string
): string | null

function getIntegrity(map: ImportMap, url: string): string | null

function validateImportMap(map: ImportMap): ImportMapValidation

function serializeImportMap(
  map: ImportMap,
  pretty?: boolean
): string

function parseImportMap(json: string): ImportMap

function toScriptTag(map: ImportMap): string

function toDenoConfig(map: ImportMap): {
  imports: Record<string, string>
  scopes?: Record<string, Record<string, string>>
}

function fromDenoConfig(config: {
  imports?: Record<string, string>
  scopes?: Record<string, Record<string, string>>
}): ImportMap
```

### Runtime Builtins (`runtime-builtins.ts`)

```typescript
type RuntimeTarget = "node" | "deno" | "bun" | "browser" | "workerd"

type BuiltinCategory =
  | "core"
  | "async"
  | "fs"
  | "network"
  | "crypto"
  | "process"
  | "worker"
  | "stream"

interface BuiltinInfo {
  name: string
  category: BuiltinCategory
  polyfill?: string
  deprecated?: boolean
  added?: string
  removed?: string
  replacedBy?: string
  docs?: string
}

interface PolyfillConfig {
  target: RuntimeTarget
  profile?: PolyfillProfile
  includeSubpaths?: boolean
  includeExperimental?: boolean
}

const NODE_BUILTINS: Record<string, BuiltinInfo>
const BUILTIN_NAMES: Set<string>
const DEPRECATED_API_PATHS: string[]

function isBuiltin(specifier: string): boolean

function getBuiltinName(specifier: string): string | null

function getBuiltinInfo(specifier: string): BuiltinInfo | null

function normalizeBuiltin(specifier: string): string

function stripNodePrefix(specifier: string): string

function getBuiltinSubpath(specifier: string): string | null

function getPolyfill(specifier: string): string | null

function hasPolyfill(specifier: string): boolean

function getAllPolyfills(): [string, string][]

function getBuiltinList(
  options?: {
    includeDeprecated?: boolean
    category?: BuiltinCategory
  }
): string[]

function isBuiltinSupported(
  specifier: string,
  runtime: RuntimeTarget
): boolean

function getBuiltinsForRuntime(
  runtime: RuntimeTarget,
  options?: {
    includePolyfills?: boolean
    includeExperimental?: boolean
  }
): string[]

const EXTENDED_POLYFILLS: Record<string, string>
const SUBPATH_POLYFILLS: Record<string, string>

type PolyfillProfile = "conservative" | "aggressive" | "maximal"

function createPolyfillMapWithProfile(
  profile: PolyfillProfile,
  runtime: RuntimeTarget
): Record<string, string>

function createLegacyPolyfillMap(): Record<string, string>

const ALWAYS_EXTERNAL: string[]

function getExternalPackages(): string[]
```

### Semver (`semver.ts`)

```typescript
export * from "@std/semver"
```

### Tar (`tar.ts`)

```typescript
export * from "@std/tar"
```

### URL (`url.ts`)

```typescript
// URL manipulation utilities
// Implementation extends standard URL APIs
```

### Validate Package Name (`validate-package-name.ts`)

```typescript
interface ValidateResult {
  validForNewPackages: boolean
  validForOldPackages: boolean
  errors?: string[]
  warnings?: string[]
}

function validatePackageName(name: string): ValidateResult

function isValidPackageName(name: string): boolean

function isNodeBuiltin(name: string): boolean

function getNodeBuiltins(): string[]

const NODE_BUILTINS: Record<string, BuiltinInfo>
const BLACKLIST: string[]
```

---

## Edge Module (`edge/`)

### Bundle (`bundle.ts`)

```typescript
// Edge function bundling utilities
// Integrates with build system for serverless deployment
```

### Generate Result (`generate-result.ts`)

```typescript
const timeFormatter: Intl.RelativeTimeFormat

const docs: {
  title: string
  description: string
  examples: string[]
}

async function generateResult(
  [badgeKey, badgeID]: string[],
  [value, resultText]: [BundleResult, string | undefined],
  url: URL,
  cached: boolean,
  duration: number,
  redis?: Redis | null
): Promise<Response>

function generateHTMLMessages(msgs: string[]): string
```

### Gist (`gist.ts`)

```typescript
const GIST_CACHE: LRUCache<string, string>
const CustomOctokit: typeof Octokit

const octokit: InstanceType<typeof CustomOctokit>

const BUNDLE_FILE_PATH: string

async function setFile(
  url: string,
  files: ESBUILD.OutputFile[]
): Promise<void>

function listFiles(): string[]

async function getFile(id: string): Promise<string | null>

async function deleteFile(id: string): Promise<void>
```

### Parse Query (`parse-query.ts`)

```typescript
function parseTreeshakeExports(str: string): string[]

function fromBasename(path: string): string

function getModuleName(str: string): string

function parseShareURLQuery(shareURL: URL): {
  code: string
  config: any
}

function parseConfig(shareURL: URL): any
```

---

## Complete Example: Building with All Utilities

```typescript
import {
  // Core build
  build,
  transform,
  createConfig,
  type BuildConfig,
  type TransformConfig,
  
  // Context system
  Context,
  GlobalContext,
  fromContext,
  toContext,
  
  // Plugins
  AliasPlugin,
  HttpPlugin,
  createExternalPatterns,
  
  // CDN utilities
  getCDNUrl,
  isJSRSpecifier,
  parseJSRSpec,
  resolveJSRSpec,
  
  // NPM utilities
  parseNpmSpec,
  isRegistrySpec,
  validatePackageName,
  
  // Compression
  compress,
  decompress,
  
  // Encoding
  encode,
  decode,
  base64,
  
  // Import maps
  generateImportMap,
  resolveImportMap,
  
  // Runtime detection
  detectRuntime,
  getRuntimeDefaults,
  getResolverConditions,
  
  // Builtins
  isBuiltin,
  getPolyfill,
  getBuiltinsForRuntime,
  
  // Logger
  createLogger,
  
  // Events
  addEventListener,
  dispatchEvent,
  BUILD_ERROR,
} from '@bundle/core'

// Create context with shared state
const ctx = new Context({
  cache: new Map(),
  aliases: {
    'react': 'https://esm.sh/react@18',
    'react-dom': 'https://esm.sh/react-dom@18'
  }
})

// Create logger
const logger = createLogger({ name: 'my-bundler' })

// Listen for build errors
addEventListener(BUILD_ERROR, (event) => {
  logger.error('Build failed:', event.detail)
})

// Configure build
const config = createConfig('build', {
  entryPoints: ['./src/index.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  external: createExternalPatterns({
    runtime: 'browser',
    builtins: true
  }),
  plugins: [
    AliasPlugin(ctx),
    HttpPlugin()
  ]
})

// Build
const result = await build(config)

// Compress output
const compressed = await compress(
  result.outputFiles.map(f => f.contents),
  'brotli'
)

logger.info('Build complete:', {
  size: compressed.compressedSize,
  files: result.outputFiles.length
})
```

---

This comprehensive reference covers all major utilities from the bundlejs monorepo. The actual implementation contains 600+ exports across compression, core build system, context management, plugins, and extensive utilities for working with CDNs, package specs, and runtime environments.