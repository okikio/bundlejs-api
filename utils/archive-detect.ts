// utils/archive-detect.ts
//
// Archive detection utilities for resolver pipelines.
//
// This module is meant for “resolver-grade” detection, not general-purpose archiving.
//
// Resolver-grade means:
//
// - It must be cheap to run on every candidate response.
// - It must not buffer entire bodies just to decide how to route.
// - It must be debuggable years later (diagnostics must explain the reasoning).
// - It must be spec-driven where specs exist, then pragmatic where the network is messy.
//
// The primary mental model:
//
// - A *container* is the thing that holds files (tar, zip).
// - A *compression wrapper* is what shrinks the container for transport (gzip, zstd, xz...).
//
// In the common case:
//
//   ".tgz"   -> tar container + gzip wrapper
//   ".tar"   -> tar container + no wrapper
//   ".zip"   -> zip container + no wrapper
//
// The hard part is that servers often lie or omit headers:
// - Content-Type might be "application/octet-stream"
// - Content-Encoding might be missing
// - redirects might serve HTML
//
// So the decision process is layered:
//
// 1) Filename/URL hint: cheap, medium-signal, can be wrong.
// 2) Header hint: spec-defined but still not authoritative.
// 3) Byte sniff: authoritative for compression wrappers and certain containers.
// 4) Container confirmation: for tar we confirm via "ustar" signature.
//
// If in doubt, we do not “force tar”; we surface uncertainty with confidence + diagnostics.

import { basename } from "./path.ts";

import {
  extractFilenameFromContentDisposition,
  getPrimaryContentCoding,
  parseContentEncodingStrict,
  parseContentTypeStrict,
  type ContentCodingList,
  type MediaType,
  type ParseIssue,
} from "./archive-spec.ts";


/* -------------------------------------------------------------------------------------------------
 * Public types
 * ------------------------------------------------------------------------------------------------- */

/**
 * Compression wrapper applied to a payload.
 *
 * Even if you do not currently support decompressing all of these in your runtime,
 * detection should still identify them so the resolver can:
 * - emit precise diagnostics (“zstd tarballs detected but not supported”),
 * - or route into an optional native decompressor layer later.
 */
export type ArchiveCompression =
  | "none"
  | "gzip"
  | "bzip2"
  | "xz"
  | "zstd"
  | "brotli"
  | "lz4"
  | "lzma"
  | "lzip"
  | "compress" // classic Unix ".Z"
  | "deflate"
  | "deflate-raw"
  | "unknown";

/**
 * Container format once decompressed (if decompression applies).
 */
export type ArchiveContainer =
  | "tar"
  | "zip"
  | "unknown";

/**
 * “Where did this clue come from?” is essential for debugging and future refactors.
 * In resolution pipelines, these become breadcrumbs in logs.
 */
export type ArchiveSignal =
  | "url"
  | "content-type"
  | "content-encoding"
  | "content-disposition"
  | "magic-bytes"
  | "tar-ustar";

/**
 * One specific reason we believe something.
 * These are stored in the detection result and are also printed in diagnostics.
 */
export type ArchiveReason = {
  signal: ArchiveSignal;
  detail: string;
};

/**
 * Final merged detection result.
 *
 * `confidence` is intentionally conservative:
 * - high: bytes confirm tar container (ustar).
 * - medium: bytes confirm wrapper/container, or strong label hints.
 * - low: only weak hints; caller should be ready for “this is actually HTML/JS”.
 */
export type ArchiveDetection = {
  container: ArchiveContainer;
  compression: ArchiveCompression;
  isTarballLike: boolean;
  confidence: "high" | "medium" | "low";
  reasons: Iterable<ArchiveReason>;

  // Helpful context for debugging. These are not “truth”; they’re the inputs.
  filenameHint?: string;
  urlHint?: string;
  contentType?: string | null;
  contentEncoding?: string | null;
};

/**
 * A human-readable diagnostic for logs.
 * The idea is: if someone pastes this into an issue, you can triage without reproducing locally.
 */
export type ArchiveDiagnostic = {
  summary: string;
  details: string;
};

/* -------------------------------------------------------------------------------------------------
 * Public constants
 * ------------------------------------------------------------------------------------------------- */

/**
 * Multi-extensions for tarballs, sorted by descending specificity.
 *
 * Spec note:
 * - Extensions are not standardized by HTTP specs. They are a publisher convention.
 * - Still, they are useful hints in a resolver because they often reflect intent.
 *
 * Real-life note:
 * - We include extensions beyond what we can decompress today because detection
 *   should be stable even if decompression support changes later.
 */
