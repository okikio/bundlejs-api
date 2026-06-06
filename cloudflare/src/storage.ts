import type { BundleResult } from "../../edge/bundle.ts";
import { headers } from "../../edge/constants.ts";
import type { Env } from "./types.ts";

type ArtifactEnv = Env & {
  BUNDLE_ARTIFACTS: R2Bucket;
};

const BUNDLE_CACHE_TTL_SECONDS = 60 * 60 * 24;
const KV_KEY_BYTE_LIMIT = 512;

const kvKeyEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return kvKeyEncoder.encode(value).byteLength;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]!);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", kvKeyEncoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

function keyDebugPrefix(key: string): string {
  // Keeps keys somewhat inspectable when listed, without risking non-ascii bytes.
  return key.slice(0, 32).replace(/[^A-Za-z0-9_-]/g, "_");
}

async function toKvSafeKey(key: string): Promise<string> {
  if (utf8ByteLength(key) <= KV_KEY_BYTE_LIMIT) return key;
  const hash = await sha256Base64Url(key);
  return `h:${hash}:${keyDebugPrefix(key)}`;
}

export type StoredBadge = {
  body: string;
  contentType: string;
  encoding: "text" | "base64";
};

type BadgeHash = Record<string, StoredBadge>;

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return arrayBuffer;
}

export function getArtifactKey(bundleKey: string): string {
  return `bundles/${bundleKey}/index.js`;
}

export async function getCachedBundleResult(env: Env, key: string): Promise<BundleResult | null> {
  return await env.BUNDLE_CACHE.get<BundleResult>(await toKvSafeKey(key), "json");
}

export async function putCachedBundleResult(
  env: Env,
  key: string,
  value: BundleResult,
  options: { permanent?: boolean } = {}
): Promise<void> {
  // Deno Deploy:
  // - stores the primary `jsonKey` entry with a 24h TTL
  // - stores the per-package permanent entry without expiry
  await env.BUNDLE_CACHE.put(
    await toKvSafeKey(key),
    JSON.stringify(value),
    options.permanent
      ? undefined
      : {
          expirationTtl: BUNDLE_CACHE_TTL_SECONDS,
        }
  );
}

export async function deleteCachedBundleResult(env: Env, key: string): Promise<void> {
  await env.BUNDLE_CACHE.delete(await toKvSafeKey(key));
}

export async function deleteCachedBadgeKey(env: Env, badgeKey: string): Promise<void> {
  // Mirrors `redis.del(badgeKey)` in the Deno handler.
  // This wipes all badge variants for the bundle in one operation.
  await env.BUNDLE_CACHE.delete(await toKvSafeKey(badgeKey));
}

async function getBadgeHash(env: Env, badgeKey: string): Promise<BadgeHash | null> {
  return await env.BUNDLE_CACHE.get<BadgeHash>(await toKvSafeKey(badgeKey), "json");
}

export async function getCachedBadge(env: Env, badgeKey: string, badgeID: string): Promise<StoredBadge | null> {
  // Equivalent to `redis.hget(badgeKey, badgeID)`.
  const hash = await getBadgeHash(env, badgeKey);
  if (!hash || typeof hash !== "object") return null;
  return hash[badgeID] ?? null;
}

export async function putCachedBadge(env: Env, badgeKey: string, badgeID: string, badge: StoredBadge): Promise<void> {
  // Equivalent to `redis.hset(badgeKey, { [badgeID]: ... })`.
  // KV doesn't support hash fields natively, so we store a JSON object.
  const hash = (await getBadgeHash(env, badgeKey)) ?? {};
  hash[badgeID] = badge;
  await env.BUNDLE_CACHE.put(await toKvSafeKey(badgeKey), JSON.stringify(hash));
}

export async function putBundleArtifact(env: ArtifactEnv, artifactKey: string, content: string): Promise<void> {
  await env.BUNDLE_ARTIFACTS.put(artifactKey, content, {
    httpMetadata: {
      contentType: "text/javascript; charset=utf-8"
    }
  });
}

export async function getBundleArtifactText(env: ArtifactEnv, artifactKey: string): Promise<string | null> {
  const object = await env.BUNDLE_ARTIFACTS.get(artifactKey);

  if (!object || !("text" in object) || typeof object.text !== "function") {
    return null;
  }

  return await object.text();
}

export async function deleteBundleArtifact(env: ArtifactEnv, artifactKey: string): Promise<void> {
  await env.BUNDLE_ARTIFACTS.delete(artifactKey);
}

export function createCachedBadgeResponse(badge: StoredBadge): Response {
  const responseBody = badge.encoding === "base64"
    ? toArrayBuffer(decodeBase64(badge.body))
    : badge.body;

  return new Response(responseBody, {
    status: 200,
    headers: [
      ...headers,
      ["Cache-Control", "max-age=36, public"],
      ["Content-Type", badge.contentType]
    ]
  });
}