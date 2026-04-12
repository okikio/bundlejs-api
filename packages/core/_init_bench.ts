/**
 * Comprehensive benchmarks for `init()` / `stop()` lifecycle.
 *
 * ## Why this matters
 *
 * On Deno Deploy (serverless) every request spins up `init()` and tears down
 * with `stop()`.  We need hard numbers on:
 *
 * 1. **Cold-start cost** — how long does `init()` take from a clean state?
 * 2. **Teardown cost** — how long does `stop()` take?
 * 3. **Full request cycle** — `init() → stop()` round-trip latency.
 * 4. **Memory pressure** — heap delta introduced by `init()` and reclaimed by `stop()`.
 * 5. **Repeated cycles** — does performance degrade over many init/stop iterations?
 * 6. **Re-init guard** — cost of calling `init()` when already initialized (no-op path).
 * 7. **Double-stop guard** — cost of calling `stop()` when already stopped (no-op path).
 *
 * ## Running
 *
 * ```sh
 * # Standard run (Deno) — expose-gc lets mitata force GC between iterations
 * deno run -A --v8-flags=--expose-gc core/_init_bench.ts
 *
 * # JSON output for CI / comparison
 * deno run -A --v8-flags=--expose-gc core/_init_bench.ts --json
 * ```
 *
 * @module
 */

import { run, bench, boxplot, summary, do_not_optimize } from "npm:mitata";
import { init, stop } from "@bundle/core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Snapshots the V8 heap.
 *
 * Returns `heapUsed` in bytes (the portion of the heap actually occupied
 * by live objects).  Falls back to `0` when the API is unavailable
 * (e.g. browsers, restricted Deno permissions).
 */
function heapUsedBytes(): number {
  // Deno exposes V8 heap stats via `Deno.memoryUsage()`
  if ("Deno" in globalThis && typeof Deno.memoryUsage === "function") {
    return Deno.memoryUsage().heapUsed;
  }
  // Node exposes it via `process.memoryUsage()`
  // deno-lint-ignore no-explicit-any
  if ("process" in globalThis && typeof (globalThis as any).process?.memoryUsage === "function") {
    // deno-lint-ignore no-explicit-any
    return (globalThis as any).process.memoryUsage().heapUsed;
  }
  return 0;
}

/**
 * Forces a synchronous garbage-collection pass if the runtime exposes `gc()`.
 *
 * Requires `--v8-flags=--expose-gc` (Deno) or `--expose-gc` (Node).
 */
function tryGC(): void {
  // deno-lint-ignore no-explicit-any
  if (typeof (globalThis as any).gc === "function") {
    // deno-lint-ignore no-explicit-any
    (globalThis as any).gc();
  }
}

/**
 * Formats bytes as a human-readable string (e.g. "12.34 MB").
 */
function fmtBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (abs >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// Pre-flight: establish baseline
// ---------------------------------------------------------------------------

// Ensure we start from a clean state
await stop();
tryGC();

const BASELINE_HEAP = heapUsedBytes();
console.log(`\n📐 Baseline heap: ${fmtBytes(BASELINE_HEAP)}\n`);

// ---------------------------------------------------------------------------
// Group 1 — Core lifecycle timings
//
//   boxplot + summary gives both distribution shapes (p50/p75/p99/min/max)
//   *and* relative throughput comparison in a single view.
// ---------------------------------------------------------------------------

boxplot(() => {
  summary(() => {

    // -----------------------------------------------------------------------
    // 1a. Cold init — full initialization path:
    //     WASM module compilation, worker spin-up, context writes.
    //     Each iteration starts from a *clean* state (stop + gc).
    // -----------------------------------------------------------------------
    bench("init() cold start", async function* () {
      await stop();
      tryGC();

      yield async () => {
        const esbuild = await init();
        do_not_optimize(esbuild);
      };
    }).gc("inner");

    // -----------------------------------------------------------------------
    // 1b. Stop — teardown cost when esbuild is already running.
    // -----------------------------------------------------------------------
    bench("stop() teardown", async function* () {
      await init();

      yield async () => {
        await stop();
      };
    }).gc("inner");

    // -----------------------------------------------------------------------
    // 1c. Full serverless cycle — the actual Deno Deploy pattern:
    //     init → (request handling happens here) → stop
    // -----------------------------------------------------------------------
    bench("init() → stop() full cycle", async function* () {
      await stop();
      tryGC();

      yield async () => {
        const esbuild = await init();
        do_not_optimize(esbuild);
        await stop();
      };
    }).gc("inner");

  });
});

// ---------------------------------------------------------------------------
// Group 2 — Guard / no-op paths
//
//   These should be near-zero. If they're not, something is wrong
//   with the early-return guards in init()/stop().
// ---------------------------------------------------------------------------

boxplot(() => {
  summary(() => {

    // init() when already initialized — early-return via `fromContext("initialized")`
    bench("init() already initialized (no-op)", async function* () {
      await init();

      yield async () => {
        const esbuild = await init();
        do_not_optimize(esbuild);
      };
    });

    // stop() when already stopped — early-return via null esbuild check
    bench("stop() already stopped (no-op)", async function* () {
      await stop();

      yield async () => {
        await stop();
      };
    });

  });
});

// ---------------------------------------------------------------------------
// Group 3 — Repeated cycles (detect degradation / amortised cost)
//
//   Runs N init→stop cycles per iteration. Compare per-cycle cost at
//   different batch sizes — if latency grows super-linearly, it signals
//   resource exhaustion or leaked state.
// ---------------------------------------------------------------------------

boxplot(() => {
  // deno-lint-ignore no-explicit-any
  bench("init → stop ×$n sequential cycles", async function* (state: any) {
    const n = state.get("n") as number;
    await stop();
    tryGC();

    yield async () => {
      for (let i = 0; i < n; i++) {
        await init();
        await stop();
      }
    };
  })
    .args("n", [1, 5, 10, 25])
    .gc("inner");
});

// ---------------------------------------------------------------------------
// Group 4 — Memory profiling (explicit heap snapshots)
//
//   mitata measures *time*; memory is measured separately with manual heap
//   snapshots so deltas are clearly attributable.
// ---------------------------------------------------------------------------

console.log("\n───── Memory profiling ─────\n");

// --- 4a. Single init / stop heap delta ---
{
  await stop();
  tryGC();

  const beforeInit = heapUsedBytes();
  await init();
  tryGC(); // collect transient allocations from init bookkeeping
  const afterInit = heapUsedBytes();

  const initDelta = afterInit - beforeInit;

  console.log(`  Heap before init():  ${fmtBytes(beforeInit)}`);
  console.log(`  Heap after  init():  ${fmtBytes(afterInit)}`);
  console.log(`  ⮑ init() added:     ${fmtBytes(initDelta)}`);
  console.log();

  const beforeStop = heapUsedBytes();
  await stop();
  tryGC();
  const afterStop = heapUsedBytes();

  const stopDelta = beforeStop - afterStop;

  console.log(`  Heap before stop():  ${fmtBytes(beforeStop)}`);
  console.log(`  Heap after  stop():  ${fmtBytes(afterStop)}`);
  console.log(`  ⮑ stop() freed:     ${fmtBytes(stopDelta)}`);
  console.log();

  const residual = afterStop - BASELINE_HEAP;
  console.log(`  Residual over baseline: ${fmtBytes(residual)}`);
  console.log();
}

// --- 4b. Repeated-cycle leak detection ---
//
// Run many init→stop cycles and compare ending heap to baseline.
// A growing delta hints at a memory leak.
{
  const CYCLES = 50;

  await stop();
  tryGC();
  const preLoop = heapUsedBytes();

  for (let i = 0; i < CYCLES; i++) {
    await init();
    await stop();
  }

  tryGC();
  const postLoop = heapUsedBytes();
  const drift = postLoop - preLoop;
  const perCycle = drift / CYCLES;

  console.log(`  After ${CYCLES} init→stop cycles:`);
  console.log(`    Heap before: ${fmtBytes(preLoop)}`);
  console.log(`    Heap after:  ${fmtBytes(postLoop)}`);
  console.log(`    Total drift: ${fmtBytes(drift)}`);
  console.log(`    Per cycle:   ${fmtBytes(perCycle)}`);

  if (Math.abs(perCycle) > 512 * 1024) {
    console.warn("\n  ⚠️  Potential memory leak: >512 KB drift per cycle");
  } else {
    console.log("\n  ✅ No significant per-cycle heap drift detected");
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Run all mitata benchmarks
// ---------------------------------------------------------------------------

const isJSON = Deno.args.includes("--json");

await run({
  format: isJSON ? "json" : undefined,
  throw: true,
});

// ---------------------------------------------------------------------------
// Cleanup — leave the process in a clean state
// ---------------------------------------------------------------------------
await stop();
