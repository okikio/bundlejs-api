/// <reference types="npm:@types/node" />

/**
 * Runtime detection utilities
 * Determines whether code is running in Deno or Node.js
 */

export const isDeno = 'Deno' in globalThis;
export const isNode = !isDeno

/**
 * Cross-runtime environment variable access
 * Abstracts the difference between Deno.env.get() and process.env
 */
export function getEnv(key: string, value?: string): string | undefined {
  if (isDeno) {
    return globalThis?.Deno?.env.get(key) ?? value
  }
  return globalThis?.process?.env[key] ?? value
}

/**
 * Gets environment variable or throws if missing
 * Useful for required configuration
 */
export function requireEnv(key: string): string {
  const value = getEnv(key)
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return value
}