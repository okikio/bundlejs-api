---
description: Core bundle engine rules
applyTo: "core/**"
---

# Core Bundle Engine (core/**)

The core module wraps esbuild (WASM) for browser/edge bundling and uses a plugin chain.

## Context system

- Plugins share state via `Context`.
- Use `Context.opaque(...)` for complex objects that shouldn’t be deeply merged or serialized.
- Prefer explicit reads/writes via `fromContext(...)` / `toContext(...)` patterns.

## Plugin factory pattern

- Plugins should be factories that receive the context and return an esbuild plugin.
- Distinguish:
  - setup-time initialization (once)
  - build hooks (onResolve/onLoad/etc.)

## Plugin chain (order matters)

Alias → External → FS/VFS → Tarball → HTTP → CDN

When adding/modifying a plugin:
- state what phase it belongs to
- state what it consumes/produces (inputs/outputs)
- note edge cases (redirects, integrity, caching, path normalization)

## Observability

- Emit meaningful events for build lifecycle and errors.
- Include enough context to diagnose issues without leaking secrets.
