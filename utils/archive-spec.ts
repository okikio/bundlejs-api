// utils/archive-spec.ts
//
// Spec-level parsers and canonicalizers used by resolver-grade archive detection.
// The intent is to separate “what the spec says” from “what the network does”.
// The policy layer can then choose strict vs lenient behavior explicitly.
//
// We use @std/media-types for Content-Type because it’s exactly the kind of
// spec-aligned parsing logic we should not re-implement by hand.
//
// Content-Disposition is not handled by @std/media-types and has its own RFC grammar,
// so we implement it here in a way that is both strict (source of truth) and
// optionally lenient (reality mode) without mixing those concerns.

import { formatMediaType, parseMediaType } from "./media-types.ts";

/* -------------------------------------------------------------------------------------------------
 * Shared error model
 * ------------------------------------------------------------------------------------------------- */

export type ParseIssueCode =
  | "EMPTY"
  | "INVALID_TOKEN"
  | "INVALID_QUOTED_STRING"
  | "INVALID_PARAMETER"
  | "INVALID_EXT_VALUE"
  | "UNSUPPORTED_CHARSET"
  | "INVALID_PERCENT_ENCODING"
  | "TRAILING_DATA";

export type ParseIssue = {
  code: ParseIssueCode;
  message: string;
  index?: number;
  input?: string;
};

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: readonly ParseIssue[] };

/* -------------------------------------------------------------------------------------------------
 * Content-Type (RFC media type) — delegated to @std/media-types
 * ------------------------------------------------------------------------------------------------- */

/**
 * Canonical media type: "type/subtype" plus a parameters map.
 *
 * `@std/media-types.parseMediaType()` returns a tuple [type, params],
 * where type is normalized to lowercase and param keys are lowercased.
 * We keep a dedicated type so calling code stays explicit.
 */
export type MediaType = {
  type: string;
  parameters: Record<string, string>;
};

/**
 * Parse a Content-Type header value using @std/media-types.
 *
 * Why this exists even though parseMediaType exists:
 * - The spec-layer should expose an explicit success/error shape (ParseResult).
 * - Callers can then decide strict vs lenient policy without exceptions.
 *
 * Note:
 * - `@std/media-types` returns `undefined` when parsing fails.
 * - We translate that into a structured issue.
 */
export function parseContentTypeStrict(
  value: string | null,
): ParseResult<MediaType> {
  if (value == null) {
    return { ok: false, issues: [{ code: "EMPTY", message: "Content-Type is missing." }] };
  }

  const parsed = parseMediaType(value);
  if (!parsed) {
    return {
      ok: false,
      issues: [{ code: "INVALID_TOKEN", message: "Invalid Content-Type media type syntax.", input: value }],
    };
  }

  const [type, params] = parsed;
  return { ok: true, value: { type, parameters: Object.assign({}, params) } };
}

/**
 * Canonicalize a Content-Type header value.
 *
 * This is handy for diagnostics and stable comparisons.
 * It round-trips through parse+format so you do not accidentally compare
 * semantically identical types that differ only in whitespace or casing.
 *
 * @example
 * canonicalizeContentType("Text/HTML; Charset=UTF-8")
 * // -> { ok: true, value: "text/html; charset=UTF-8" }
 */
export function canonicalizeContentType(
  value: string | null,
): ParseResult<string> {
  const parsed = parseContentTypeStrict(value);
  if (!parsed.ok) return parsed;

  const normalized = formatMediaType(parsed.value.type, parsed.value.parameters);
  return { ok: true, value: normalized };
}

/* -------------------------------------------------------------------------------------------------
 * Content-Encoding (RFC 9110 token list) — spec-level list parsing
 * ------------------------------------------------------------------------------------------------- */

/**
 * Content codings are a comma-separated list of tokens (ordered),
 * where the order represents the sequence of encodings applied to the representation.
 *
 * Resolver intent:
 * - callers commonly want the *outermost* coding (the first token).
 * - we return the full list because it’s more truthful and more debuggable.
 */
export type ContentCodingList = readonly string[];

export function parseContentEncodingStrict(
  value: string | null,
): ParseResult<ContentCodingList> {
  if (value == null || value.trim().length === 0) {
    return { ok: true, value: [] };
  }

  // Spec model: a list of `token` separated by commas with optional whitespace.
  // We do not allow empty items.
  const rawItems = value.split(",");
  const codings: string[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i].trim();
    if (item.length === 0) {
      return {
        ok: false,
        issues: [{
          code: "INVALID_TOKEN",
          message: "Invalid Content-Encoding list: empty item.",
          index: i,
          input: value,
        }],
      };
    }

    if (!isToken(item)) {
      return {
        ok: false,
        issues: [{
          code: "INVALID_TOKEN",
          message: `Invalid Content-Encoding token: ${item}`,
          index: i,
          input: value,
        }],
      };
    }

    codings.push(item.toLowerCase());
  }

  return { ok: true, value: codings };
}

