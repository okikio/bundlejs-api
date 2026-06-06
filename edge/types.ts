import type { BuildConfig } from "@bundle/core";
import type { CompressConfig } from "@bundle/compress";

/**
 * Shared edge/runtime config type.
 *
 * This is the (slightly extended) config shape we pass down into `@bundle/core`.
 * It intentionally lives outside `edge/mod.ts` so both Deno Deploy and
 * Cloudflare Workers can import it without creating circular dependencies.
 */
export type Config = BuildConfig & {
  /**
   * Compression settings used when reporting compressed bundle sizes.
   *
   * Note: the build pipeline may still produce uncompressed output; this config
   * primarily controls which compression algorithm is used for size reporting.
   */
  compression?: CompressConfig;

  /**
   * Enables esbuild analyze output in the response when requested.
   *
   * Some call sites use a boolean, others pass through the query string
   * (e.g. `verbose`).
   */
  analysis?: boolean | string;

  /**
   * When true, treat the entrypoint as TSX/JSX.
   *
   * This is a convenience flag which ultimately affects the generated
   * `entryPoints` extension (`.tsx` vs `.ts`).
   */
  tsx?: boolean;
};
