# Scenario 21 — Concurrent Initialization Race Condition

> Tests that concurrent `init()` and `build()` calls from a cold state never trigger esbuild's "Cannot call 'initialize' more than once" error, never leave the system in a broken state, and always recover after teardown.

## Problem

On Deno Deploy (serverless), multiple HTTP requests can arrive simultaneously before esbuild has been initialized. Each request calls `build()`, which internally calls `init()`. Before the fix, this caused a race condition:

1. Request A checks `fromContext("initialized")` → `false` → begins initialization
2. Request B checks `fromContext("initialized")` → `false` → also begins initialization
3. Request A calls `esbuild.initialize()` → succeeds
4. Request B calls `esbuild.initialize()` → **crashes**: "Cannot call 'initialize' more than once"
5. Request B's error handler sets `esbuild = null`, `initialized = false`
6. Request B (and any subsequent requests) fails with: "Initialization failed, couldn't access esbuild.build(...) function"

This is a classic **check-then-act** race on an async resource that only allows single initialization.

## Root Cause

The original `init()` used a simple boolean guard:

```ts
// OLD — vulnerable to race condition
async function init() {
  if (!fromContext("initialized")) {   // ← multiple callers pass this check
    await esbuild.initialize();        // ← only the first succeeds
    toContext("initialized", true);
  }
  return fromContext("esbuild");
}
```

Between the check (`!fromContext("initialized")`) and the side-effect (`esbuild.initialize()`), other callers could enter the same code path because `await` yields control back to the event loop.

## Fix

Store an in-flight initialization promise in `GlobalContext` using `Promise.withResolvers()`:

```ts
// FIXED — singleton promise via context
async function init() {
  if (fromContext("initialized")) return fromContext("esbuild");

  const inflight = fromContext("initPromise");
  if (inflight) return inflight;                    // ← join existing init

  const { promise, resolve } = Promise.withResolvers();
  toContext("initPromise", promise);                // ← stored synchronously, before any await

  try {
    await esbuild.initialize();
    toContext("initialized", true);
    resolve(fromContext("esbuild"));
    return fromContext("esbuild");
  } catch (e) {
    resolve(null);
  } finally {
    toContext("initPromise", null);                 // ← cleared when settled
  }
}
```

Key properties:
- **`Promise.withResolvers()`** lets us store the promise in context *synchronously* before the first `await`, so no concurrent caller can slip past.
- **`GlobalContext`** is the single source of truth — no module-level variables outside the context system.
- **`finally`** always clears `initPromise`, so `stop()` → `init()` cycles start fresh.
- **`stop()`** also clears `initPromise` to prevent a dangling in-flight init from overwriting the torn-down state.

## Scenarios

### 21.1 — Concurrent `init()` from cold state

**What it tests:** N simultaneous `init()` calls from a stopped state all succeed and return the same esbuild instance.

| Concurrency | Expected |
|------------|----------|
| 2 | All succeed, same instance |
| 5 | All succeed, same instance |
| 10 | All succeed, same instance |
| 25 | All succeed, same instance |

**Regression signal:** If any caller gets `null` or a different instance, the singleton promise guard is broken.


### 21.2 — Concurrent `build()` from cold state (server simulation)

**What it tests:** The actual Deno Deploy scenario — N `build()` calls arrive simultaneously when the worker just started. Each internally calls `init()`.

| Concurrency | Expected |
|------------|----------|
| 2 | All produce valid output, zero errors |
| 5 | All produce valid output, zero errors |
| 10 | All produce valid output, zero errors |

**Regression signal:** If any build fails with "Initialization failed, couldn't access esbuild.build(...) function", concurrent init protection is broken.


### 21.3 — Interleaved `init()`/`stop()` stress test

**What it tests:** Random mix of concurrent `init()` and `stop()` calls (~70% init, ~30% stop) over multiple rounds. The system should never throw and should always recover to a usable state afterward.

- 5 rounds × 8 concurrent calls
- After chaos: `stop()` → `init()` → verify `build()` works

**Regression signal:** If any call throws, or if the recovery build fails, the init/stop lifecycle has a state corruption bug.


### 21.4 — Re-init after `stop()`

**What it tests:** After a full `init()` → `stop()` cycle, concurrent `init()` callers can reinitialize cleanly. Also tests multiple `stop()` → concurrent `init()` cycles in sequence.

**Regression signal:** If re-initialization fails after `stop()`, the cleanup isn't properly resetting all state (e.g. `initPromise` is still set, or `initialized` isn't `false`).


### 21.5 — `initPromise` context lifecycle

**What it tests:** The `initPromise` field in `GlobalContext` follows the expected lifecycle:

| State | `initPromise` |
|-------|--------------|
| Not initializing | `null` |
| During init (in-flight) | A `Promise` |
| After successful init | `null` |
| After `stop()` | `null` |

**Regression signal:** If `initPromise` is non-null when it shouldn't be, concurrent callers may incorrectly join a stale promise. If it's `null` when it should be set, concurrent callers will race.


## Error Messages This Prevents

Before the fix, users would see these at random under concurrent load:

```
Error: Cannot call "initialize" more than once
    at Module.initialize (esbuild/wasm.js)
    at init (core/init.ts)
```

```
Error: Initialization failed, couldn't access esbuild.build(...) function
    at build (core/build.ts)
```

After the fix, neither error should ever occur regardless of concurrency level.
