export type BundleStatus = "unknown" | "queued" | "running" | "complete" | "errored";

export type CoordinatorRecord = {
  bundleKey: string;
  normalizedRequest: string | null;
  status: BundleStatus;
  workflowId: string | null;
  artifactKey: string | null;
  responseCacheKey: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BundleCoordinatorStub = {
  getStatus(bundleKey: string): Promise<CoordinatorRecord | null>;
  initialize(bundleKey: string, normalizedRequest: string): Promise<CoordinatorRecord>;
  markRunning(bundleKey: string): Promise<CoordinatorRecord>;
  markComplete(bundleKey: string, artifactKey: string, responseCacheKey?: string | null): Promise<CoordinatorRecord>;
  markFailed(bundleKey: string, errorMessage: string): Promise<CoordinatorRecord>;
  clear(): Promise<void>;
};

export type Env = {
  ASSETS: Fetcher;
  BUNDLE_ARTIFACTS: R2Bucket;
  BUNDLE_CACHE: KVNamespace;
  BUNDLE_COORDINATOR: DurableObjectNamespace<BundleCoordinatorStub>;
};