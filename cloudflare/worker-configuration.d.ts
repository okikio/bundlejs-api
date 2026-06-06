declare interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

declare interface Fetcher {
  fetch(input: Request | URL | string): Promise<Response>;
}

declare interface DurableObjectId {}

declare interface DurableObjectNamespace<Stub = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): Stub;
}

declare interface KVNamespacePutOptions {
  expiration?: number;
  expirationTtl?: number;
  metadata?: unknown;
}

declare interface KVNamespaceListKey {
  name: string;
  expiration?: number;
  metadata?: unknown;
}

declare interface KVNamespaceListResult {
  keys: KVNamespaceListKey[];
  list_complete: boolean;
  cursor?: string;
}

declare interface KVNamespaceListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

declare interface KVNamespace {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  get(key: string, type: "text"): Promise<string | null>;
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: KVNamespacePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KVNamespaceListOptions): Promise<KVNamespaceListResult>;
}

declare interface R2HTTPMetadata {
  contentType?: string;
  cacheControl?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
}

declare interface R2PutOptions {
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

declare interface R2Object {
  key: string;
  size: number;
  body?: ReadableStream;
  httpMetadata?: R2HTTPMetadata;
}

declare interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

declare interface R2Objects {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

declare interface R2Bucket {
  get(key: string, options?: unknown): Promise<R2ObjectBody | R2Object | null>;
  head(key: string): Promise<R2Object | null>;
  list(options?: { prefix?: string; limit?: number; cursor?: string; delimiter?: string }): Promise<R2Objects>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob, options?: R2PutOptions): Promise<R2Object | null>;
  delete(key: string | string[]): Promise<void>;
}

declare interface SqlStorageCursor<Row = Record<string, unknown>> extends Iterable<Row> {
  one(): Row;
  toArray(): Row[];
}

declare interface SqlStorage {
  exec<Row = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<Row>;
}

declare interface DurableObjectStorage {
  sql: SqlStorage;
  deleteAll(): Promise<void>;
}

declare interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

declare abstract class DurableObject {
  protected readonly ctx: DurableObjectState;
  protected readonly env: unknown;

  constructor(ctx: DurableObjectState, env: unknown);
}

declare interface ExportedHandler<Env = unknown> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}