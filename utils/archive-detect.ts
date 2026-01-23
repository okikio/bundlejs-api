// core/utils/archive-detect.ts
//
// Resolver-grade archive detection.
//
// This file is not an “archiver” and it is not trying to unpack anything by itself.
// It exists to answer one question as cheaply and as reliably as possible:
//
//   “Given a URL and a Response, is this payload an archive, and if so, what kind?”
//
// In a Node resolution pipeline, this question is a gate:
//
// - If we think it’s a tarball, we might mount/extract it into a virtual filesystem.
// - If we think it’s a JS/TS module, we might parse it as code and continue resolving imports.
// - If we think it’s HTML or something else, we should stop and emit a meaningful diagnostic.
//
// The trick is that the network often lies:
//
// - Content-Type is frequently "application/octet-stream" even when the bytes are gzip.
// - Content-Encoding might be absent even when the payload is compressed.
// - A “tarball URL” might redirect to an HTML page or a JS entry file.
// - Some servers set Content-Disposition filename but omit everything else.
//
// So we treat detection like a courtroom:
//
// - URL/path extensions are testimony (helpful, but can be wrong).
// - Headers are sworn testimony (more formal, still can be wrong).
// - Magic bytes are physical evidence (usually the most trustworthy).
//
// We structure the code so the “physical evidence” can override hints,
// and we always keep the chain-of-reasoning in `reasons` so diagnostics can explain
// what happened without guessing.
//
// The central mental model: container vs wrapper.
//
// - A *container* is the thing that holds files: tar, zip.
// - A *compression wrapper* is what shrinks bytes for transport: gzip, zstd, xz, etc.
//
// Examples people recognize:
//
// - .tar.gz  => tar container wrapped in gzip
// - .tgz     => same thing, different shorthand
// - .tar.zst => tar container wrapped in zstd
// - .zip     => zip container (zip is both container and has its own internal compression)
// - .gz      => ambiguous: could be “a single gzipped file”, or “a gzipped tar”
//
// The detection policy is layered:
//
// 1) Path hint (URL or filename)  -> cheap, medium-signal.
// 2) Header hint                  -> spec-defined, still not authoritative.
// 3) Byte sniff (wire prefix)     -> authoritative for wrapper/container signatures.
// 4) Tar confirmation (ustar)     -> authoritative for tar specifically.
//
// We keep this file “policy-level”. Strict parsing lives in archive-spec.ts.
// This file consumes those parsers and turns them into practical routing decisions.

import { basename } from "@std/path";

import {
  extractFilenameFromContentDisposition,
  getPrimaryContentCoding,
  parseContentEncodingStrict,
  parseContentTypeStrict,
  type ParseIssue,
} from "./archive-spec.ts";

/* -------------------------------------------------------------------------------------------------
 * Public types
 * ------------------------------------------------------------------------------------------------- */

/**
 * Compression wrapper applied to a payload.
 *
 * Resolver context:
 * - You can detect more formats than you can currently decompress.
 * - Detection is about routing and diagnostics, not necessarily about “supporting extraction”.
 *
 * That’s why the union includes formats that your runtime may not be able to decode yet.
 * The resolver can still surface “this is .tar.zst” rather than “unknown blob”.
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
  | "compress"
  | "deflate"
  | "deflate-raw"
  | "unknown";

/**
 * Container format after any outer compression wrapper is removed.
 */
export type ArchiveContainer =
  | "tar"
  | "zip"
  | "unknown";

/**
 * Each reason has a signal source so you can understand “why we believe this”.
 * This is the difference between “works” and “debuggable”.
 */
export type ArchiveSignal =
  | "url"
  | "content-type"
  | "content-encoding"
  | "content-disposition"
  | "magic-bytes"
  | "tar-ustar";

/**
 * Small structured breadcrumb for diagnostics.
 */
export type ArchiveReason = {
  signal: ArchiveSignal;
  detail: string;
};

/**
 * Final detection result.
 *
 * `confidence` is intentionally conservative:
 * - high: we have strong byte-based confirmation (e.g. tar ustar header)
 * - medium: magic bytes indicate wrapper/container, or strong filename hints
 * - low: mostly hints; caller should be prepared for “it’s actually HTML/JS”
 */
