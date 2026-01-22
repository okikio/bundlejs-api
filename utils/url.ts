import { join as joinUrl } from "@std/path/posix"; 

export const WHITESPACE_ENCODINGS: Record<string, string> = {
  "\u0009": "%09",
  "\u000A": "%0A",
  "\u000B": "%0B",
  "\u000C": "%0C",
  "\u000D": "%0D",
  "\u0020": "%20",
};

export function encodeWhitespace(string: string): string {
  return string.replaceAll(/[\s]/g, (c) => {
    return WHITESPACE_ENCODINGS[c] ?? c;
  });
}

/** 
 * Based on https://github.com/egoist/play-esbuild/blob/main/src/lib/path.ts#L123
 * 
 * Support joining paths to a URL
 */
export const urlJoin = (urlStr: string, ...args: string[]) => {
  const url = new URL(urlStr);
  url.pathname = encodeWhitespace(
    joinUrl(url.pathname, ...args).replace(/%/g, "%25").replace(/\\/g, "%5C"),
  );
  return url.toString();
};

export function toURLPath(url: string | URL, base?: URL | string) {
  const _url = new URL(url, base);
  const _host = _url.host.replace(/\./g, "_");
  const _path = _url.pathname || "/";
  return `/${_host}${_path}`;
}