/**
 * Convenience: return the outermost coding, or null when absent.
 */
export function getPrimaryContentCoding(
  codings: ContentCodingList,
): string | null {
  return codings.length > 0 ? codings[0] : null;
}

/* -------------------------------------------------------------------------------------------------
 * Content-Disposition (RFC 6266 + RFC 8187) — spec-level strict parser
 * ------------------------------------------------------------------------------------------------- */

/**
 * The parsed shape of Content-Disposition.
 *
 * We keep both raw and decoded values so policy code can choose:
 * - strictly prefer filename* per RFC,
 * - fall back to filename when filename* is missing or invalid,
 * - or record both for diagnostics.
 */
export type ContentDisposition = {
  dispositionType: string; // e.g. "attachment" | "inline" | token
  parameters: Record<string, string>; // decoded, best-effort for strict path
  rawParameters: Record<string, string>; // raw un-decoded parameter values
  filename?: string; // chosen (strict preference), already decoded
  filenameStar?: string; // decoded value of filename*, if present and valid
};

/**
 * Parse Content-Disposition strictly (spec-first).
 *
 * Key spec points encoded here:
 * - disposition-type is a token
 * - parameters are `;` separated
 * - parameter values are token or quoted-string
 * - filename* uses RFC 8187 encoding: charset'lang'%xx...
 *
 * If parsing fails, you get structured issues so policy can decide whether to:
 * - hard-fail,
 * - or try lenient parsing.
 */
export function parseContentDispositionStrict(
  value: string | null,
): ParseResult<ContentDisposition> {
  if (value == null) {
    return { ok: false, issues: [{ code: "EMPTY", message: "Content-Disposition is missing." }] };
  }

  const input = value.trim();
  if (input.length === 0) {
    return { ok: false, issues: [{ code: "EMPTY", message: "Content-Disposition is empty.", input: value }] };
  }

  const state: ParserState = { input, index: 0 };
  const issues: ParseIssue[] = [];

  skipOWS(state);

  const dispositionType = readToken(state, issues);
  if (!dispositionType) return { ok: false, issues };

  skipOWS(state);

  const rawParameters: Record<string, string> = Object.create(null);
  const parameters: Record<string, string> = Object.create(null);

  while (state.index < state.input.length) {
    // Expect ; param=...
    if (!consumeChar(state, ";")) {
      issues.push({
        code: "TRAILING_DATA",
        message: "Unexpected trailing data in Content-Disposition.",
        index: state.index,
        input: state.input,
      });
      break;
    }

    skipOWS(state);

    const name = readToken(state, issues);
    if (!name) break;

    skipOWS(state);

    if (!consumeChar(state, "=")) {
      issues.push({
        code: "INVALID_PARAMETER",
        message: `Expected '=' after parameter name: ${name}`,
        index: state.index,
        input: state.input,
      });
      break;
    }

    skipOWS(state);

    const rawValue = readTokenOrQuotedString(state, issues);
    if (rawValue == null) break;

    rawParameters[name.toLowerCase()] = rawValue;

    // Spec-level decoding:
    // - For filename*, decode RFC 8187.
    // - For other params, keep the raw value (already unquoted/unescaped for quoted-string).
    if (name.toLowerCase() === "filename*") {
      const decoded = decodeRfc8187Value(rawValue);
      if (!decoded.ok) {
        for (const issue of decoded.issues) issues.push(issue);
      } else {
        parameters[name.toLowerCase()] = decoded.value;
      }
    } else {
      parameters[name.toLowerCase()] = rawValue;
    }

    skipOWS(state);
  }

  const filenameStar = parameters["filename*"];
  const filename = filenameStar ?? parameters["filename"];

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      dispositionType: dispositionType.toLowerCase(),
      parameters,
      rawParameters,
      filename: filename ?? undefined,
      filenameStar: filenameStar ?? undefined,
    },
  };
}

/**
 * Lenient Content-Disposition parsing.
 *
 * Policy intent:
 * - strict path is the source of truth
 * - lenient path is a recovery mechanism for real servers
 *
 * This method only tries a small set of deliberate “reality repairs”:
 * - trim outer whitespace
 * - tolerate missing disposition-type by assuming "attachment"
 * - tolerate unquoted filename with stray semicolons by scanning for filename keys
 */