export type ArchiveDetection = {
  container: ArchiveContainer;
  compression: ArchiveCompression;
  isTarballLike: boolean;
  confidence: "high" | "medium" | "low";
  reasons: Iterable<ArchiveReason>;

  // Evidence (inputs) captured for debugging and future refactors.
  filenameHint?: string;
  urlHint?: string;

  contentType?: string | null;
  contentEncoding?: string | null;

  // Content-Disposition parsing is strict-first with controlled lenient fallback.
  // We store the mode and issues so we can diagnose “why strict failed”.
  contentDispositionMode?: "strict" | "lenient";
  contentDispositionIssues?: readonly ParseIssue[];
};

/**
 * Debug output meant for logs.
 * The guiding principle is: if someone pastes this into an issue, you can triage quickly.
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
 * Why we prefer multi-extension matches over single-extension matches:
 * - `.tar.zst` means “tar container” with “zstd wrapper”.
 * - If you only look at `.zst`, you lose the container identity.
 *
 * Spec note:
 * - File extensions are conventions, not HTTP standards.
 * - Still useful as early hints because publishers encode intent into filenames.
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
 * Short tarball extensions (publisher conventions).
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
 * Content-Types that show up in tarball delivery endpoints.
 *
 * Policy note:
 * - This is never a hard gate.
 * - It’s a “raise your eyebrows” hint, not a conviction.
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
 * Path / URL hint detection
 * ------------------------------------------------------------------------------------------------- */

/**
 * Detect archive hints from a URL or filename.
 *
 * This is the earliest and cheapest stage: it does not touch the network and it does not read bytes.
 * It is also the least reliable stage, because URLs can lie and CDNs can rewrite paths.
 *
 * The “why” of this function:
 * - In resolvers, we often want to decide early whether to even attempt a tarball pipeline.
 * - If the response body is missing (HEAD requests, errors), this might be all we have.
 *
 * The “how” in plain terms:
 * - We look for “most specific” multi-extensions first (.tar.zst beats .zst).
 * - Then we look for short-hand tar extensions (.tgz, .txz).
 * - Then we fall back to single extensions (.tar, .gz) with lower confidence.
 *
 * @example
 * detectArchiveFromPathHint("pkg.tar.zst")
 * // container="tar", compression="zstd", confidence="medium"
 *
 * @example
 * detectArchiveFromPathHint("pkg.gz")
 * // compression="gzip", container="unknown" (ambiguous), confidence="low"
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

  // basename() gives us the last path segment which is the best extension signal we can get.
  // If URL parsing fails for some reason, we fall back to a best-effort basename on the whole string.
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

  // The most common “hard to follow” bug in archive detection is checking ".zst" before ".tar.zst".
  // That makes `.tar.zst` look like “some zstd blob” instead of “a tar container wrapped in zstd”.
  // So we always check the multi-extensions first.
  for (const ext of TAR_MULTI_EXTENSIONS) {
    if (lower.endsWith(ext.toLowerCase())) {
      container = "tar";
      compression = mapTarMultiExtensionToCompression(ext);
      confidence = "medium";
      isTarballLike = true;

      reasons.push({
        signal: "url",
        detail: `Filename ends with ${ext} (publisher intent hint: tar container + wrapper)`,
      });

      return { container, compression, isTarballLike, confidence, reasons, filenameHint, urlHint };
    }
  }

  // Next: short tarball conventions.
  for (const ext of TAR_SHORT_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      container = "tar";
      compression = mapTarShortExtensionToCompression(ext);
      confidence = "medium";
      isTarballLike = true;

      reasons.push({
        signal: "url",
        detail: `Filename ends with ${ext} (short tarball convention hint)`,
      });

      return { container, compression, isTarballLike, confidence, reasons, filenameHint, urlHint };
    }
  }

  // Finally: single-extension hints.
  // These are lower-confidence because they do not uniquely identify a “tarball”.
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
      detail: "Filename ends with .gz (ambiguous: could be a gzipped tar or a single gzipped file)",
    });
  } else if (lower.endsWith(".zst") || lower.endsWith(".zstd")) {
    compression = "zstd";
    confidence = "low";

    reasons.push({
      signal: "url",
      detail: "Filename ends with .zst/.zstd (ambiguous without an explicit tar hint)",
    });
  }

  return { container, compression, isTarballLike, confidence, reasons, filenameHint, urlHint };
}

/**
 * Map known tar multi-extensions to wrapper types.
 *
 * We keep this mapping explicit because it becomes a long-lived “convention dictionary”.
 * When new extensions appear in the wild, you add them here, and diagnostics automatically improve.
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

  // “compress” is the classic Unix .Z encoding; it still appears occasionally.
  if (lower === ".tar.z") return "compress";

  // ".tar.lz" is not consistently defined across ecosystems; treat as unknown wrapper.
  if (lower === ".tar.lz") return "unknown";

  return "unknown";
}

/**
 * Map known tar short extensions to wrapper types.
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
 * Header hint detection (spec-first via archive-spec.ts)
 * ------------------------------------------------------------------------------------------------- */

