/**
 * Race-condition benchmark for concurrent `init()` calls.
 *
 * ## Background
 *
 * Before the fix, multiple concurrent requests could all see
 * `fromContext("initialized") === false` and each independently call
 * `esbuild.initialize()`. esbuild only allows this once, so callers 2–N
 * would fail with:
 *
 *   "Cannot call 'initialize' more than once"
 *
 * That error set `esbuild = null`, causing downstream callers to get:
 *
 *   "Initialization failed, couldn't access esbuild.build(...) function"
 *
 * ## What this benchmark does
 *
 * 1. **Reproduces the old bug** — a `naiveInit()` function that mimics the
 *    old `init()` (no singleton-promise guard). Fires N concurrent calls
 *    and records how many fail.
 *
 * 2. **Validates the fix** — fires the same N concurrent calls through the
 *    real `init()` (with `Promise.withResolvers` + context guard) and
 *    confirms zero failures.
 *
 * 3. **Benchmarks concurrent init()** at various concurrency levels (2, 5,
 *    10, 25) to measure throughput and verify correctness under load.
 *
 * 4. **Simulates the full server scenario** — concurrent `build()` calls
 *    from a cold state, matching the Deno Deploy pattern where many
 *    requests arrive before the first init completes.
 *
 * ## Running
 *
 * ```sh
 * deno run -A --v8-flags=--expose-gc core/_race_bench.ts
 * ```
 *
 * @module
 */

import { run, bench, boxplot, summary, do_not_optimize } from "npm:mitata";

import { init, stop } from "@bundle/core";
import { Context, fromContext, toContext } from "@bundle/core";
import { defaultVersion, getEsbuild, getEsbuildVersion } from "./utils/get-esbuild.ts";
import { PLATFORM_AUTO } from "./configs/platform.ts";

// We import build for the end-to-end server-simulation tests.
// Using dynamic import so the module-level TheFileSystem doesn't
// delay script start when esbuild isn't initialized yet.
const { build } = await import("@bundle/core");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryGC(): void {
  // deno-lint-ignore no-explicit-any
  if (typeof (globalThis as any).gc === "function") {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).gc();
  }
}

interface RaceTestResult {
  total: number;
  successes: number;
  failures: number;
  errors: string[];
  /** Time in ms for all concurrent calls to settle */
  elapsedMs: number;
}

/**
 * Runs `count` concurrent calls to `initFn` and tallies results.
 */
async function raceConcurrentInit(
  initFn: () => Promise<unknown>,
  count: number,
): Promise<RaceTestResult> {
  const errors: string[] = [];
  let successes = 0;
  let failures = 0;

  const t0 = performance.now();
  const results = await Promise.allSettled(
    Array.from({ length: count }, () =>
      initFn().then((esbuild) => {
        if (esbuild && typeof (esbuild as Record<string, unknown>).build === "function") {
          successes++;
        } else {
          failures++;
          errors.push("init() returned null/undefined or missing .build()");
        }
      })
    ),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      failures++;
      errors.push(String(r.reason));
    }
  }

  const elapsedMs = performance.now() - t0;
  return { total: count, successes, failures, errors, elapsedMs };
}

// ---------------------------------------------------------------------------
// "Old" init — reproduces the race condition
//
// This is a faithful copy of the pre-fix init() logic: it checks
// `fromContext("initialized")` but has NO singleton promise guard,
// so concurrent callers all race into `esbuild.initialize()`.
// ---------------------------------------------------------------------------

