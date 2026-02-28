/**
 * Scenario 21 — Concurrent Initialization Race Condition
 *
 * Tests that concurrent `init()` and `build()` calls from a cold state
 * never trigger esbuild's "Cannot call 'initialize' more than once" error
 * and never leave the system in a broken state.
 *
 * ## Coverage Map
 *
 * | Section | Scenario |
 * |---------|----------|
 * | 21.1 — Concurrent init() | Multiple simultaneous init() calls from cold state |
 * | 21.2 — Concurrent build() cold start | Server-simulation: N builds before init completes |
 * | 21.3 — Interleaved init/stop stress | Random mix of init() and stop() under concurrency |
 * | 21.4 — Re-init after stop | Clean recovery: stop() → concurrent init() |
 * | 21.5 — initPromise context lifecycle | Context field is set during init and cleared after |
 *
 * @see docs/scenarios/21-concurrent-init-race.md
 * @module
 */

import { describe, test, afterAll } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { init, stop } from "@bundle/core";
import { fromContext } from "@bundle/core";

import { buildWithEntry } from "./helpers.ts";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Fires `count` concurrent init() calls and returns per-call results.
 */
async function concurrentInit(count: number) {
  const results = await Promise.allSettled(
    Array.from({ length: count }, () => init()),
  );
  return results;
}

/**
 * Asserts every result in the settled array is fulfilled with a
 * non-null esbuild instance that has a `.build()` method.
 */
function expectAllInitialized(
  results: PromiseSettledResult<unknown>[],
) {
  for (const r of results) {
    expect(r.status).toBe("fulfilled");
    if (r.status === "fulfilled") {
      // Don't pass the esbuild module namespace to expect() directly —
      // it can't be converted to a primitive for error formatting.
      expect(r.value != null).toBe(true);
      expect(typeof (r.value as Record<string, unknown>).build).toBe(
        "function",
      );
    }
  }
}

// =============================================================================
// 21.1 — Concurrent init() from cold state
// =============================================================================