/**
 * Detect archive hints from headers.
 *
 * There are three useful header sources:
 *
 * - Content-Type:
 *   “What the server claims the representation is.”
 *   Helpful, but often generic or wrong.
 *
 * - Content-Encoding:
 *   “What transformations were applied *in transit*.”
 *   This can indicate gzip/brotli even if the URL says nothing.
 *
 * - Content-Disposition:
 *   “Suggested filename for a download.”
 *   Surprisingly helpful because CDNs sometimes include a real filename even when the URL is opaque.
 *
 * We parse headers strictly in archive-spec.ts (source of truth),
 * and only do controlled recovery for Content-Disposition filename extraction.
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
  | "contentDispositionMode"
  | "contentDispositionIssues"
> {
  const reasons: ArchiveReason[] = [];

  const contentTypeRaw = headers.get("content-type");
  const contentEncodingRaw = headers.get("content-encoding");
  const contentDispositionRaw = headers.get("content-disposition");

  // Content-Type parsing is spec-level and delegated to @std/media-types by archive-spec.ts.
  // We store both the raw and the parsed base type because:
  // - raw is what you print in logs,
  // - parsed base type is what you compare in policy decisions.
  const contentTypeParsed = parseContentTypeStrict(contentTypeRaw);
  let contentTypeBase: string | null = null;

  if (contentTypeParsed.ok) {
    contentTypeBase = contentTypeParsed.value.type;
    reasons.push({
      signal: "content-type",
      detail: `Content-Type parsed as ${contentTypeBase}`,
    });
  } else if (contentTypeRaw) {
    reasons.push({
      signal: "content-type",
      detail: `Content-Type present but unparseable: ${contentTypeRaw}`,
    });
  }

  // Content-Encoding parsing is strict: a comma-separated list of tokens.
  // We keep the entire list in the spec layer, but here we mostly care about the “outermost”
  // encoding (the first coding), because that’s what you would need to undo first.
  const encodingParsed = parseContentEncodingStrict(contentEncodingRaw);
  const codingList = encodingParsed.ok ? encodingParsed.value : [];
  const primaryCoding = getPrimaryContentCoding(codingList);

  if (contentEncodingRaw) {
    reasons.push({
      signal: "content-encoding",
      detail: `Content-Encoding raw=${contentEncodingRaw}`,
    });
  }

  // Content-Disposition filename extraction: strict first, then controlled lenient.
  // We track the mode and issues because “why did strict fail?” matters in resolver debugging.
  const cd = extractFilenameFromContentDisposition(contentDispositionRaw);
  let filenameHint: string | undefined;

  if (cd.filename) {
    filenameHint = cd.filename;

    reasons.push({
      signal: "content-disposition",
      detail: `Content-Disposition filename=${cd.filename} (mode=${cd.mode})`,
    });
  } else if (contentDispositionRaw) {
    reasons.push({
      signal: "content-disposition",
      detail: `Content-Disposition present but no filename extracted (mode=${cd.mode})`,
    });
  }

  let container: ArchiveContainer = "unknown";
  let compression: ArchiveCompression = "unknown";
  let confidence: ArchiveDetection["confidence"] = "low";
  let isTarballLike = false;

  // Header hints are intentionally not “authoritative”. They move suspicion up or down,
  // but the byte sniff stage gets the final say when available.
  if (contentTypeBase) {
    // This is a “tar-ish payload might be here” hint. We do not assert tar.
    if (TAR_CONTENT_TYPES.includes(contentTypeBase)) {
      isTarballLike = true;
      confidence = "low";
    }

    // When the media type is explicitly tar, that’s a stronger claim.
    if (contentTypeBase === "application/tar" || contentTypeBase === "application/x-tar") {
      container = "tar";
      isTarballLike = true;
      confidence = "medium";
    }

    // Some servers label the wrapper type instead of the container.
    if (contentTypeBase === "application/gzip" || contentTypeBase === "application/x-gzip") {
      compression = "gzip";
      isTarballLike = true;
    }

    if (contentTypeBase === "application/zstd") {
      compression = "zstd";
      isTarballLike = true;
    }

    if (contentTypeBase === "application/xz") {
      compression = "xz";
      isTarballLike = true;
    }
  }

  // Content-Encoding is about the transport wrapper.
  // We normalize to our union so later code doesn’t have to reason about strings.
  if (primaryCoding) {
    const normalized = normalizeContentEncodingToken(primaryCoding);
    if (normalized !== "unknown") {
      compression = normalized;
      isTarballLike = true;
    }
  }

  // If Content-Disposition gave us a filename, treat it like a “path hint”
  // and merge it using the exact same path-hint logic.
  //
  // This avoids a subtle inconsistency where URL hints and filename hints drift apart over time.
  if (filenameHint) {
    const byName = detectArchiveFromPathHint(filenameHint);

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
    filenameHint,
    contentType: contentTypeRaw,
    contentEncoding: contentEncodingRaw,
    contentDispositionMode: cd.mode,
    contentDispositionIssues: cd.issues,
  };
}

/**
 * Normalize a Content-Encoding token into our wrapper union.
 *
 * Content-Encoding is a token list; tokens are case-insensitive in practice.
 * We normalize to lowercase and then map known values.
 *
 * Note:
 * - If you later add support for zstd via Content-Encoding (some servers do),
 *   this is the function you’d extend.
 */