async function naiveInit() {
  try {
    if (!fromContext("initialized")) {
      const version = await getEsbuildVersion(defaultVersion);
      const esbuild = await getEsbuild(PLATFORM_AUTO, version);
      toContext("esbuild", Context.opaque(esbuild));

      // In WASM mode (non-node, non-deno) this would call
      // esbuild.initialize() — that's the call that explodes when
      // concurrent. For Deno-native mode the race still corrupts
      // context state because multiple callers overwrite esbuild/
      // initialized in interleaving order.
      //
      // We replicate the WASM path since that's where the crash was:
      const { default: ESBUILD_WASM } = await import("./wasm.ts");
      await esbuild.initialize({
        wasmModule: new WebAssembly.Module(await ESBUILD_WASM() as BufferSource),
      });

      toContext("initialized", true);
    }
    return fromContext("esbuild");
  } catch (e) {
    console.error("naiveInit error:", (e as Error).message);
    toContext("initialized", false);
    toContext("esbuild", null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 0: helpers
// ---------------------------------------------------------------------------

function printResult(label: string, result: RaceTestResult) {
  const status = result.failures === 0 ? "✅ PASS" : "❌ FAIL";
  console.log(`  ${status}  ${label}`);
  console.log(`         Total: ${result.total}  Successes: ${result.successes}  Failures: ${result.failures}  (${result.elapsedMs.toFixed(1)} ms)`);
  if (result.errors.length > 0) {
    const unique = [...new Set(result.errors)];
    for (const e of unique.slice(0, 5)) {
      console.log(`         ⮑ ${e}`);
    }
    if (unique.length > 5) {
      console.log(`         … and ${unique.length - 5} more unique errors`);
    }
  }
}

// ===========================================================================
//  SECTION 1 — Correctness: reproduce old bug vs. verify fix
// ===========================================================================

console.log("\n═══════════════════════════════════════════════════════════════");
console.log("  Section 1: Reproduce old race vs. verify fix (correctness)");
console.log("═══════════════════════════════════════════════════════════════\n");

const concurrencyLevels = [2, 5, 10, 25];

// ---- 1a. Old (naive) init — expect failures ----
console.log("── 1a. naiveInit() — OLD behavior (no singleton guard) ──\n");

for (const n of concurrencyLevels) {
  await stop();
  tryGC();

  const result = await raceConcurrentInit(() => naiveInit(), n);
  printResult(`naiveInit() ×${n} concurrent`, result);
  console.log();
}

// ---- 1b. Fixed init — expect zero failures ----
console.log("── 1b. init() — FIXED behavior (Promise.withResolvers + context) ──\n");

for (const n of concurrencyLevels) {
  await stop();
  tryGC();

  const result = await raceConcurrentInit(() => init(), n);
  printResult(`init() ×${n} concurrent`, result);

  if (result.failures > 0) {
    console.error("\n  🚨 REGRESSION: fixed init() should have ZERO failures!\n");
  }
  console.log();
}

// ===========================================================================
//  SECTION 2 — Correctness: concurrent build() from cold state
//
//  This is the actual Deno Deploy scenario: several HTTP requests arrive
//  simultaneously when the worker just started, each calling build() which
//  internally calls init().
// ===========================================================================

console.log("═══════════════════════════════════════════════════════════════");
console.log("  Section 2: Concurrent build() from cold state (server sim)");
console.log("═══════════════════════════════════════════════════════════════\n");

for (const n of [2, 5, 10]) {
  await stop();
  tryGC();

  let successes = 0;
  let failures = 0;
  const errors: string[] = [];
  const t0 = performance.now();

  const results = await Promise.allSettled(
    Array.from({ length: n }, () =>
      build({
        entryPoints: [],
        esbuild: {
          stdin: {
            contents: `export const x = 1;`,
            loader: "ts",
          },
        },
      }).then((r) => {
        if (r?.contents?.length > 0) {
          successes++;
        } else {
          failures++;
          errors.push("build() returned empty contents");
        }
      })
    ),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      failures++;
      errors.push(String(r.reason));
    }
  }

  const elapsedMs = performance.now() - t0;
  const status = failures === 0 ? "✅ PASS" : "❌ FAIL";

  console.log(`  ${status}  build() ×${n} concurrent from cold start`);
  console.log(`         Successes: ${successes}  Failures: ${failures}  (${elapsedMs.toFixed(1)} ms)`);
  if (errors.length > 0) {
    for (const e of [...new Set(errors)].slice(0, 5)) {
      console.log(`         ⮑ ${e}`);
    }
  }
  console.log();
}

// ===========================================================================
//  SECTION 3 — Correctness: interleaved init/stop under concurrency
//
//  Stress test: some callers init(), others stop(), all at once.
//  The system should never throw and should always leave context in
//  a usable state (either fully initialized or cleanly stopped).
// ===========================================================================

console.log("═══════════════════════════════════════════════════════════════");
console.log("  Section 3: Interleaved init() + stop() stress test");
console.log("═══════════════════════════════════════════════════════════════\n");

{
  const ROUNDS = 10;
  const CONCURRENCY = 10;
  let totalErrors = 0;

  for (let round = 0; round < ROUNDS; round++) {
    // Random mix: ~70% init, ~30% stop
    const tasks = Array.from({ length: CONCURRENCY }, (_, i) =>
      i % 3 === 0
        ? stop().catch((e: Error) => { totalErrors++; console.error("  stop() threw:", e.message); })
        : init().catch((e: Error) => { totalErrors++; console.error("  init() threw:", e.message); })
    );
    await Promise.allSettled(tasks);
  }

  // After chaos, verify we can still do a clean init → build → stop cycle
  await stop();
  tryGC();

  const esbuild = await init();
  const canBuild = esbuild && typeof (esbuild as Record<string, unknown>).build === "function";
  await stop();

  const status = totalErrors === 0 && canBuild ? "✅ PASS" : "❌ FAIL";
  console.log(`  ${status}  ${ROUNDS} rounds × ${CONCURRENCY} interleaved calls`);
  console.log(`         Errors during chaos: ${totalErrors}`);
  console.log(`         Recovery build:      ${canBuild ? "OK" : "FAILED"}`);
  console.log();
}

// ===========================================================================
//  SECTION 4 — Performance benchmarks (mitata)
//
//  Now that correctness is established, measure throughput of concurrent
//  init() at various concurrency levels.
// ===========================================================================

console.log("═══════════════════════════════════════════════════════════════");
console.log("  Section 4: Performance benchmarks (mitata)");
console.log("═══════════════════════════════════════════════════════════════\n");

boxplot(() => {
  summary(() => {

    // -----------------------------------------------------------------------
    // 4a. Concurrent init() — fixed version
    //     All N callers fire simultaneously from a cold state.
    //     Only the first does real work; the rest join the in-flight promise.
    // -----------------------------------------------------------------------
    // deno-lint-ignore no-explicit-any
    bench("init() ×$n concurrent (fixed)", async function* (state: any) {
      const n = state.get("n") as number;
      await stop();
      tryGC();

      yield async () => {
        const results = await Promise.all(
          Array.from({ length: n }, () => init()),
        );
        do_not_optimize(results);
      };
    })
      .args("n", [2, 5, 10, 25])
      .gc("inner");

    // -----------------------------------------------------------------------
    // 4b. Concurrent init() already initialized (no-op fast path)
    //     Measures contention on the `fromContext("initialized")` check.
    // -----------------------------------------------------------------------
    // deno-lint-ignore no-explicit-any
    bench("init() ×$n concurrent (already init'd)", async function* (state: any) {
      const n = state.get("n") as number;
      await init(); // ensure initialized

      yield async () => {
        const results = await Promise.all(
          Array.from({ length: n }, () => init()),
        );
        do_not_optimize(results);
      };
    })
      .args("n", [2, 5, 10, 25])
      .gc("inner");

    // -----------------------------------------------------------------------
    // 4c. Sequential cold init baseline (for comparison)
    // -----------------------------------------------------------------------
    bench("init() cold start (sequential baseline)", async function* () {
      await stop();
      tryGC();

      yield async () => {
        const esbuild = await init();
        do_not_optimize(esbuild);
      };
    }).gc("inner");

  });
});

// ---------------------------------------------------------------------------
// Run all mitata benchmarks
// ---------------------------------------------------------------------------

const isJSON = Deno.args.includes("--json");

await run({
  format: isJSON ? "json" : undefined,
  throw: true,
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
await stop();

console.log("\n🏁 Race-condition benchmark complete.\n");
