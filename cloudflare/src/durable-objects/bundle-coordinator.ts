import type { CoordinatorRecord } from "../types.ts";

type CoordinatorRow = {
  bundle_key: string;
  normalized_request: string | null;
  status: CoordinatorRecord["status"];
  workflow_id: string | null;
  artifact_key: string | null;
  response_cache_key: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

function mapRow(row: CoordinatorRow | null | undefined): CoordinatorRecord | null {
  if (!row) {
    return null;
  }

  return {
    bundleKey: row.bundle_key,
    normalizedRequest: row.normalized_request,
    status: row.status,
    workflowId: row.workflow_id,
    artifactKey: row.artifact_key,
    responseCacheKey: row.response_cache_key,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class BundleCoordinator {
  ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS build_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          bundle_key TEXT NOT NULL,
          normalized_request TEXT,
          status TEXT NOT NULL,
          workflow_id TEXT,
          artifact_key TEXT,
          response_cache_key TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
      `);
    });
  }

  async getStatus(bundleKey: string): Promise<CoordinatorRecord | null> {
    const row = this.ctx.storage.sql.exec<CoordinatorRow>(`
      SELECT bundle_key, normalized_request, status, workflow_id, artifact_key,
        response_cache_key, error_message, created_at, updated_at
      FROM build_state
      WHERE id = 1 AND bundle_key = ?
    `, bundleKey).toArray()[0];

    return mapRow(row);
  }

  async initialize(bundleKey: string, normalizedRequest: string): Promise<CoordinatorRecord> {
    const now = Date.now();

    this.ctx.storage.sql.exec(`
      INSERT INTO build_state (
        id,
        bundle_key,
        normalized_request,
        status,
        workflow_id,
        artifact_key,
        response_cache_key,
        error_message,
        created_at,
        updated_at
      ) VALUES (1, ?, ?, 'queued', NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        bundle_key = excluded.bundle_key,
        normalized_request = excluded.normalized_request,
        updated_at = excluded.updated_at
    `, bundleKey, normalizedRequest, now, now);

    return (await this.getStatus(bundleKey)) as CoordinatorRecord;
  }

  async markRunning(bundleKey: string): Promise<CoordinatorRecord> {
    this.ctx.storage.sql.exec(`
      UPDATE build_state
      SET status = 'running', error_message = NULL, updated_at = ?
      WHERE id = 1 AND bundle_key = ?
    `, Date.now(), bundleKey);

    return (await this.getStatus(bundleKey)) as CoordinatorRecord;
  }

  async markComplete(bundleKey: string, artifactKey: string, responseCacheKey: string | null = null): Promise<CoordinatorRecord> {
    this.ctx.storage.sql.exec(`
      UPDATE build_state
      SET status = 'complete', artifact_key = ?, response_cache_key = ?, error_message = NULL, updated_at = ?
      WHERE id = 1 AND bundle_key = ?
    `, artifactKey, responseCacheKey, Date.now(), bundleKey);

    return (await this.getStatus(bundleKey)) as CoordinatorRecord;
  }

  async markFailed(bundleKey: string, errorMessage: string): Promise<CoordinatorRecord> {
    this.ctx.storage.sql.exec(`
      UPDATE build_state
      SET status = 'errored', error_message = ?, updated_at = ?
      WHERE id = 1 AND bundle_key = ?
    `, errorMessage, Date.now(), bundleKey);

    return (await this.getStatus(bundleKey)) as CoordinatorRecord;
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}