import { executePreparedBundle } from "../../edge/execute.ts";
import type { BundleResult } from "../../edge/bundle.ts";
import { getPackageResultKey, prepareBundleRequest } from "../../edge/request.ts";
import { generateWorkerResult } from "./result.ts";
import type { Env } from "./types.ts";
import {
  createCachedBadgeResponse,
  deleteCachedBadge,
  deleteBundleArtifact,
  deleteCachedBundleResult,
  getArtifactKey,
  getCachedBadge,
  getCachedBundleResult,
  putBundleArtifact,
  putCachedBundleResult
} from "./storage.ts";

export { BundleCoordinator } from "./durable-objects/bundle-coordinator.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
} as const;

function isStaticRoute(pathname: string): boolean {
  return pathname.startsWith("/.well-known/") || ["/favicon.ico", "/robots.txt", "/llms.txt", "/sw.js"].includes(pathname);
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...(init.headers ?? {})
    }
  });
}

function isBundleRoute(pathname: string): boolean {
  return [
    "/",
    "/analysis",
    "/analyze",
    "/badge",
    "/badge/raster",
    "/badge-raster",
    "/bundle",
    "/delete-cache",
    "/file",
    "/metafile",
    "/no-cache",
    "/raw",
    "/warnings"
  ].includes(pathname);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    const url = new URL(request.url);

    if (isStaticRoute(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    if (url.searchParams.has("docs")) {
      return Response.redirect("https://blog.okikio.dev/documenting-an-online-bundler-bundlejs#heading-configuration");
    }

    if (url.pathname === "/healthz") {
      return json({
        ok: true,
        runtime: "cloudflare-workers",
        mode: "bundle-execution"
      });
    }

    if (url.pathname.startsWith("/jobs/")) {
      const bundleKey = url.pathname.slice("/jobs/".length).trim();

      if (!bundleKey) {
        return json({ message: "Missing bundle key." }, { status: 400 });
      }

      const stub = env.BUNDLE_COORDINATOR.get(env.BUNDLE_COORDINATOR.idFromName(bundleKey));
      const status = await stub.getStatus(bundleKey);

      if (!status) {
        return json({ bundleKey, status: "unknown" }, { status: 404 });
      }

      return json(status);
    }

    if (isBundleRoute(url.pathname)) {
      const preparedRequest = await prepareBundleRequest(url);
      const {
        badgeID,
        badgeKey,
        bundleKey,
        exportAll,
        initialValue,
        jsonKey,
        modules,
        mutationQueries,
        query,
        shareQuery,
        textQuery,
        versions
      } = preparedRequest;
      const artifactKey = getArtifactKey(bundleKey);
      const stub = env.BUNDLE_COORDINATOR.get(env.BUNDLE_COORDINATOR.idFromName(bundleKey));
      const existingStatus = await stub.getStatus(bundleKey);
      const fileQuery = url.searchParams.has("file") || url.pathname === "/file";
      const badgeQuery = url.searchParams.has("badge") || ["/badge", "/badge/raster", "/badge-raster"].includes(url.pathname);
      const packageCacheKey = modules.length === 1 && exportAll && !mutationQueries && modules[0]?.[1] === "export"
        ? `${getPackageResultKey(modules[0][0])}/${jsonKey}`
        : null;
      const startedAt = Date.now();

      if (url.pathname === "/delete-cache") {
        await deleteCachedBundleResult(env, jsonKey);

        if (packageCacheKey) {
          await deleteCachedBundleResult(env, packageCacheKey);
        }

        await deleteCachedBadge(env, badgeID);
        await deleteBundleArtifact(env, artifactKey);

        await stub.clear();

        return json({
          message: "Deleted bundle cache entries.",
          bundleKey,
          jsonKey,
          packageCacheKey,
          artifactKey
        });
      }

      let cachedResult = null as BundleResult | null;

      if (url.pathname !== "/no-cache") {
        cachedResult = await getCachedBundleResult(env, jsonKey);

        if (!cachedResult && packageCacheKey) {
          cachedResult = await getCachedBundleResult(env, packageCacheKey);
        }

        if (badgeQuery && cachedResult) {
          const cachedBadge = await getCachedBadge(env, badgeID);

          if (cachedBadge) {
            return createCachedBadgeResponse(cachedBadge);
          }
        }

        if (cachedResult) {
          return await generateWorkerResult(
            env,
            [badgeKey, badgeID],
            [cachedResult, undefined],
            url,
            true,
            Date.now() - startedAt,
            artifactKey
          );
        }
      }

      if (existingStatus?.status === "running") {
        return json({
          message: "A bundle build is already running for this bundle key.",
          bundleKey,
          query,
          initialValue,
          jsonKey,
          modules,
          versions,
          coordinatorStatus: existingStatus
        }, { status: 202 });
      }

      if (!existingStatus) {
        await stub.initialize(bundleKey, jsonKey);
      }

      await stub.markRunning(bundleKey);

      try {
        const [response, resultText] = await executePreparedBundle(url, preparedRequest);

        if (!response.ok) {
          const errorMessage = await response.clone().text();
          await stub.markFailed(bundleKey, errorMessage || `Bundle request failed with status ${response.status}.`);
          return response;
        }

        const value = await response.clone().json() as BundleResult;

        await putBundleArtifact(env, artifactKey, resultText);
        await putCachedBundleResult(env, jsonKey, value);
        await deleteCachedBadge(env, badgeID);

        if (packageCacheKey) {
          await putCachedBundleResult(env, packageCacheKey, value);
        }

        await stub.markComplete(bundleKey, artifactKey, jsonKey);

        return await generateWorkerResult(
          env,
          [badgeKey, badgeID],
          [value, resultText],
          url,
          false,
          Date.now() - startedAt,
          artifactKey
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await stub.markFailed(bundleKey, message);

        return json({
          bundleKey,
          error: message
        }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;