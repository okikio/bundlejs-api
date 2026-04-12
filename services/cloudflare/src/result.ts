import type { CompressionType } from "@bundle/compress";
import type { BundleResult } from "../../edge/bundle.ts";

import { ansi } from "@bundle/utils";

import { LOGGER_INFO, dispatchEvent, getEsbuild } from "@bundle/core";
import { headers } from "../../edge/constants.ts";
import styleText from "../../edge/style.ts";
import type { Env } from "./types.ts";
import { getBundleArtifactText, putCachedBadge } from "./storage.ts";

export const timeFormatter = new Intl.RelativeTimeFormat("en", {
  style: "narrow",
  numeric: "auto"
});

function sanitizeShieldsIO(str: string) {
  return str
    .replace(/\-/g, "--")
    .replace(/\_/g, "__")
    .replace(/\s/g, "_");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return arrayBuffer;
}

function toBodyInit(value: string | Uint8Array): BodyInit {
  return typeof value === "string" ? value : toArrayBuffer(value);
}

export async function generateWorkerResult(
  env: Env,
  [badgeKey, badgeID]: string[],
  [value, resultText]: [BundleResult, string | undefined],
  url: URL,
  cached: boolean,
  duration: number,
  artifactKey?: string | null
) {
  const noCache = ["/no-cache", "/clear-cache", "/delete-cache"].includes(url.pathname);
  const analysisQuery = url.searchParams.has("analysis") ||
    url.searchParams.has("analyze") ||
    ["/analysis", "/analyze"].includes(url.pathname);

  const analysisResult = url.searchParams.get("analysis") ||
    url.searchParams.get("analyze");

  const metafileQuery = url.searchParams.has("metafile") ||
    url.pathname === "/metafile";
  const fileQuery = url.searchParams.has("file") || url.pathname === "/file";

  const badgeQuery = url.searchParams.has("badge") || ["/badge", "/badge/raster", "/badge-raster"].includes(url.pathname);
  const warningsQuery = url.searchParams.has("warnings") ||
    url.searchParams.has("warning") || ["/warnings"].includes(url.pathname);

  const rawQuery = url.searchParams.has("raw") || url.pathname === "/raw";

  const badgeResult = url.searchParams.get("badge");
  const badgeStyle = url.searchParams.get("badge-style");

  const badgeRasterQuery = url.searchParams.has("badge-raster") || url.searchParams.has("png") || ["/badge/raster", "/badge-raster"].includes(url.pathname);
  const query = (
    url.searchParams.get("q") ||
    url.searchParams.get("query")
  ) || "spring-easing";

  if (badgeQuery) {
    const { size } = value;
    const uncompressedBadge = /uncompress/.exec(badgeResult ?? "");
    const minifiedBadge = /minify|minified/.exec(badgeResult ?? "");
    const detailedBadge = /detail/.exec(badgeResult ?? "");

    const urlQuery = encodeURIComponent(`https://bundlejs.com/${url.search}`);
    const detailBadgeText = sanitizeShieldsIO(
      detailedBadge ? `${size.uncompressedSize} -> ` : ""
    );
    const detailBadgeName = sanitizeShieldsIO(
      `bundlejs${detailedBadge ? ` (${value.modules?.map(([pkgName]) => pkgName)?.join(", ") ?? query})` : ""}`
    );

    let badgeType: CompressionType | "minified" | "uncompressed" | undefined = size.type;
    let badgeBundleSize: string = size.compressedSize;

    if (minifiedBadge) {
      badgeType = "minified";
      badgeBundleSize = size.uncompressedSize;
    } else if (uncompressedBadge) {
      badgeType = "uncompressed";
      badgeBundleSize = size.uncompressedSize;
    }

    const imgUrl = new URL(
      `https://${badgeRasterQuery ? "raster.shields.io" : "img.shields.io"}/badge/${detailBadgeText}${sanitizeShieldsIO(`${badgeBundleSize} (${badgeType})`)}-${detailBadgeName}-blue?link=${urlQuery}`
    );

    if (badgeStyle) {
      imgUrl.searchParams.append("style", badgeStyle);
    }

    dispatchEvent(LOGGER_INFO, imgUrl.href);

    const imgFetch = await fetch(imgUrl);
    if (!imgFetch.ok) {
      return imgFetch;
    }

    const imgShield = badgeRasterQuery ? new Uint8Array(await imgFetch.arrayBuffer()) : await imgFetch.text();
    await putCachedBadge(env, badgeID, {
      body: typeof imgShield === "string" ? imgShield : encodeBase64(imgShield),
      contentType: badgeRasterQuery ? "image/png" : "image/svg+xml",
      encoding: typeof imgShield === "string" ? "text" : "base64"
    });

    return new Response(toBodyInit(imgShield), {
      status: 200,
      headers: [
        ...headers,
        ["Cache-Control", "max-age=30, public"],
        ["Content-Type", badgeRasterQuery ? "image/png" : "image/svg+xml"]
      ]
    });
  }

  if (fileQuery) {
    const fileResult = resultText ?? (artifactKey ? await getBundleArtifactText(env, artifactKey) : null);

    if (fileResult === null || fileResult === undefined) {
      throw new Error("The stored bundle artifact was empty. Please try again later or rebuild the bundle.");
    }

    return new Response(toBodyInit(fileResult), {
      status: 200,
      headers: [
        ...headers,
        ["Cache-Control", `max-age=${noCache ? 30 : 720}, public`],
        ["Content-Type", "text/javascript"]
      ]
    });
  }

  if (analysisQuery && value.metafile) {
    const { analyzeMetafile } = await getEsbuild();
    const verboseAnlysis = analysisResult === "verbose";

    return new Response(
      generateHTMLMessages([
        ansi(
          await analyzeMetafile(value.metafile, {
            color: true,
            verbose: verboseAnlysis
          })
        )
      ]),
      {
        status: 200,
        headers: [
          ...headers,
          ["Cache-Control", `max-age=${noCache ? 30 : 180}, public`],
          ["Content-Type", "text/html"]
        ]
      }
    );
  }

  if (metafileQuery && value.metafile) {
    return new Response(JSON.stringify(value.metafile), {
      status: 200,
      headers: [
        ...headers,
        ["Cache-Control", `max-age=${noCache ? 30 : 180}, public`],
        ["Content-Type", "application/json"]
      ]
    });
  }

  if (warningsQuery) {
    return new Response(generateHTMLMessages(value.warnings ?? ["No warnings for this bundle"]), {
      status: 200,
      headers: [
        ...headers,
        ["Cache-Control", "max-age=30, public"],
        ["Content-Type", "text/html"]
      ]
    });
  }

  if (rawQuery) {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: [
        ...headers,
        ["Cache-Control", "max-age=30, public"],
        ["Content-Type", "application/json"]
      ]
    });
  }

  const { metafile: _metafile, warnings: _warnings, ...usefulInfo } = value;
  const finalResult = Object.assign({}, usefulInfo,
    cached ? {
      time: timeFormatter.format(duration / 1000, "seconds"),
      rawTime: duration
    } : null
  );

  return new Response(JSON.stringify(finalResult), {
    status: 200,
    headers: [
      ...headers,
      ["Cache-Control", "max-age=720, public"],
      ["Content-Type", "application/json"]
    ]
  });
}

export function generateHTMLMessages(msgs: string[]) {
  return [
    `<style>${styleText}</style>`,
    `<pre>${msgs.join("\n")}</pre>`
  ].join("");
}