import { executePreparedBundle } from "../../edge/execute.ts";
import type { BundleResult } from "../../edge/bundle.ts";
import { prepareBundleRequest } from "../../edge/request.ts";
import { getPackageResultKey, headers } from "../../edge/constants.ts";
import { generateHTMLMessages, generateWorkerResult } from "./result.ts";
import type { Env } from "./types.ts";
import ESBUILD_WASM_MODULE from "../../core/esbuild.wasm";
import {
  createCachedBadgeResponse,
  deleteCachedBadgeKey,
  deleteBundleArtifact,
  deleteCachedBundleResult,
  getArtifactKey,
  getCachedBadge,
  getCachedBundleResult,
  putBundleArtifact,
  putCachedBundleResult
} from "./storage.ts";

export { BundleCoordinator } from "./durable-objects/bundle-coordinator.ts";

/**
 * Cloudflare Workers entrypoint that aims to mirror `edge/mod.ts` (Deno Deploy)
 * as closely as practical.
 *
 * Design goals:
 * - Preserve the observable behavior of the Deno handler (routes, status codes,
 *   cache semantics, headers), but implement persistence using Workers bindings
 *   (KV for JSON/badge cache; optional R2 for bundle artifacts).
 * - Keep runtime-specific logic *thin* here; shared request parsing + execution
 *   live in `edge/request.ts` and `edge/execute.ts`.
 */

function hasArtifactStorage(env: Env): env is Env & { BUNDLE_ARTIFACTS: R2Bucket } {
  return Boolean(env.BUNDLE_ARTIFACTS);
}

async function deleteAllKv(env: Env): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined = undefined;

  do {
    const page = await env.BUNDLE_CACHE.list({ cursor });
    const keys = page.keys.map((entry) => entry.name);

    await Promise.all(keys.map((name) => env.BUNDLE_CACHE.delete(name)));
    deleted += keys.length;

    cursor = page.cursor;
  } while (cursor);

  return deleted;
}

async function deleteAllArtifacts(env: Env): Promise<number> {
  if (!hasArtifactStorage(env)) {
    return 0;
  }

  let deleted = 0;
  let cursor: string | undefined = undefined;

  do {
    const page = await env.BUNDLE_ARTIFACTS.list({ cursor });
    const keys = page.objects.map((obj) => obj.key);

    await Promise.all(keys.map((key) => env.BUNDLE_ARTIFACTS.delete(key)));
    deleted += keys.length;

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return deleted;
}

function contentTypeForWellKnown(ext: string): string {
  if (ext === ".png") return "image/png";
  if (ext === ".yaml") return "text/yaml";
  return "application/json";
}

function isErrorWithMessages(error: unknown): error is { msgs: string[] } {
  return typeof error === "object" && error !== null && Array.isArray((error as { msgs?: unknown }).msgs);
}

function serializeErrorPayload(error: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(error, (_key, value) => {
    if (value instanceof Error) {
      return {
        error: value.message,
        name: value.name,
        stack: value.stack,
        cause: value.cause,
      };
    }

    if (typeof value === "bigint") {
      return value.toString();
    }

    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) {
        return "[Circular]";
      }

      seen.add(value);
    }

    return value;
  }) ?? JSON.stringify({ error: String(error) });
}

