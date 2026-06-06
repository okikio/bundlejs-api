import type { Redis } from "@upstash/redis";
import type { CompressionType } from "@bundle/compress";
import type { BundleResult } from "./bundle.ts";

import { encodeBase64 } from "@std/encoding/base64";

import { ansi } from "@bundle/utils";

import { LOGGER_INFO, dispatchEvent, getEsbuild } from "@bundle/core";
import { getFile } from "./gist.ts";
import { headers } from "./constants.ts";
import styleText from "./style.ts";;
import { docs } from "./docs.ts";

export const timeFormatter = new Intl.RelativeTimeFormat("en", {
  style: "narrow",
  numeric: "auto",
})

function sanitizeShieldsIO(str: string) {
  return str
    .replace(/\-/g, "--")
    .replace(/\_/g, "__")
    .replace(/\s/g, "_");
}

export async function generateResult([badgeKey, badgeID]: string[], [value, resultText]: [BundleResult, string | undefined], url: URL, cached: boolean, duration: number, redis?: Redis | null) {
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
      `bundlejs${detailedBadge ? ` (${value.modules?.map(([p]) => p)?.join(", ") ?? query})` : ""}`
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

    if (badgeStyle) { imgUrl.searchParams.append("style", badgeStyle); }
    dispatchEvent(LOGGER_INFO, imgUrl.href)

    const imgFetch = await fetch(imgUrl);
    if (!imgFetch.ok) return imgFetch;

    const imgShield = badgeRasterQuery ? new Uint8Array(await imgFetch.arrayBuffer()) : await imgFetch.text();

    try {
      if (!redis) throw new Error("Redis not available");
      await redis.hset<string>(badgeKey, {
        [badgeID]: typeof imgShield === "string" ? imgShield : encodeBase64(imgShield)
      })
    } catch (e) {
      console.warn(e);
    }

    return new Response(imgShield, {
      status: 200,
      headers: [
        ...headers,
        ['Cache-Control', `max-age=${30}, public`],
        ['Content-Type', badgeRasterQuery ? "image/png" : 'image/svg+xml']
      ],
    })
  }

  if (fileQuery) {
    const { fileId } = value;
    const fileResult = fileId ? await getFile(fileId) : resultText ?? " ";
    if (!fileId && !resultText) {
      throw new Error("The fileId was empty 🤔, hmm...maybe try again later, if this error persists please create an issue on https://github.com/okikio/bundlejs.")
    }

    if (fileResult === undefined) {
      throw new Error("Whoops we can't quite find the file you're looking for, please create an issue on https://github.com/okikio/bundlejs.")
    }

    return new Response(fileResult, {
      status: 200,
      headers: [
        ...headers,
        ['Cache-Control', `max-age=${noCache ? 30 : 720}, public`],
        ['Content-Type', 'text/javascript']
      ],
    })
  }

  if (analysisQuery && value.metafile) {
    const { analyzeMetafile } = await getEsbuild();
    const verboseAnlysis = analysisResult === "verbose";

    return new Response(
      generateHTMLMessages([
        ansi(
          (
            await analyzeMetafile(value.metafile, {
              color: true,
              verbose: verboseAnlysis
            })
          )
        )
      ]),
      {
        status: 200,
        headers: [
          ...headers,
          ['Cache-Control', `max-age=${noCache ? 30 : 180}, public`],
          ['Content-Type', 'text/html']
        ],
      }
    )
  }

  if (metafileQuery && value.metafile) {
    return new Response(JSON.stringify(value.metafile), {
      status: 200,
      headers: [
        ...headers,
        ['Cache-Control', `max-age=${noCache ? 30 : 180}, public`],
        ['Content-Type', 'application/json']
      ],
    })
  }

  if (warningsQuery) {
    return new Response(generateHTMLMessages(value.warnings ?? ["No warnings for this bundle"]),
      {
        status: 200,
        headers: [
          ...headers,
          ['Cache-Control', `max-age=30, public`],
          ['Content-Type', 'text/html']
        ]
      }
    )
  }

  if (rawQuery) {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: [
        ...headers,
        ['Cache-Control', `max-age=30, public`],
        ['Content-Type', 'application/json']
      ],
    });
  }

  const { metafile: _metafile, warnings: _warnings, ...usefulInfo } = value;
  const addDocs = (url.search === "" ? docs : "");
  const finalResult = Object.assign({}, usefulInfo, addDocs,
    cached ? {
      time: timeFormatter.format(duration / 1000, "seconds"),
      rawTime: duration
    } : null
  );

  return new Response(JSON.stringify(finalResult), {
    status: 200,
    headers: [
      ...headers,
      ['Cache-Control', 'max-age=720, public'],
      ['Content-Type', 'application/json']
    ],
  })
}

export function generateHTMLMessages(msgs: string[]) {
  return [
    `<style>${styleText}</style>`,
    `<pre>${msgs.join("\n")}</pre>`
  ].join("");
}