export const TAR_MULTI_EXTENSIONS: readonly string[] = [
  ".tar.zstd",
  ".tar.zst",
  ".tar.gz",
  ".tar.bz2",
  ".tar.xz",
  ".tar.br",
  ".tar.lz4",
  ".tar.lzip",
  ".tar.lzma",
  ".tar.lz",
  ".tar.z",
  ".tar.Z",
] as const;

/**
 * Short tarball extensions that imply tar container + a wrapper.
 */
export const TAR_SHORT_EXTENSIONS: readonly string[] = [
  ".tgz",
  ".tbz2",
  ".tbz",
  ".txz",
  ".tzst",
  ".tbr",
  ".tlz4",
] as const;

/**
 * Content-Types that commonly show up for tarballs.
 *
 * Spec note:
 * - Content-Type is defined by RFC 9110 + media type registrations.
 * - Content-Type is about the representation *as sent*, not necessarily “what it semantically is”.
 *
 * Real-life note:
 * - Many CDNs use application/octet-stream for everything.
 * - Therefore: never hard-gate on this list.
 */
export const TAR_CONTENT_TYPES: readonly string[] = [
  "application/tar",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/zstd",
  "application/xz",
  "application/octet-stream",
  "application/tar+gzip",
] as const;

/* -------------------------------------------------------------------------------------------------
 * Spec-first header parsing helpers
 * ------------------------------------------------------------------------------------------------- */

/**
 * Parse Content-Disposition (RFC 6266) for a filename.
 *
 * Spec-first behavior:
 * - Prefer filename* (RFC 8187 / RFC 5987 encoding) when present.
 * - Fall back to filename.
 *
 * Real-life behavior:
 * - We accept common variants even if not perfectly formatted.
 * - We do not attempt full parameter parsing beyond the filename fields,
 *   because we only need a filename hint for extension-based detection.
 *
 * @example
 * parseContentDispositionFilename('attachment; filename="pkg.tgz"') -> "pkg.tgz"
 *
 * @example
 * parseContentDispositionFilename("attachment; filename*=UTF-8''pkg.tar.zst") -> "pkg.tar.zst"
 */
