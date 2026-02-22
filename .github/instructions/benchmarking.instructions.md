---
description: Benchmark quality standards for this repo
applyTo: "**/*bench*.ts,**/*_bench.ts"
---

# Benchmarking Rules

This project uses [mitata](https://github.com/nicolo-ribaudo/mitata) for
benchmarks. The rules below prevent the most common measurement errors in
JavaScript benchmarks.

## Non-negotiable: always call `do_not_optimize()`

The JIT compiler (V8) can detect that a computation's result is unused and
eliminate the entire call, measuring an empty loop instead of your code.
`do_not_optimize()` forces the result to be "consumed" without actually using
it.

**Every benchmark callback must wrap its return value:**

```ts
import { bench, do_not_optimize } from "npm:mitata";

bench("init cold start", () => {
  do_not_optimize(init());
});
```

Omitting `do_not_optimize()` is the single most common cause of misleadingly
fast benchmark numbers. Treat any benchmark missing it as broken.

## Prevent constant folding with computed parameters

The JIT can prove that inputs are always the same and cache the entire result,
hoisting it out of the loop (LICM — Loop Invariant Code Motion). Use mitata's
computed parameter syntax to generate fresh input values outside the measured
region:

```ts
bench("build with varying config", function* () {
  const config = yield {
    [0]() {
      return createBuildConfig({ minify: Math.random() > 0.5 });
    },
  };

  bench(config, (c) => {
    do_not_optimize(build(c));
  });
});
```

Use computed parameters for any benchmark where inputs could be constant-folded.

## Control GC for allocation-heavy benchmarks

String and buffer allocation benchmarks produce unpredictable p99 numbers
because random GC pauses inflate outliers. Use `.gc('inner')` to run GC before
each iteration:

```ts
bench("compress 100KB payload", () => {
  do_not_optimize(compress(largePayload));
}).gc("inner");
```

**Rule of thumb:** any benchmark that allocates more than ~10 KB per iteration
should use `.gc('inner')`.

## Running benchmarks

```sh
# Standard run — expose-gc lets mitata force GC between iterations
deno run -A --v8-flags=--expose-gc <bench-file>.ts

# JSON output for CI / comparison
deno run -A --v8-flags=--expose-gc <bench-file>.ts --json
```

## Benchmark realistic scenarios

Microbenchmarks with degenerate inputs don't represent real usage. Include at
least one benchmark for each real-world pattern relevant to the module:

- **Cold-start cost** — single invocation from clean state (cache cold)
- **Warm path** — repeated invocations with caching active
- **Pathological input** — deeply nested exports, very large tarballs, etc.

## Anti-patterns

- **Discarding return values** — always `do_not_optimize()` the result.
- **Same literal in every iteration** — use computed parameters to prevent LICM.
- **Benchmarking only the happy path** — include at least one pathological input
  alongside common inputs.
- **No baseline** — performance claims need a comparison point (previous run,
  alternative implementation, or expected budget).