export function normalizeContentEncodingToken(token: string): ArchiveCompression {
  const lower = token.trim().toLowerCase();

  switch (lower) {
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

/**
 * Confidence merging stays intentionally tiny.
 *
 * When confidence merging becomes complicated, it usually means:
 * - we’re encoding a scoring system implicitly
 * - and we should introduce an explicit scoring function instead.
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
 * Byte sniffing (“physical evidence”)
 * ------------------------------------------------------------------------------------------------- */

/**
 * Sniff compression/container using magic bytes at the beginning of the wire payload.
 *
 * Why magic bytes matter:
 * - For wrapper formats like gzip and zstd, the signature is near byte 0.
 * - Headers and filenames can be wrong, but bytes rarely lie.
 *
 * What we return:
 * - compression wrapper, if recognized
 * - container hint for zip, because zip has a strong signature at byte 0
 *
 * What we do not claim:
 * - we do not confirm tar here, because tar has no signature at byte 0.
 *   Tar confirmation happens later via the ustar marker at offset 257.
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

  // bzip2: "BZh" -> 42 5A 68
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

  // lzip: "LZIP" -> 4C 5A 49 50
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

  // zip container magic: PK..
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
 * Zip is easier to confirm than tar because it has a signature at byte 0.
 */
export function isZipMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;

  const b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];

  // PK\x03\x04 (local file header)
  // PK\x05\x06 (empty archive)
  // PK\x07\x08 (spanned archive)
  if (b0 === 0x50 && b1 === 0x4b) {
    if (b2 === 0x03 && b3 === 0x04) return true;
    if (b2 === 0x05 && b3 === 0x06) return true;
    if (b2 === 0x07 && b3 === 0x08) return true;
  }

  return false;
}

/**
 * Confirm tar via the POSIX “ustar” marker.
 *
 * This is where tar differs from most formats:
 * - There is no “magic number” at the beginning of the file.
 * - Instead, the first file header is 512 bytes and includes the ustar marker at offset 257.
 *
 * Why offset 257?
 * - That’s defined by the tar header layout (POSIX ustar).
 * - So to confirm tar, we must have at least 262 bytes of the *tar stream* (not the gz stream).
 *
 * This function is a pure check:
 * - it does not try to validate checksums or parse headers,
 * - it only answers “does this look like a ustar tar header?”
 */
