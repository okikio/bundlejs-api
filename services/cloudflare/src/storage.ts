import type { BundleResult } from "../../edge/bundle.ts";
import { headers } from "../../edge/constants.ts";
import type { Env } from "./types.ts";

const BUNDLE_CACHE_TTL_SECONDS = 60 * 60 * 24;
const BADGE_CACHE_TTL_SECONDS = 60 * 60 * 24;

export type StoredBadge = {
  body: string;
  contentType: string;
  encoding: "text" | "base64";
};

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

export function getBadgeCacheKey(badgeID: string): string {
  return `badge/${badgeID}`;
}

export async function getCachedBundleResult(env: Env, key: string): Promise<BundleResult | null> {
  return await env.BUNDLE_CACHE.get<BundleResult>(key, "json");
}

export async function putCachedBundleResult(env: Env, key: string, value: BundleResult): Promise<void> {
  await env.BUNDLE_CACHE.put(key, JSON.stringify(value), {
    expirationTtl: BUNDLE_CACHE_TTL_SECONDS
  });
}

export async function deleteCachedBundleResult(env: Env, key: string): Promise<void> {
  await env.BUNDLE_CACHE.delete(key);
}

export async function deleteCachedBadge(env: Env, badgeID: string): Promise<void> {
	await env.BUNDLE_CACHE.delete(getBadgeCacheKey(badgeID));
}

export async function getCachedBadge(env: Env, badgeID: string): Promise<StoredBadge | null> {
  return await env.BUNDLE_CACHE.get<StoredBadge>(getBadgeCacheKey(badgeID), "json");
}

export async function putCachedBadge(env: Env, badgeID: string, badge: StoredBadge): Promise<void> {
  await env.BUNDLE_CACHE.put(getBadgeCacheKey(badgeID), JSON.stringify(badge), {
    expirationTtl: BADGE_CACHE_TTL_SECONDS
  });
}

export async function putBundleArtifact(env: Env, artifactKey: string, content: string): Promise<void> {
  await env.BUNDLE_ARTIFACTS.put(artifactKey, content, {
    httpMetadata: {
      contentType: "text/javascript; charset=utf-8"
    }
  });
}

export async function getBundleArtifactText(env: Env, artifactKey: string): Promise<string | null> {
  const object = await env.BUNDLE_ARTIFACTS.get(artifactKey);

  if (!object || !("text" in object) || typeof object.text !== "function") {
    return null;
  }

  return await object.text();
}

export async function deleteBundleArtifact(env: Env, artifactKey: string): Promise<void> {
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