describe("21 · Concurrent Initialization Race Condition", () => {
  afterAll(async () => {
    await stop();
  });

  describe("21.1 — Concurrent init() from cold state", () => {
    test("2 concurrent init() calls both succeed", async () => {
      await stop();
      const results = await concurrentInit(2);
      expectAllInitialized(results);
    });

    test("5 concurrent init() calls all succeed", async () => {
      await stop();
      const results = await concurrentInit(5);
      expectAllInitialized(results);
    });

    test("10 concurrent init() calls all succeed", async () => {
      await stop();
      const results = await concurrentInit(10);
      expectAllInitialized(results);
    });

    test("25 concurrent init() calls all succeed", async () => {
      await stop();
      const results = await concurrentInit(25);
      expectAllInitialized(results);
    });

    test("all concurrent callers receive the same esbuild instance", async () => {
      await stop();
      const results = await concurrentInit(5);
      const values: unknown[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") {
          values.push(r.value);
        }
      }

      expect(values.length).toBe(5);

      // Every caller should get the exact same object reference
      for (const v of values) {
        expect(v).toBe(values[0]);
      }
    });
  });

  // ===========================================================================
  // 21.2 — Concurrent build() from cold state (server simulation)
  // ===========================================================================

  describe("21.2 — Concurrent build() from cold state", () => {
    test("2 concurrent builds from cold state all produce output", async () => {
      await stop();
      const results = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          buildWithEntry(`export const x = 1;`),
        ),
      );

      for (const r of results) {
        expect(r.status).toBe("fulfilled");
        if (r.status === "fulfilled") {
          expect(r.value.contents.length).toBeGreaterThan(0);
          expect(r.value.errors.length).toBe(0);
        }
      }
    });

    test("5 concurrent builds from cold state all produce output", async () => {
      await stop();
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          buildWithEntry(`export const y = 2;`),
        ),
      );

      for (const r of results) {
        expect(r.status).toBe("fulfilled");
        if (r.status === "fulfilled") {
          expect(r.value.contents.length).toBeGreaterThan(0);
          expect(r.value.errors.length).toBe(0);
        }
      }
    });

    test("10 concurrent builds from cold state all produce output", async () => {
      await stop();
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          buildWithEntry(`export const z = 3;`),
        ),
      );

      for (const r of results) {
        expect(r.status).toBe("fulfilled");
        if (r.status === "fulfilled") {
          expect(r.value.contents.length).toBeGreaterThan(0);
          expect(r.value.errors.length).toBe(0);
        }
      }
    });
  });

  // ===========================================================================
  // 21.3 — Interleaved init/stop stress test
  // ===========================================================================

  describe("21.3 — Interleaved init/stop stress test", () => {
    test("mixed init/stop calls never throw", async () => {
      const ROUNDS = 5;
      const CONCURRENCY = 8;
      const errors: string[] = [];

      for (let round = 0; round < ROUNDS; round++) {
        // ~70% init, ~30% stop
        const tasks = Array.from({ length: CONCURRENCY }, (_, i) =>
          i % 3 === 0
            ? stop().catch((e: Error) => { errors.push(`stop: ${e.message}`); })
            : init().catch((e: Error) => { errors.push(`init: ${e.message}`); }),
        );
        await Promise.allSettled(tasks);
      }

      expect(errors).toEqual([]);
    });

    test("system recovers after interleaved chaos", async () => {
      // Run some chaotic interleaving
      const tasks = Array.from({ length: 10 }, (_, i) =>
        i % 3 === 0 ? stop() : init(),
      );
      await Promise.allSettled(tasks);

      // Now verify clean recovery
      await stop();
      const esbuild = await init();
      expect(esbuild != null).toBe(true);
      expect(typeof (esbuild as Record<string, unknown>).build).toBe("function");

      // Verify a full build works
      await using result = await buildWithEntry(`export const recovered = true;`);
      expect(result.contents.length).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });

  // ===========================================================================
  // 21.4 — Re-init after stop
  // ===========================================================================

  describe("21.4 — Re-init after stop", () => {
    test("concurrent init() after stop() all succeed", async () => {
      // Initialize, then fully stop
      await init();
      await stop();

      // Now race N callers from the freshly-stopped state
      const results = await concurrentInit(10);
      expectAllInitialized(results);
    });

    test("multiple stop→init cycles with concurrency", async () => {
      for (let cycle = 0; cycle < 3; cycle++) {
        await stop();
        const results = await concurrentInit(5);
        expectAllInitialized(results);
      }
    });
  });

  // ===========================================================================
  // 21.5 — initPromise context lifecycle
  // ===========================================================================

  describe("21.5 — initPromise context lifecycle", () => {
    test("initPromise is null when not initializing", async () => {
      await stop();
      expect(fromContext("initPromise")).toBeNull();
    });

    test("initPromise is null after successful init", async () => {
      await stop();
      await init();
      expect(fromContext("initPromise")).toBeNull();
    });

    test("initPromise is set during init and cleared after", async () => {
      await stop();

      // Fire init but also immediately check the context
      const initPromise = init();

      // The promise should be stored in context while in-flight
      // (it was set synchronously via Promise.withResolvers before
      // the first await in init)
      const inflight = fromContext("initPromise");
      expect(inflight).not.toBeNull();

      // Wait for init to complete
      await initPromise;

      // After completion, it should be cleared
      expect(fromContext("initPromise")).toBeNull();
    });

    test("stop() clears initPromise", async () => {
      await stop();
      expect(fromContext("initPromise")).toBeNull();

      // Start init, then immediately stop
      const p = init();
      await stop();
      expect(fromContext("initPromise")).toBeNull();

      // Wait for the original init promise to settle
      // (it may resolve with null since stop() cleared state)
      await p;
    });
  });
});