export function parseContentDispositionFilename(
  headerValue: string | null,
): string | null {
  if (!headerValue) return null;

  // Spec note: parameters are generally semicolon-separated.
  // We implement a “good enough” parser for filename / filename* only.
  const parts = headerValue.split(";").map((p) => p.trim());

  // First pass: filename* (encoded). Spec says it should take precedence.
  for (const part of parts) {
    const [kRaw, vRaw] = part.split("=", 2);
    const k = kRaw?.trim().toLowerCase();
    const v = vRaw?.trim();
    if (!k || !v) continue;

    if (k === "filename*") {
      // Spec note: charset'lang'%xx...
      // Example: UTF-8''pkg.tar.zst
      const match = v.match(/^[^']*'[^']*'(.*)$/);
      if (match?.[1]) {
        try {
          return decodeURIComponent(match[1]);
        } catch {
          // If decoding fails, fall back to raw.
          return match[1];
        }
      }
    }
  }

  // Second pass: filename (quoted-string often)
  for (const part of parts) {
    const [kRaw, vRaw] = part.split("=", 2);
    const k = kRaw?.trim().toLowerCase();
    const v = vRaw?.trim();
    if (!k || !v) continue;

    if (k === "filename") {
      // Strip simple quotes. This does not handle all quoted-string escapes, but works in practice.
      return v.replace(/^"(.*)"$/, "$1");
    }
  }

  return null;
}

/**
 * Normalize Content-Type to its media type (type/subtype), dropping parameters.
 *
 * Spec basis:
 * - RFC 9110: Content-Type field.
 * - Media type grammar: "type/subtype" followed by optional parameters.
 *
 * Why this exists:
 * - Many servers append "; charset=utf-8" or boundary parameters.
 * - For routing decisions, we usually only care about the base type/subtype.
 *
 * @example
 * normalizeContentType("application/x-tar; charset=utf-8") -> "application/x-tar"
 */
export function normalizeContentType(contentType: string | null): string | null {
  if (!contentType) return null;

  // Spec note: parameter delimiter is ";".
  // We lower-case because media types are case-insensitive by spec.
  const lower = contentType.trim().toLowerCase();
  const semi = lower.indexOf(";");
  return semi === -1 ? lower : lower.slice(0, semi).trim();
}

/**
 * Normalize Content-Encoding to a primary compression wrapper.
 *
 * Spec basis:
 * - RFC 9110: Content-Encoding is an ordered list of codings applied to the representation.
 *
 * Why this exists:
 * - Servers sometimes send "gzip, br".
 * - For archive detection we mainly care about the outermost encoding first.
 *
 * Important nuance:
 * - Content-Encoding is *not* the same as “file extension compression”.
 * - A tar.gz might come with Content-Encoding: gzip, or it might be sent as-is with
 *   Content-Type: application/gzip and no Content-Encoding. Both happen.
 *
 * @example
 * normalizeContentEncoding("gzip, br") -> "gzip"
 * @example
 * normalizeContentEncoding(null) -> "none"
 */
export function normalizeContentEncoding(
  contentEncoding: string | null,
): ArchiveCompression {
  if (!contentEncoding) return "none";

  const first = contentEncoding
    .split(",")[0]
    ?.trim()
    .toLowerCase();

  switch (first) {
    case "gzip":
      return "gzip";
    case "br":
      return "brotli";
    case "deflate":
      return "deflate";
    case "deflate-raw":
      return "deflate-raw";
    default:
      return "unknown";
  }
}

/* -------------------------------------------------------------------------------------------------
 * Path / URL hint detection
 * ------------------------------------------------------------------------------------------------- */

/**
 * Detect archive hints from a URL or filename.
 *
 * This is a hinting stage. It is intentionally not authoritative.
 *
 * Why it still matters:
 * - When bytes are unavailable (no body, network error), hints are all you have.
 * - In resolver pipelines, early hints decide whether to even attempt an archive code path.
 *
 * The hardest nuance here is multi-extension parsing:
 * - `.tar.zst` should be treated as tar container + zstd wrapper, not “just zst”.
 *
 * @example
 * detectArchiveFromPathHint("pkg.tar.zst")
 * // -> container: "tar"
 * // -> compression: "zstd"
 *
 * @example
 * detectArchiveFromPathHint("pkg.gz")
 * // -> compression: "gzip"
 * // -> container: "unknown" (because `.gz` alone does not imply tar)
 */
export function detectArchiveFromPathHint(
  input: string | URL,
): Pick<
  ArchiveDetection,
  | "container"
  | "compression"
  | "reasons"
  | "filenameHint"
  | "urlHint"
  | "isTarballLike"
  | "confidence"
> {
  const urlHint = typeof input === "string" ? input : input.toString();

  const filenameHint = (() => {
    try {
      if (typeof input === "string") return basename(input);
      return basename(input.pathname);
    } catch {
      return basename(urlHint);
    }
  })();

  const lower = filenameHint.toLowerCase();
  const reasons: ArchiveReason[] = [];

  let container: ArchiveContainer = "unknown";
  let compression: ArchiveCompression = "unknown";
  let confidence: ArchiveDetection["confidence"] = "low";
  let isTarballLike = false;

  for (const ext of TAR_MULTI_EXTENSIONS) {
    if (lower.endsWith(ext.toLowerCase())) {
      container = "tar";
      compression = mapTarMultiExtensionToCompression(ext);
      confidence = "medium";
      isTarballLike = true;

      reasons.push({
        signal: "url",
        detail: `Filename ends with ${ext} (publisher intent hint)`,
      });

      return { container, compression, isTarballLike, confidence, reasons, filenameHint, urlHint };
    }
  }

  for (const ext of TAR_SHORT_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      container = "tar";
      compression = mapTarShortExtensionToCompression(ext);
      confidence = "medium";
      isTarballLike = true;

      reasons.push({
        signal: "url",
        detail: `Filename ends with ${ext} (short tarball hint)`,
      });

      return { container, compression, isTarballLike, confidence, reasons, filenameHint, urlHint };
    }
  }

  if (lower.endsWith(".tar")) {
    container = "tar";
    compression = "none";
    confidence = "medium";
    isTarballLike = true;

    reasons.push({ signal: "url", detail: "Filename ends with .tar" });
  } else if (lower.endsWith(".gz")) {
    compression = "gzip";
    confidence = "low";
    reasons.push({
      signal: "url",
      detail: "Filename ends with .gz (ambiguous: could be a single compressed file or a tarball)",
    });
  } else if (lower.endsWith(".zst") || lower.endsWith(".zstd")) {
    compression = "zstd";
    confidence = "low";
    reasons.push({
      signal: "url",
      detail: "Filename ends with .zst/.zstd (ambiguous without tar hint)",
    });
  }

  return { container, compression, isTarballLike, confidence, reasons, filenameHint, urlHint };
}

/**
 * Map known tar multi-extensions to a compression wrapper.
 *
 * Spec note:
 * - There is no universal standard for these extensions.
 * - We treat this mapping as a “convention dictionary” that we keep stable.
 *
 * Real-life note:
 * - Some extensions (.tar.lz, .tar.z) are ambiguous across ecosystems.
 * - For those, we choose the best-known meaning *and* keep diagnostics rich
 *   so a mismatch is easy to spot.
 */
export function mapTarMultiExtensionToCompression(ext: string): ArchiveCompression {
  const lower = ext.toLowerCase();

  if (lower === ".tar.gz") return "gzip";
  if (lower === ".tar.bz2") return "bzip2";
  if (lower === ".tar.xz") return "xz";
  if (lower === ".tar.zst" || lower === ".tar.zstd") return "zstd";
  if (lower === ".tar.br") return "brotli";
  if (lower === ".tar.lz4") return "lz4";
  if (lower === ".tar.lzma") return "lzma";
  if (lower === ".tar.lzip") return "lzip";

  // Classic Unix compress (.Z) often appears as ".tar.Z". We lower-case comparisons, so ".tar.z".
  if (lower === ".tar.z") return "compress";

  // ".tar.lz" is not consistently defined across ecosystems. Treat as unknown wrapper.
  if (lower === ".tar.lz") return "unknown";

  return "unknown";
}

/**
 * Map known tar short extensions to a compression wrapper.
 */
export function mapTarShortExtensionToCompression(ext: string): ArchiveCompression {
  switch (ext) {
    case ".tgz":
      return "gzip";
    case ".tbz":
    case ".tbz2":
      return "bzip2";
    case ".txz":
      return "xz";
    case ".tzst":
      return "zstd";
    case ".tbr":
      return "brotli";
    case ".tlz4":
      return "lz4";
    default:
      return "unknown";
  }
}

/* -------------------------------------------------------------------------------------------------
 * Header hint detection (spec-first, then pragmatic)
 * ------------------------------------------------------------------------------------------------- */

/**
 * Detect archive hints from headers.
 *
 * A spec-driven mindset here is useful:
 * - Headers are “what the server intends you to believe”.
 * - They are informative, but not authoritative.
 *
 * We keep the detection conservative:
 * - Content-Type can hint at container or wrapper.
 * - Content-Encoding can hint at wrapper.
 * - Content-Disposition can provide a filename hint, which then feeds into path logic.
 */
export function detectArchiveFromHeaders(
  headers: Headers,
): Pick<
  ArchiveDetection,
  | "container"
  | "compression"
  | "reasons"
  | "filenameHint"
  | "contentType"
  | "contentEncoding"
  | "isTarballLike"
  | "confidence"
> {
  const reasons: ArchiveReason[] = [];

  const contentType = normalizeContentType(headers.get("content-type"));
  const contentEncodingRaw = headers.get("content-encoding");
  const contentEncoding = contentEncodingRaw?.trim().toLowerCase() ?? null;

  const cdFilename = parseContentDispositionFilename(headers.get("content-disposition"));

  let compression: ArchiveCompression = normalizeContentEncoding(contentEncoding);
  let container: ArchiveContainer = "unknown";
  let confidence: ArchiveDetection["confidence"] = "low";
  let isTarballLike = false;

  if (contentEncoding) {
    reasons.push({ signal: "content-encoding", detail: `Content-Encoding=${contentEncoding}` });
  }

  if (contentType) {
    reasons.push({ signal: "content-type", detail: `Content-Type=${contentType}` });

    // Weak hint: “this could be a tarball-ish payload”.
    if (TAR_CONTENT_TYPES.includes(contentType)) {
      isTarballLike = true;
      confidence = "low";
    }

    // Stronger hint: container explicitly declared.
    if (contentType === "application/tar" || contentType === "application/x-tar") {
      container = "tar";
      isTarballLike = true;
      confidence = "medium";
    }

    // Wrapper hints from content-type registrations used in practice.
    if (contentType === "application/gzip" || contentType === "application/x-gzip") {
      if (compression === "none" || compression === "unknown") compression = "gzip";
      isTarballLike = true;
      confidence = "low";
    }

    if (contentType === "application/zstd") {
      if (compression === "none" || compression === "unknown") compression = "zstd";
      isTarballLike = true;
      confidence = "low";
    }

    if (contentType === "application/xz") {
      if (compression === "none" || compression === "unknown") compression = "xz";
      isTarballLike = true;
      confidence = "low";
    }
  }

  if (cdFilename) {
    reasons.push({
      signal: "content-disposition",
      detail: `Content-Disposition filename=${cdFilename}`,
    });

    // Spec-first: Content-Disposition filename* is a better filename source than guessing from URL.
    // We reuse the same path-hint logic for consistency.
    const byName = detectArchiveFromPathHint(cdFilename);

    if (byName.container !== "unknown") container = byName.container;
    if (byName.compression !== "unknown") compression = byName.compression;

    if (byName.isTarballLike) {
      isTarballLike = true;
      confidence = upgradeConfidence(confidence, byName.confidence);
    }
  }

  return {
    container,
    compression,
    isTarballLike,
    confidence,
    reasons,
    filenameHint: cdFilename ?? undefined,
    contentType,
    contentEncoding,
  };
}

/**
 * Confidence merging is intentionally simple so it stays stable over time.
 *
 * If this function becomes complex, it’s a sign we should introduce explicit scoring.
 */
export function upgradeConfidence(
  current: ArchiveDetection["confidence"],
  next: ArchiveDetection["confidence"],
): ArchiveDetection["confidence"] {
  if (current === "high" || next === "high") return "high";
  if (current === "medium" || next === "medium") return "medium";
  return "low";
}

/* -------------------------------------------------------------------------------------------------
 * Magic byte sniffing (authoritative where possible)
 * ------------------------------------------------------------------------------------------------- */

/**
 * Magic bytes are small fixed prefixes that identify common formats.
 *
 * Why we use hex in comments and diagnostics:
 * - Magic byte sequences are almost always documented in hexadecimal.
 * - “1F 8B” is gzip; writing that in decimal would be harder to recognize.
 *
 * This function returns:
 * - compression wrapper (gzip/zstd/xz/etc) if identified
 * - optional container hint (zip)
 */
export function sniffCompressionMagic(bytes: Uint8Array): {
  compression: ArchiveCompression;
  containerHint?: ArchiveContainer;
  reason?: ArchiveReason;
} {
  // gzip: 1F 8B
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return {
      compression: "gzip",
      reason: { signal: "magic-bytes", detail: "gzip magic bytes (1F 8B)" },
    };
  }

  // bzip2: "BZh" (42 5A 68)
  if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return {
      compression: "bzip2",
      reason: { signal: "magic-bytes", detail: 'bzip2 magic bytes ("BZh")' },
    };
  }

  // xz: FD 37 7A 58 5A 00
  if (
    bytes.length >= 6 &&
    bytes[0] === 0xfd &&
    bytes[1] === 0x37 &&
    bytes[2] === 0x7a &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x5a &&
    bytes[5] === 0x00
  ) {
    return {
      compression: "xz",
      reason: { signal: "magic-bytes", detail: "xz magic bytes (FD 37 7A 58 5A 00)" },
    };
  }

  // zstd: 28 B5 2F FD
  if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    return {
      compression: "zstd",
      reason: { signal: "magic-bytes", detail: "zstd magic bytes (28 B5 2F FD)" },
    };
  }

  // lz4 frame: 04 22 4D 18
  if (bytes.length >= 4 && bytes[0] === 0x04 && bytes[1] === 0x22 && bytes[2] === 0x4d && bytes[3] === 0x18) {
    return {
      compression: "lz4",
      reason: { signal: "magic-bytes", detail: "lz4 frame magic bytes (04 22 4D 18)" },
    };
  }

  // lzip: "LZIP" (4C 5A 49 50)
  if (bytes.length >= 4 && bytes[0] === 0x4c && bytes[1] === 0x5a && bytes[2] === 0x49 && bytes[3] === 0x50) {
    return {
      compression: "lzip",
      reason: { signal: "magic-bytes", detail: 'lzip magic bytes ("LZIP")' },
    };
  }

  // Unix compress (.Z): 1F 9D or 1F A0
  if (bytes.length >= 2 && bytes[0] === 0x1f && (bytes[1] === 0x9d || bytes[1] === 0xa0)) {
    return {
      compression: "compress",
      reason: { signal: "magic-bytes", detail: "Unix compress magic bytes (1F 9D/1F A0)" },
    };
  }

  // zip container magic: "PK.."
  if (isZipMagic(bytes)) {
    return {
      compression: "none",
      containerHint: "zip",
      reason: { signal: "magic-bytes", detail: "zip magic bytes (PK..)" },
    };
  }

  return { compression: "unknown" };
}