function createDebugErrorResponse(error: unknown): Response {
  if (isErrorWithMessages(error) && error.msgs.length > 0) {
    try {
      return new Response(generateHTMLMessages(error.msgs), {
        status: 404,
        headers: [
          ...headers,
          ["Cache-Control", "no-store"],
          ["Content-Type", "text/html"],
        ],
      });
    } catch (msgsError) {
      console.warn("error-rendering-debug-messages:", msgsError);
    }
  }

  const errorStatus = typeof error === "object" && error !== null
    ? (error as { status?: unknown }).status
    : undefined;
  const status = typeof errorStatus === "number" ? errorStatus : 500;

  const payload = typeof error === "object" && error !== null
    ? serializeErrorPayload(error)
    : JSON.stringify({ error: String(error) });

  return new Response(payload, {
    status,
    headers: [
      ...headers,
      ["Cache-Control", "no-store"],
      ["Content-Type", "application/json"],
    ],
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/favicon.ico") {
        return Response.redirect("https://bundlejs.com/favicon/favicon-api.ico");
      }

      if (url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png") {
        return Response.redirect("https://bundlejs.com/favicon/apple-touch-icon.png");
      }

      if (url.pathname === "/sw.js" || url.pathname === "/robots.txt" || url.pathname === "/llms.txt") {
        return Response.json({ message: "no" });
      }

      if (url.pathname.startsWith("/.well-known/")) {
        const assetResponse = await env.ASSETS.fetch(request);
        const ext = url.pathname.includes(".") ? `.${url.pathname.split(".").pop()}` : "";

        return new Response(await assetResponse.arrayBuffer(), {
          status: assetResponse.status,
          headers: [
            ...headers,
            ["Cache-Control", "max-age=180, public"],
            ["Content-Type", contentTypeForWellKnown(ext)],
          ],
        });
      }

      if (url.searchParams.has("docs")) {
        return Response.redirect("https://blog.okikio.dev/documenting-an-online-bundler-bundlejs#heading-configuration");
      }

      const badgeQuery = url.searchParams.has("badge") || ["/badge", "/badge/raster", "/badge-raster"].includes(url.pathname);
      const fileCheck = url.searchParams.has("file") || url.pathname === "/file";

      const preparedRequest = await prepareBundleRequest(url);
      const {
        badgeID,
        badgeKey,
        bundleKey,
        exportAll,
        jsonKey,
        modules,
        mutationQueries,
        shareQuery,
        textQuery,
      } = preparedRequest;

      const artifactKey = getArtifactKey(bundleKey);
      const startedAt = Date.now();

      if (url.pathname === "/clear-all-cache-123") {
        const clearArtifacts = url.searchParams.has("gist") || url.searchParams.has("gists");

        if (clearArtifacts) {
          await deleteAllKv(env);
          await deleteAllArtifacts(env);
          return new Response("Started clearing cache including gists!\n\nCleared entire cache + gists...careful now.", {
            headers: {
              "Content-Type": "text/plain",
              "x-content-type-options": "nosniff",
            },
          });
        }

        await deleteAllKv(env);
        return new Response("Started clearing cache!\nCleared entire cache", {
          headers: {
            "Content-Type": "text/plain",
            "x-content-type-options": "nosniff",
          },
        });
      }

      if (url.pathname === "/delete-cache") {
        try {
          const packageCacheKey = modules.length === 1 && exportAll && !mutationQueries && modules[0]?.[1] === "export"
            ? `${getPackageResultKey(modules[0][0])}/${jsonKey}`
            : null;

          await deleteCachedBundleResult(env, jsonKey);
          if (packageCacheKey) await deleteCachedBundleResult(env, packageCacheKey);
          await deleteCachedBadgeKey(env, badgeKey);
          if (hasArtifactStorage(env)) {
            await deleteBundleArtifact(env, artifactKey);
          }

          return new Response("Deleted from cache!");
        } catch (error) {
          console.warn(error);
          return new Response("Error, deleting from cache");
        }
      }

      try {
        if (url.pathname !== "/no-cache") {
          const packageCacheKey = modules.length === 1 && exportAll && !mutationQueries && modules[0]?.[1] === "export"
            ? `${getPackageResultKey(modules[0][0])}/${jsonKey}`
            : null;

          let cachedResult: BundleResult | null = await getCachedBundleResult(env, jsonKey);

          if (!cachedResult && packageCacheKey) {
            cachedResult = await getCachedBundleResult(env, packageCacheKey);
          }

          if (badgeQuery && cachedResult) {
            const cachedBadge = await getCachedBadge(env, badgeKey, badgeID);
            if (cachedBadge) {
              return createCachedBadgeResponse(cachedBadge);
            }
          } else if (badgeQuery && !cachedResult) {
            await deleteCachedBadgeKey(env, badgeKey);
          }

          const fileAvailable = !fileCheck
            ? true
            : hasArtifactStorage(env)
              ? Boolean(await env.BUNDLE_ARTIFACTS.head(artifactKey))
              : false;

          if (cachedResult && fileAvailable) {
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
      } catch (error) {
        console.warn("error-using-cache:", error);
      }

      const [response, resultText] = await executePreparedBundle(url, preparedRequest, { wasmModule: ESBUILD_WASM_MODULE });

      if (!response.ok) {
        const responseHeaders = response.headers;
        const status = response.status;
        return new Response(await response.arrayBuffer(), {
          headers: responseHeaders,
          status,
        });
      }

      const value: BundleResult = await response.json();

      try {
        if (hasArtifactStorage(env)) {
          await putBundleArtifact(env, artifactKey, resultText);
        }
        await putCachedBundleResult(env, jsonKey, value);

        if (modules.length === 1 && exportAll && !(shareQuery || textQuery) && modules[0]?.[1] === "export") {
          const packageCacheKey = `${getPackageResultKey(modules[0][0])}/${jsonKey}`;
          await putCachedBundleResult(env, packageCacheKey, value, { permanent: true });
        }

        await deleteCachedBadgeKey(env, badgeKey);
      } catch (error) {
        console.warn(error);
      }

      return await generateWorkerResult(
        env,
        [badgeKey, badgeID],
        [value, resultText],
        url,
        false,
        Date.now() - startedAt,
        hasArtifactStorage(env) ? artifactKey : null
      );
    } catch (error) {
      console.error("worker-request-error:", error);
      return createDebugErrorResponse(error);
    }
  }
} satisfies ExportedHandler<Env>;