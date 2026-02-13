/**
 * Shared test helpers for bundlejs resolution tests.
 *
 * Provides factory functions and utilities that simplify writing
 * scenario tests. Keeps individual test files focused on the
 * specific scenario under test.
 *
 * @module
 */

import type { BuildConfig } from "../types.ts";
import type { BuildResult, DisposableBuildResult } from "../build.ts";
import type { PackageJson } from "@bundle/utils/types";
import type { ResolverConditionInputs } from "@bundle/utils/resolve-conditions";

import { build, TheFileSystem } from "../build.ts";
import { setFile } from "../utils/filesystem.ts";

// Re-export resolution functions for unit testing
export {
  resolveModern,
  resolveLegacy,
  applyPathRemapping,
  applyManifestRemappings,
  resolvePackageEntry,
  computePeerDependencies,
  computeSideEffects,
  normalizeResolvedPath,
  joinSubpaths,
  REMAPPING_FIELDS,
} from "../utils/cdn-resolution.ts";

export type {
  ResolverConditions,
  PathRemappings,
  RemappingResult,
  ModernResolutionResult,
  LegacyResolutionResult,
  PackageResolutionResult,
  PackageResolutionOptions,
} from "../utils/cdn-resolution.ts";

export {
  getResolverConditions,
  getRuntimeDefaults,
  getLegacyMainFields,
  isRequireContext,
  detectRuntime,
  getPlatformForRuntime,
  KNOWN_CONDITIONS,
  DEFAULT_MAIN_FIELDS,
  mergeConditions,
  conditionMatches,
} from "@bundle/utils/resolve-conditions";

export type {
  ResolveRuntime,
  ResolverConditionInputs,
  RuntimeDefaults,
} from "@bundle/utils/resolve-conditions";

export {
  computeEsbuildSideEffects,
  compileSideEffectsMatchers,
  normalizeSideEffectsPattern,
  normalizePkgRelPath,
  isJsLikePath,
} from "../utils/side-effects.ts";

// =============================================================================
// Test helpers
// =============================================================================

/**
 * Build a package with given config and return the result.
 *
 * Writes a simple entry file to the VFS and runs the full build pipeline:
 *   setFile → build → result
 *
 * **Important:** Each call gets a fresh filesystem to avoid cross-test state leakage.
 *
 * @param entryCode  Source code for the entry file
 * @param config     Build config overrides (merged with sensible defaults)
 * @returns          The full build result
 */
export async function buildWithEntry(
  entryCode: string,
  config: BuildConfig = {},
): Promise<DisposableBuildResult> {
  const fs = await TheFileSystem;
  await setFile(fs, "/index.tsx", entryCode);

  const merged: BuildConfig = {
    entryPoints: ["/index.tsx"],
    esbuild: {
      treeShaking: true,
      format: "esm",
      minify: true,
      ...config.esbuild,
    },
    ...config,
    // esbuild is deep-merged above, so prevent shallow override
    ...(config.esbuild ? {} : {}),
  };

  // Ensure nested esbuild config is merged
  if (config.esbuild) {
    merged.esbuild = {
      treeShaking: true,
      format: "esm",
      minify: true,
      ...config.esbuild,
    };
  }

  return await build(merged);
}

/**
 * Shorthand: build a bare import and return the result.
 *
 * Generates `export * from "<specifier>";` as the entry code.
 */
export function buildPackage(
  specifier: string,
  config: BuildConfig = {},
): Promise<DisposableBuildResult> {
  return buildWithEntry(`export * from "${specifier}";`, config);
}

/**
 * Check if the build output text contains a given string.
 */
export function outputContains(result: BuildResult, needle: string): boolean {
  return result.contents.some((f) => f.text.includes(needle));
}

/**
 * Check if the build output text matches a regex.
 */
export function outputMatches(result: BuildResult, pattern: RegExp): boolean {
  return result.contents.some((f) => pattern.test(f.text));
}

/**
 * Get all build output as a single string (concatenated).
 */
export function getOutputText(result: BuildResult): string {
  return result.contents.map((f) => f.text).join("\n");
}

/**
 * Create a minimal manifest (package.json) object for testing.
 */
export function manifest(
  fields: Partial<PackageJson> & { name?: string; version?: string },
): Partial<PackageJson> {
  return {
    name: fields.name ?? "test-pkg",
    version: fields.version ?? "1.0.0",
    ...fields,
  };
}

/**
 * Make import-statement args for getResolverConditions.
 */
export function importArgs(kind: "import-statement" | "require-call" | "entry-point" = "import-statement") {
  return { kind };
}

/**
 * Build resolver condition inputs from a compact object.
 */
export function resolveOpts(opts: ResolverConditionInputs = {}): ResolverConditionInputs {
  return {
    platform: "browser",
    format: "esm",
    ...opts,
  };
}

/** Timeout for integration tests that hit the network */
export const NETWORK_TIMEOUT = 120_000;

/** Timeout for unit tests (no network) */
export const UNIT_TIMEOUT = 5_000;