/**
 * zip container detection via magic bytes.
 *
 * This is a container hint, not a compression hint.
 * It helps avoid trying to run tar logic on a zip archive.
 */
export function isZipMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;

  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];

  // PK\x03\x04 (local file header), PK\x05\x06 (empty archive), PK\x07\x08 (spanned archive)
  if (b0 === 0x50 && b1 === 0x4b) {
    if (b2 === 0x03 && b3 === 0x04) return true;
    if (b2 === 0x05 && b3 === 0x06) return true;
    if (b2 === 0x07 && b3 === 0x08) return true;
  }

  return false;
}

/**
 * Tar container confirmation via ustar signature.
 *
 * Tar doesn’t have a “magic number at byte 0”.
 * Instead, the POSIX ustar marker appears at offset 257 inside the first 512-byte header block.
 *
 * This matters because:
 * - you cannot confirm tar by looking at just the first 4 bytes,
 * - for tar.gz you must decompress a prefix before you can even look for ustar.
 */
export function sniffTarUstar(bytes: Uint8Array): {
  isTar: boolean;
  reason?: ArchiveReason;
} {
  if (bytes.length < 262) return { isTar: false };

  const off = 257;
  const isUstar =
    bytes[off + 0] === 0x75 && // u
    bytes[off + 1] === 0x73 && // s
    bytes[off + 2] === 0x74 && // t
    bytes[off + 3] === 0x61 && // a
    bytes[off + 4] === 0x72; // r

  if (!isUstar) return { isTar: false };

  return {
    isTar: true,
    reason: { signal: "tar-ustar", detail: 'tar signature "ustar" at offset 257 (POSIX tar header)' },
  };
}