export function sniffTarUstar(bytes: Uint8Array): { isTar: boolean; reason?: ArchiveReason } {
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
 * Stream peeking helpers
 * ------------------------------------------------------------------------------------------------- */

/**
 * Read up to `limit` bytes from a stream and return them as a single Uint8Array.
 *
 * Resolver context:
 * - For sniffing, we only need a prefix (e.g., first 1KB).
 * - We want to avoid buffering entire responses just to detect gzip vs zstd vs HTML.
 *
 * Important workflow note:
 * - This function assumes you already split the stream via `tee()`.
 * - That’s the “resolver trick” that keeps sniffing cheap:
 *
 *   const [sniffBranch, consumeBranch] = response.body.tee();
 *   const prefix = await peekStreamBytes(sniffBranch, 1024);
 *   // consumeBranch continues to stream full payload for extraction or compilation
 *
 * We do not “put bytes back” into the stream because the tee() split avoids that need.
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

      // Only take the prefix we need from the last chunk.
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
 * Inflate a small prefix when gzip is detected.
 *
 * Why we do this:
 * - For .tar.gz, ustar confirmation requires looking into the tar stream.
 * - The tar stream is inside gzip, so we must inflate at least a small window first.
 *
 * Why we only do gzip here:
 * - Web/Deno provides DecompressionStream("gzip") in many runtimes.
 * - zstd/xz/bzip2 are not generally available as built-ins.
 *
 * Policy implication:
 * - gzip tarballs can become “high confidence” (ustar confirmed).
 * - zstd tarballs may remain “medium confidence” unless you add a zstd inflater later.
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
 * This function is designed to plug directly into a tarball “mount” step in a resolver.
 * It returns:
 *
 * - `detection`: what we believe, with confidence and reasons.
 * - `diagnostic`: human-readable summary/details for logs.
 * - `bodyForConsumption`: a stream branch that still contains the full payload.
 *
 * The core idea is to split the response body:
 * - One branch is used for sniffing a small prefix.
 * - The other branch is preserved for the actual consumer (extractor/compiler).
 *
 * The slightly tricky part is the precedence order:
 * - We start with hints (URL + headers).
 * - Magic bytes override wrapper guesses.
 * - Tar ustar confirmation overrides container guesses.
 * - Confidence is computed last based on what we actually confirmed.
 *
 * @example
 * const { detection, bodyForConsumption } = await detectArchiveFromResponse(url, res);
 * if (detection.container === "tar") {
 *   // route into tarball mount/extract path using bodyForConsumption
 * } else {
 *   // treat as module/html/etc and handle accordingly
 * }
 */
export async function detectArchiveFromResponse(
  url: string | URL,
  response: Response,
  opts: { peekWireBytes?: number; peekTarBytes?: number } = {},
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

  // Start with the best hints we have.
  // Later stages (magic bytes / ustar) can override these.
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

  // Magic bytes can conclusively identify wrapper formats (gzip, zstd, xz, etc).
  // If magic disagrees with hints, we trust magic.
  const magic = sniffCompressionMagic(wirePrefix);
  const magicKnown = magic.compression !== "unknown" || Boolean(magic.containerHint);

  if (magic.compression !== "unknown") {
    compression = magic.compression;
    if (magic.reason) reasons.push(magic.reason);
  }

  if (magic.containerHint && container === "unknown") {
    container = magic.containerHint;
  }

  // Tar confirmation requires tar bytes, not wrapper bytes.
  //
  // For plain tar (no wrapper), wirePrefix might already be tar bytes.
  // For gzip-wrapped tar, we can inflate a prefix and check ustar.
  // For other wrappers, we currently cannot inflate without extra dependencies, so we stop at hints.
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
 * Container merging rule: prefer known over unknown.
 *
 * This looks trivial, and that’s a feature:
 * - you want this kind of merge logic to be stable, boring, and hard to break.
 */
export function pickContainer(a: ArchiveContainer, b: ArchiveContainer): ArchiveContainer {
  if (a !== "unknown") return a;
  if (b !== "unknown") return b;
  return "unknown";
}

/**
 * Compression merging rule: prefer known over unknown.
 */
export function pickCompression(a: ArchiveCompression, b: ArchiveCompression): ArchiveCompression {
  if (a !== "unknown") return a;
  if (b !== "unknown") return b;
  return "unknown";
}

/**
 * Finalize a detection into a stable output shape.
 *
 * This is separated out because the end-to-end function is already “branchy”.
 * Branchy logic is where future bugs hide, so we keep the final assembly step pure and obvious.
 *
 * @internal
 */
export function finalizeDetection(input: {
  container: ArchiveContainer;
  compression: ArchiveCompression;
  urlHint: Pick<ArchiveDetection, "isTarballLike" | "confidence" | "filenameHint" | "urlHint">;
  headerHint: Pick<
    ArchiveDetection,
    | "isTarballLike"
    | "filenameHint"
    | "confidence"
    | "contentType"
    | "contentEncoding"
    | "contentDispositionMode"
    | "contentDispositionIssues"
  >;
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
    contentDispositionMode: input.headerHint.contentDispositionMode,
    contentDispositionIssues: input.headerHint.contentDispositionIssues,
  };
}

/**
 * Confidence rules are intentionally conservative and explainable.
 *
 * Think of confidence like a “how surprised would we be if we were wrong?” meter:
 *
 * - Tar ustar confirmation: we would be very surprised -> high.
 * - Known magic bytes: we would be somewhat surprised -> medium.
 * - Only hints: we would not be surprised -> low.
 *
 * This function is tiny on purpose. If you need more nuance later,
 * add an explicit scoring system rather than letting a pile of if-statements grow here.
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
 * Produce a one-line summary for logs.
 */
export function formatDetectionSummary(det: ArchiveDetection): string {
  const wrap = det.compression === "none" ? "" : `+${det.compression}`;
  const kind = `${det.container}${wrap}`;
  return `Detected: ${kind} (confidence=${det.confidence}, tarballLike=${det.isTarballLike})`;
}

/**
 * Produce a multi-line debug report.
 *
 * The goal is not to dump everything; it’s to show the evidence that drives decisions:
 * - what we saw in URL/filename
 * - what headers said
 * - what the first bytes looked like
 * - which reasons were used to reach the conclusion
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

  if (det.contentDispositionMode) {
    lines.push(`contentDispositionMode: ${det.contentDispositionMode}`);
  }

  if (det.contentDispositionIssues && det.contentDispositionIssues.length > 0) {
    lines.push(`contentDispositionIssues: ${det.contentDispositionIssues.length}`);
    for (const issue of det.contentDispositionIssues) {
      lines.push(`  - ${issue.code}: ${issue.message}`);
    }
  }

  // Hex previews are the most practical way to debug magic-byte sniffing:
  // - gzip is 1f 8b
  // - zstd is 28 b5 2f fd
  // - zip starts with 50 4b
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
 * This looks like a tiny helper, but it’s one of the best “future maintainer gifts”:
 * when someone is diagnosing a tarball failure, they can recognize signatures instantly.
 *
 * Why `.toString(16)`?
 * - Bytes are numbers 0..255.
 * - Magic signatures are universally documented in hexadecimal.
 * - Converting each byte to hex makes the output match specs, docs, and tooling.
 *
 * Why `padStart(2, "0")`?
 * - A byte in hex is conventionally shown as two characters.
 * - 0x0a should be “0a”, not “a”, otherwise the preview becomes hard to scan.
 *
 * Why we cap at 16 bytes?
 * - We want a fingerprint, not a full hexdump.
 * - Logs should stay readable.
 *
 * @example
 * formatHexPreview(new Uint8Array([0x1f, 0x8b, 0x08]))
 * // "1f 8b 08"
 */
export function formatHexPreview(bytes: Uint8Array): string {
  const max = Math.min(bytes.length, 16);
  const parts: string[] = [];

  for (let i = 0; i < max; i++) {
    parts.push(bytes[i].toString(16).padStart(2, "0"));
  }

  const suffix = bytes.length > max ? " …" : "";
  return parts.join(" ") + suffix;
}