export function parseContentDispositionLenient(
  value: string | null,
): ParseResult<ContentDisposition> {
  const strict = parseContentDispositionStrict(value);
  if (strict.ok) return strict;

  if (value == null) return strict;

  const input = value.trim();
  if (input.length === 0) return strict;

  // Minimal salvage: scan for filename* and filename patterns.
  // This is intentionally limited so the behavior remains predictable.
  const rawParameters: Record<string, string> = Object.create(null);
  const parameters: Record<string, string> = Object.create(null);

  const filenameStarRaw = scanForParamValue(input, "filename*");
  const filenameRaw = scanForParamValue(input, "filename");

  if (filenameStarRaw != null) {
    rawParameters["filename*"] = filenameStarRaw;
    const decoded = decodeRfc8187Value(filenameStarRaw);
    if (decoded.ok) parameters["filename*"] = decoded.value;
  }

  if (filenameRaw != null) {
    rawParameters["filename"] = filenameRaw;
    parameters["filename"] = stripQuotes(filenameRaw);
  }

  const filenameStar = parameters["filename*"];
  const filename = filenameStar ?? parameters["filename"];

  return {
    ok: true,
    value: {
      dispositionType: "attachment",
      parameters,
      rawParameters,
      filename: filename ?? undefined,
      filenameStar: filenameStar ?? undefined,
    },
  };
}

/**
 * Extract a filename from Content-Disposition using strict parsing by default.
 * If strict fails, lenient parsing is attempted.
 *
 * This gives your detection policy a single call site while preserving the
 * strict-vs-lenient separation in code and diagnostics.
 */
export function extractFilenameFromContentDisposition(
  headerValue: string | null,
): { filename: string | null; mode: "strict" | "lenient"; issues?: readonly ParseIssue[] } {
  const strict = parseContentDispositionStrict(headerValue);
  if (strict.ok) {
    return { filename: strict.value.filename ?? null, mode: "strict" };
  }

  const lenient = parseContentDispositionLenient(headerValue);
  if (lenient.ok) {
    return { filename: lenient.value.filename ?? null, mode: "lenient", issues: strict.issues };
  }

  return { filename: null, mode: "strict", issues: strict.issues };
}

/* -------------------------------------------------------------------------------------------------
 * RFC 8187 value decoding (charset'lang'percent-encoded)
 * ------------------------------------------------------------------------------------------------- */

export function decodeRfc8187Value(
  value: string,
): ParseResult<string> {
  // The value is expected to be: charset'lang'%XX%YY...
  // We treat missing parts as invalid in strict mode.
  const firstQuote = value.indexOf("'");
  const secondQuote = firstQuote === -1 ? -1 : value.indexOf("'", firstQuote + 1);

  if (firstQuote === -1 || secondQuote === -1) {
    return {
      ok: false,
      issues: [{
        code: "INVALID_EXT_VALUE",
        message: "Invalid extended parameter value (expected charset'lang'value).",
        input: value,
      }],
    };
  }

  const charset = value.slice(0, firstQuote).trim().toLowerCase();
  // lang is informational; we parse but do not enforce.
  const _lang = value.slice(firstQuote + 1, secondQuote).trim();
  const encoded = value.slice(secondQuote + 1);

  if (charset !== "utf-8" && charset !== "iso-8859-1") {
    return {
      ok: false,
      issues: [{
        code: "UNSUPPORTED_CHARSET",
        message: `Unsupported extended parameter charset: ${charset}`,
        input: value,
      }],
    };
  }

  // Percent-decoding: decodeURIComponent handles UTF-8 percent sequences.
  // For iso-8859-1, decodeURIComponent is not correct for all bytes, but many servers
  // use UTF-8 in practice. If you need true ISO-8859-1 fidelity, implement byte mapping.
  try {
    return { ok: true, value: decodeURIComponent(encoded) };
  } catch {
    return {
      ok: false,
      issues: [{
        code: "INVALID_PERCENT_ENCODING",
        message: "Invalid percent-encoding in extended parameter value.",
        input: value,
      }],
    };
  }
}

/* -------------------------------------------------------------------------------------------------
 * Internal parsing primitives
 * ------------------------------------------------------------------------------------------------- */

export type ParserState = {
  input: string;
  index: number;
};

/**
 * @internal
 *
 * OWS = optional whitespace. In HTTP header ABNF, this typically means SP / HTAB.
 */
export function skipOWS(state: ParserState): void {
  const s = state.input;
  while (state.index < s.length) {
    const c = s.charCodeAt(state.index);
    if (c === 0x20 || c === 0x09) {
      state.index++;
      continue;
    }
    break;
  }
}

/**
 * @internal
 *
 * token per RFC “tchar” set. We keep this strict because it’s the source of truth layer.
 */