/* -------------------------------------------------------------------------------------------------
 * Stream peeking utilities
 * ------------------------------------------------------------------------------------------------- */

/**
 * Read up to `limit` bytes from a ReadableStream.
 *
 * In a resolver, we do this because sniffing only needs a prefix, not the whole payload.
 *
 * The usual usage pattern is:
 *
 * - response.body.tee() -> [sniffBranch, consumeBranch]
 * - peekStreamBytes(sniffBranch, N) -> prefix bytes
 * - consumeBranch is passed to the actual extractor/downloader
 *
 * That is why this function does not attempt to “put bytes back” into the stream.
 * The tee branch separation makes that unnecessary.
 */
export async function peekStreamBytes(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;

  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;

      if (total + value.length <= limit) {
        chunks.push(value);
        total += value.length;
        continue;
      }

      const needed = limit - total;
      chunks.push(value.subarray(0, needed));
      total += needed;
      break;
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Inflate a small prefix if gzip is detected.
 *
 * We keep this intentionally small and intentionally gzip-only:
 * - gzip is supported by DecompressionStream in modern Web/Deno.
 * - other formats are not generally available as built-ins.
 *
 * Resolver intent:
 * - confirm tar via ustar when possible (high confidence),
 * - otherwise remain conservative.
 */
export async function gunzipPrefixIfPossible(
  gzipBytes: Uint8Array<ArrayBuffer>,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!("DecompressionStream" in globalThis)) return null;

  try {
    const ds = new DecompressionStream("gzip");
    const decompressed = new Blob([gzipBytes]).stream().pipeThrough(ds);
    return await peekStreamBytes(decompressed, limit);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------------------------------
 * End-to-end response detection
 * ------------------------------------------------------------------------------------------------- */

/**
 * Detect archive/container characteristics from a fetch Response.
 *
 * The output includes a `bodyForConsumption` stream branch so callers can:
 * - sniff using the other tee branch, and
 * - still stream the full payload into an extractor without buffering.
 *
 * The “binary logic” that can be hardest to follow is the precedence:
 *
 * - We start with merged hints (url + headers).
 * - Magic bytes override compression guesses.
 * - ustar confirmation overrides container guesses.
 * - confidence is computed last to preserve uncertainty.
 */
export async function detectArchiveFromResponse(
  url: string | URL,
  response: Response,
  opts: {
    peekWireBytes?: number;
    peekTarBytes?: number;
  } = {},
): Promise<{
  detection: ArchiveDetection;
  diagnostic: ArchiveDiagnostic;
  bodyForConsumption: ReadableStream<Uint8Array> | null;
}> {
  const peekWireBytes = opts.peekWireBytes ?? 1024;
  const peekTarBytes = opts.peekTarBytes ?? 512;

  const urlHint = detectArchiveFromPathHint(url);
  const headerHint = detectArchiveFromHeaders(response.headers);

  const reasons: ArchiveReason[] = [];
  for (const r of urlHint.reasons) reasons.push(r);
  for (const r of headerHint.reasons) reasons.push(r);

  let container = pickContainer(urlHint.container, headerHint.container);
  let compression = pickCompression(urlHint.compression, headerHint.compression);

  const body = response.body;
  if (!body) {
    const detection = finalizeDetection({
      container,
      compression,
      urlHint,
      headerHint,
      reasons,
      magicKnown: false,
      tarConfirmed: false,
    });

    return {
      detection,
      diagnostic: {
        summary: "No response body available for archive detection.",
        details: formatDetectionDetails(detection, new Uint8Array(0), null),
      },
      bodyForConsumption: null,
    };
  }

  const [sniffBranch, consumeBranch] = body.tee();
  const wirePrefix = await peekStreamBytes(sniffBranch, peekWireBytes);

  const magic = sniffCompressionMagic(wirePrefix);
  const magicKnown = magic.compression !== "unknown" || Boolean(magic.containerHint);

  if (magic.compression !== "unknown") {
    compression = magic.compression;
    if (magic.reason) reasons.push(magic.reason);
  }

  if (magic.containerHint && container === "unknown") {
    container = magic.containerHint;
  }

  let tarPrefix: Uint8Array | null = null;

  if (compression === "none" || compression === "unknown") {
    tarPrefix = wirePrefix;
  } else if (compression === "gzip") {
    tarPrefix = await gunzipPrefixIfPossible(wirePrefix, peekTarBytes);
    if (tarPrefix) {
      reasons.push({
        signal: "magic-bytes",
        detail: `Inflated first ${tarPrefix.length} bytes via gzip to check tar header`,
      });
    }
  }

  let tarConfirmed = false;
  if (tarPrefix) {
    const ustar = sniffTarUstar(tarPrefix);
    if (ustar.isTar) {
      container = "tar";
      tarConfirmed = true;
      if (ustar.reason) reasons.push(ustar.reason);
    }
  }

  const detection = finalizeDetection({
    container,
    compression,
    urlHint,
    headerHint,
    reasons,
    magicKnown,
    tarConfirmed,
  });

  return {
    detection,
    diagnostic: {
      summary: formatDetectionSummary(detection),
      details: formatDetectionDetails(detection, wirePrefix, tarPrefix),
    },
    bodyForConsumption: consumeBranch,
  };
}

/**
 * Choose a container guess from two candidates.
 *
 * This function stays intentionally simple because it implements a stable rule:
 * - if we already know the container from one source, prefer it.
 */
export function pickContainer(a: ArchiveContainer, b: ArchiveContainer): ArchiveContainer {
  if (a !== "unknown") return a;
  if (b !== "unknown") return b;
  return "unknown";
}

/**
 * Choose a compression guess from two candidates.
 */
export function pickCompression(a: ArchiveCompression, b: ArchiveCompression): ArchiveCompression {
  if (a !== "unknown") return a;
  if (b !== "unknown") return b;
  return "unknown";
}

/**
 * @internal
 *
 * Finalize merged detection into a stable output format.
 * Kept separate to reduce cognitive load in the main detection function.
 */
export function finalizeDetection(input: {
  container: ArchiveContainer;
  compression: ArchiveCompression;
  urlHint: Pick<ArchiveDetection, "isTarballLike" | "confidence" | "filenameHint" | "urlHint">;
  headerHint: Pick<ArchiveDetection, "isTarballLike" | "confidence" | "filenameHint" | "contentType" | "contentEncoding">;
  reasons: ArchiveReason[];
  magicKnown: boolean;
  tarConfirmed: boolean;
}): ArchiveDetection {
  const isTarballLike =
    input.container === "tar" ||
    input.urlHint.isTarballLike ||
    input.headerHint.isTarballLike;

  const confidence = computeConfidence({
    urlHint: input.urlHint.confidence,
    headerHint: input.headerHint.confidence,
    hasKnownMagic: input.magicKnown,
    tarConfirmed: input.tarConfirmed,
  });

  return {
    container: input.container,
    compression: input.compression,
    isTarballLike,
    confidence,
    reasons: input.reasons,
    filenameHint: input.headerHint.filenameHint ?? input.urlHint.filenameHint,
    urlHint: input.urlHint.urlHint,
    contentType: input.headerHint.contentType,
    contentEncoding: input.headerHint.contentEncoding,
  };
}

/**
 * Confidence rules are intentionally conservative and explainable:
 *
 * - Tar confirmation via ustar is the strongest signal we have -> high.
 * - Known magic bytes gives medium confidence even if container is unknown.
 * - Otherwise we rely on hints -> medium if any hint is medium, else low.
 */
export function computeConfidence(input: {
  urlHint: ArchiveDetection["confidence"];
  headerHint: ArchiveDetection["confidence"];
  hasKnownMagic: boolean;
  tarConfirmed: boolean;
}): ArchiveDetection["confidence"] {
  if (input.tarConfirmed) return "high";
  if (input.hasKnownMagic) return "medium";
  if (input.urlHint === "medium" || input.headerHint === "medium") return "medium";
  return "low";
}

/* -------------------------------------------------------------------------------------------------
 * Diagnostics formatting
 * ------------------------------------------------------------------------------------------------- */

/**
 * Create a one-line summary suitable for logs.
 */
export function formatDetectionSummary(det: ArchiveDetection): string {
  const wrap = det.compression === "none" ? "" : `+${det.compression}`;
  const kind = `${det.container}${wrap}`;
  return `Detected: ${kind} (confidence=${det.confidence}, tarballLike=${det.isTarballLike})`;
}

/**
 * Create a multi-line debug report.
 */
export function formatDetectionDetails(
  det: ArchiveDetection,
  wirePrefix: Uint8Array,
  tarPrefix: Uint8Array | null,
): string {
  const lines: string[] = [];

  lines.push(`urlHint: ${det.urlHint ?? "(none)"}`);
  lines.push(`filenameHint: ${det.filenameHint ?? "(none)"}`);
  lines.push(`contentType: ${det.contentType ?? "(none)"}`);
  lines.push(`contentEncoding: ${det.contentEncoding ?? "(none)"}`);

  // Hex previews are intentionally used here because:
  // - Magic byte signatures are specified and commonly communicated in hex.
  // - Seeing “1f 8b” immediately tells you gzip; decimal would obscure that.
  lines.push(`wirePrefix(${wirePrefix.length}): ${formatHexPreview(wirePrefix)}`);

  if (tarPrefix) {
    lines.push(`tarPrefix(${tarPrefix.length}): ${formatHexPreview(tarPrefix)}`);
  }

  lines.push("reasons:");
  for (const r of det.reasons) {
    lines.push(`- [${r.signal}] ${r.detail}`);
  }

  return lines.join("\n");
}

/**
 * Format a short hex preview of bytes.
 *
 * This function looks “small”, but it saves hours of debugging.
 *
 * Why `.toString(16)`?
 * - That converts a byte value (0..255) into base-16 (hexadecimal) text.
 * - Magic bytes are almost always documented in hex.
 * - So when someone sees: "1f 8b", they can recognize gzip immediately.
 *
 * Why `padStart(2, "0")`?
 * - Hex bytes are conventionally shown as two digits.
 * - 0x0a should print as "0a", not "a", otherwise alignment and readability degrade.
 *
 * Why limit to 16 bytes?
 * - We want a hint, not a hexdump.
 * - If you need more, increase the limit or print the full buffer in a dedicated debug mode.
 *
 * @example
 * formatHexPreview(new Uint8Array([0x1f, 0x8b, 0x08]))
 * // "1f 8b 08"
 */
export function formatHexPreview(bytes: Uint8Array): string {
  const max = Math.min(bytes.length, 16);
  const parts: string[] = [];

  for (let i = 0; i < max; i++) {
    // Convert each byte to two-digit hex.
    parts.push(bytes[i].toString(16).padStart(2, "0"));
  }

  const suffix = bytes.length > max ? " …" : "";
  return parts.join(" ") + suffix;
}
