import { isAbsolute } from "@std/path/posix";

export * from "@std/path/posix";
export * as posix from "@std/path/posix";
export * as windows from "@std/path/windows";

/**
 * An import counts as a bare import if it's neither:
 * - A relative import (./foo, ../bar)
 * - An absolute import (/foo, C:\foo)
 * - A data: URL
 * - A private/subpath import (#internal)
 *
 * Private imports (#...) are Node.js subpath imports that must be resolved
 * against the importer's package.json "imports" field, not treated as npm packages.
 * @see https://nodejs.org/api/packages.html#subpath-imports
 */
export const isBareImport = (importStr: string) => {
  // Private imports are NOT bare imports - they have special resolution rules
  if (/^#/.test(importStr)) return false;
  
  return /^(?!\.).*/.test(importStr) && !importStr.startsWith("data:") && !isAbsolute(importStr);
};