export function isToken(value: string): boolean {
  if (value.length === 0) return false;

  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (!isTchar(ch)) return false;
  }

  return true;
}

/**
 * @internal
 *
 * tchar set based on RFC 7230 / RFC 9110 token grammar:
 * "!" / "#" / "$" / "%" / "&" / "'" / "*" / "+" / "-" / "." /
 * "^" / "_" / "`" / "|" / "~" / DIGIT / ALPHA
 */
export function isTchar(ch: number): boolean {
  // DIGIT
  if (ch >= 0x30 && ch <= 0x39) return true;
  // ALPHA
  if (ch >= 0x41 && ch <= 0x5a) return true;
  if (ch >= 0x61 && ch <= 0x7a) return true;

  switch (ch) {
    case 0x21: // !
    case 0x23: // #
    case 0x24: // $
    case 0x25: // %
    case 0x26: // &
    case 0x27: // '
    case 0x2a: // *
    case 0x2b: // +
    case 0x2d: // -
    case 0x2e: // .
    case 0x5e: // ^
    case 0x5f: // _
    case 0x60: // `
    case 0x7c: // |
    case 0x7e: // ~
      return true;
    default:
      return false;
  }
}

/**
 * @internal
 *
 * Consume a specific character if present.
 */
export function consumeChar(state: ParserState, ch: string): boolean {
  if (state.input[state.index] === ch) {
    state.index++;
    return true;
  }
  return false;
}

/**
 * @internal
 *
 * Read a token starting at the current position.
 */
export function readToken(
  state: ParserState,
  issues: ParseIssue[],
): string | null {
  const start = state.index;
  const s = state.input;

  while (state.index < s.length) {
    const ch = s.charCodeAt(state.index);
    if (!isTchar(ch)) break;
    state.index++;
  }

  const out = s.slice(start, state.index);
  if (out.length === 0) {
    issues.push({
      code: "INVALID_TOKEN",
      message: "Expected token.",
      index: state.index,
      input: state.input,
    });
    return null;
  }

  return out;
}

/**
 * @internal
 *
 * Read either a token or a quoted-string.
 *
 * Quoted-string rules:
 * - starts with "
 * - supports backslash escaping for quotes and backslash itself
 *
 * We keep this strict and predictable. Policy can choose lenient mode elsewhere.
 */
export function readTokenOrQuotedString(
  state: ParserState,
  issues: ParseIssue[],
): string | null {
  const s = state.input;

  if (s[state.index] === "\"") {
    return readQuotedString(state, issues);
  }

  const token = readToken(state, issues);
  return token;
}

/**
 * @internal
 */
export function readQuotedString(
  state: ParserState,
  issues: ParseIssue[],
): string | null {
  const s = state.input;

  if (!consumeChar(state, "\"")) {
    issues.push({
      code: "INVALID_QUOTED_STRING",
      message: "Expected opening quote for quoted-string.",
      index: state.index,
      input: s,
    });
    return null;
  }

  let out = "";

  while (state.index < s.length) {
    const ch = s[state.index];

    if (ch === "\"") {
      state.index++;
      return out;
    }

    if (ch === "\\") {
      state.index++;
      if (state.index >= s.length) {
        issues.push({
          code: "INVALID_QUOTED_STRING",
          message: "Backslash escape at end of quoted-string.",
          index: state.index,
          input: s,
        });
        return null;
      }

      // Accept the escaped char verbatim.
      out += s[state.index];
      state.index++;
      continue;
    }

    out += ch;
    state.index++;
  }

  issues.push({
    code: "INVALID_QUOTED_STRING",
    message: "Unterminated quoted-string.",
    index: state.index,
    input: s,
  });

  return null;
}

/* -------------------------------------------------------------------------------------------------
 * Lenient helpers (deliberately limited)
 * ------------------------------------------------------------------------------------------------- */

/**
 * @internal
 *
 * Scan for a parameter in a semi-colon-ish string. This is not a full parser.
 * It exists only to provide a controlled fallback in lenient mode.
 */
export function scanForParamValue(input: string, paramName: string): string | null {
  const lower = input.toLowerCase();
  const key = paramName.toLowerCase() + "=";

  const idx = lower.indexOf(key);
  if (idx === -1) return null;

  const start = idx + key.length;
  const rest = input.slice(start).trimStart();

  // If it starts with a quote, read until next quote. Otherwise read until semicolon.
  if (rest.startsWith("\"")) {
    const end = rest.indexOf("\"", 1);
    if (end === -1) return rest.slice(1);
    return rest.slice(1, end);
  }

  const semi = rest.indexOf(";");
  return semi === -1 ? rest.trim() : rest.slice(0, semi).trim();
}

/**
 * @internal
 */
export function stripQuotes(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}
