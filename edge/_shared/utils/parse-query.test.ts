/**
 * V4 Spec v1 test suite for parse-query.
 *
 * Run with: deno test parse-query.test.ts
 */

import {
  parseEmitItem,
  parseBracket,
  splitTreeshake,
  buildInputCode,
  getModuleName,
  DEFAULT_BASE,
} from './parse-query.ts'
import { assertEquals } from 'jsr:@std/assert'

// =============================================================================
// parseEmitItem — clause forms
// =============================================================================

Deno.test('clause: bare', () => {
  assertEquals(parseEmitItem('bare').specifier, { kind: 'bare' })
})

Deno.test('clause: auto', () => {
  assertEquals(parseEmitItem('auto').specifier, { kind: 'auto' })
})

Deno.test('clause: *', () => {
  assertEquals(parseEmitItem('*').specifier, { kind: 'star' })
})

Deno.test('clause: * as X', () => {
  assertEquals(parseEmitItem('* as X').specifier, { kind: 'namespace', name: 'X' })
})

Deno.test('clause: { a, b }', () => {
  assertEquals(parseEmitItem('{ a, b }').specifier, { kind: 'named', names: 'a, b' })
})

Deno.test('clause: { type Config }', () => {
  assertEquals(parseEmitItem('{ type Config }').specifier, { kind: 'named', names: 'type Config' })
})

Deno.test('clause: default', () => {
  assertEquals(parseEmitItem('default').specifier, { kind: 'default-surface', name: null })
})

Deno.test('clause: default as React', () => {
  assertEquals(parseEmitItem('default as React').specifier, { kind: 'default-surface', name: 'React' })
})

Deno.test('clause: React (identifier)', () => {
  assertEquals(parseEmitItem('React').specifier, { kind: 'identifier', name: 'React' })
})

Deno.test('clause: id:defer (escape hatch)', () => {
  const result = parseEmitItem('id:defer')
  assertEquals(result.phase, null)
  assertEquals(result.specifier, { kind: 'identifier', name: 'defer' })
})

Deno.test('clause: id:bare (escape hatch)', () => {
  const result = parseEmitItem('id:bare')
  assertEquals(result.phase, null)
  assertEquals(result.specifier, { kind: 'identifier', name: 'bare' })
})

Deno.test('clause: id:type (escape hatch)', () => {
  const result = parseEmitItem('id:type')
  assertEquals(result.phase, null)
  assertEquals(result.specifier, { kind: 'identifier', name: 'type' })
})

Deno.test('clause: empty → auto', () => {
  assertEquals(parseEmitItem('').specifier, { kind: 'auto' })
})

// =============================================================================
// parseEmitItem — defer phase
// =============================================================================

Deno.test('defer: * as X', () => {
  const r = parseEmitItem('defer * as X')
  assertEquals(r.phase, 'defer')
  assertEquals(r.specifier, { kind: 'namespace', name: 'X' })
})

Deno.test('defer: auto', () => {
  const r = parseEmitItem('defer auto')
  assertEquals(r.phase, 'defer')
  assertEquals(r.specifier, { kind: 'auto' })
})

Deno.test('defer: *', () => {
  const r = parseEmitItem('defer *')
  assertEquals(r.phase, 'defer')
  assertEquals(r.specifier, { kind: 'star' })
})

// =============================================================================
// parseEmitItem — source phase
// =============================================================================

Deno.test('source: X (space form)', () => {
  const r = parseEmitItem('source X')
  assertEquals(r.phase, 'source')
  assertEquals(r.specifier, { kind: 'identifier', name: 'X' })
})

Deno.test('source: source:Wasm (colon form)', () => {
  const r = parseEmitItem('source:Wasm')
  assertEquals(r.phase, 'source')
  assertEquals(r.specifier, { kind: 'identifier', name: 'Wasm' })
})

Deno.test('source: auto', () => {
  const r = parseEmitItem('source auto')
  assertEquals(r.phase, 'source')
  assertEquals(r.specifier, { kind: 'auto' })
})

// =============================================================================
// parseEmitItem — type phase
// =============================================================================

Deno.test('type: * as X', () => {
  const r = parseEmitItem('type * as X')
  assertEquals(r.phase, 'type')
  assertEquals(r.specifier, { kind: 'namespace', name: 'X' })
})

Deno.test('type: { Config, Theme }', () => {
  const r = parseEmitItem('type { Config, Theme }')
  assertEquals(r.phase, 'type')
  assertEquals(r.specifier, { kind: 'named', names: 'Config, Theme' })
})

Deno.test('type: X (identifier)', () => {
  const r = parseEmitItem('type X')
  assertEquals(r.phase, 'type')
  assertEquals(r.specifier, { kind: 'identifier', name: 'X' })
})

Deno.test('type: auto', () => {
  const r = parseEmitItem('type auto')
  assertEquals(r.phase, 'type')
  assertEquals(r.specifier, { kind: 'auto' })
})

Deno.test('type: default', () => {
  const r = parseEmitItem('type default')
  assertEquals(r.phase, 'type')
  assertEquals(r.specifier, { kind: 'default-surface', name: null })
})

Deno.test('type: *', () => {
  const r = parseEmitItem('type *')
  assertEquals(r.phase, 'type')
  assertEquals(r.specifier, { kind: 'star' })
})

Deno.test('type: default as ReactType', () => {
  const r = parseEmitItem('type default as ReactType')
  assertEquals(r.phase, 'type')
  assertEquals(r.specifier, { kind: 'default-surface', name: 'ReactType' })
})

// =============================================================================
// parseEmitItem — attributes
// =============================================================================

Deno.test('attrs: braced compact {type:json}', () => {
  const r = parseEmitItem('{ parse } with{type:json}')
  assertEquals(r.specifier, { kind: 'named', names: 'parse' })
  assertEquals(r.attributes, { type: 'json' })
})

Deno.test('attrs: braced spaced { type: json }', () => {
  const r = parseEmitItem('{ parse } with { type: json }')
  assertEquals(r.attributes, { type: 'json' })
})

Deno.test('attrs: unbraced type:json', () => {
  const r = parseEmitItem('{ parse } with type:json')
  assertEquals(r.attributes, { type: 'json' })
})

Deno.test('attrs: multiple pairs', () => {
  const r = parseEmitItem('* as S with{type:css, integrity:sha256}')
  assertEquals(r.attributes, { type: 'css', integrity: 'sha256' })
})

Deno.test('attrs: bare with{type:css}', () => {
  const r = parseEmitItem('bare with{type:css}')
  assertEquals(r.specifier, { kind: 'bare' })
  assertEquals(r.attributes, { type: 'css' })
})

Deno.test('attrs: quoted values stripped', () => {
  const r = parseEmitItem('{ data } with{type:"json"}')
  assertEquals(r.attributes, { type: 'json' })
})

// =============================================================================
// parseEmitItem — combined phase + clause + attrs
// =============================================================================

Deno.test('combined: defer * as X with{type:wasm}', () => {
  const r = parseEmitItem('defer * as X with{type:wasm}')
  assertEquals(r.phase, 'defer')
  assertEquals(r.specifier, { kind: 'namespace', name: 'X' })
  assertEquals(r.attributes, { type: 'wasm' })
})

Deno.test('combined: type { Config } with{type:json}', () => {
  const r = parseEmitItem('type { Config } with{type:json}')
  assertEquals(r.phase, 'type')
  assertEquals(r.specifier, { kind: 'named', names: 'Config' })
  assertEquals(r.attributes, { type: 'json' })
})

// =============================================================================
// parseEmitItem — "with" inside braces is not attr marker
// =============================================================================

Deno.test('no false attr: { withCredentials, fetch }', () => {
  const r = parseEmitItem('{ withCredentials, fetch }')
  assertEquals(r.specifier, { kind: 'named', names: 'withCredentials, fetch' })
  assertEquals(r.attributes, null)
})

// =============================================================================
// parseEmitItem — separator variants
// =============================================================================

Deno.test('sep: *_as_X', () => {
  assertEquals(parseEmitItem('*_as_X').specifier, { kind: 'namespace', name: 'X' })
})

Deno.test('sep: *asX (compact)', () => {
  assertEquals(parseEmitItem('*asX').specifier, { kind: 'namespace', name: 'X' })
})

Deno.test('sep: defer_*_as_X', () => {
  const r = parseEmitItem('defer_*_as_X')
  assertEquals(r.phase, 'defer')
  assertEquals(r.specifier, { kind: 'namespace', name: 'X' })
})

Deno.test('sep: defer*asX (fully compact)', () => {
  const r = parseEmitItem('defer*asX')
  assertEquals(r.phase, 'defer')
  assertEquals(r.specifier, { kind: 'namespace', name: 'X' })
})

Deno.test('sep: {parse}_with{type:json}', () => {
  const r = parseEmitItem('{parse}_with{type:json}')
  assertEquals(r.specifier, { kind: 'named', names: 'parse' })
  assertEquals(r.attributes, { type: 'json' })
})

Deno.test('sep: {parse}with{type:json} (no separator)', () => {
  const r = parseEmitItem('{parse}with{type:json}')
  assertEquals(r.specifier, { kind: 'named', names: 'parse' })
  assertEquals(r.attributes, { type: 'json' })
})

Deno.test('sep: type_*_as_X', () => {
  const r = parseEmitItem('type_*_as_X')
  assertEquals(r.phase, 'type')
  assertEquals(r.specifier, { kind: 'namespace', name: 'X' })
})

Deno.test('sep: default_as_React', () => {
  assertEquals(parseEmitItem('default_as_React').specifier, {
    kind: 'default-surface',
    name: 'React',
  })
})

// =============================================================================
// parseBracket — multi-emit with |
// =============================================================================

Deno.test('multi-emit: auto|default', () => {
  const r = parseBracket('auto|default')
  assertEquals(r.items.length, 2)
  assertEquals(r.items[0].specifier, { kind: 'auto' })
  assertEquals(r.items[1].specifier, { kind: 'default-surface', name: null })
})

Deno.test('multi-emit: *|default as React', () => {
  const r = parseBracket('*|default as React')
  assertEquals(r.items.length, 2)
  assertEquals(r.items[0].specifier, { kind: 'star' })
  assertEquals(r.items[1].specifier, { kind: 'default-surface', name: 'React' })
})

Deno.test('multi-emit: type auto|type default', () => {
  const r = parseBracket('type auto|type default')
  assertEquals(r.items.length, 2)
  assertEquals(r.items[0].phase, 'type')
  assertEquals(r.items[0].specifier, { kind: 'auto' })
  assertEquals(r.items[1].phase, 'type')
  assertEquals(r.items[1].specifier, { kind: 'default-surface', name: null })
})

Deno.test('empty bracket → auto', () => {
  assertEquals(parseBracket('').items[0].specifier, { kind: 'auto' })
})

// =============================================================================
// splitTreeshake — positional format
// =============================================================================

Deno.test('positional: basic brackets', () => {
  assertEquals(splitTreeshake('[{ animate }],[*]'), ['{ animate }', '*'])
})

Deno.test('positional: empty slots via ,,', () => {
  const r = splitTreeshake('[auto],,[defer * as X],,[{parse}]')
  assertEquals(r.length, 5)
  assertEquals(r[0], 'auto')
  assertEquals(r[1], '')
  assertEquals(r[2], 'defer * as X')
  assertEquals(r[3], '')
  assertEquals(r[4], '{parse}')
})

// =============================================================================
// splitTreeshake — sparse format
// =============================================================================

Deno.test('sparse: 0-based indices', () => {
  const r = splitTreeshake('0:[auto];2:[defer*asX];4:[{parse}with{type:json}]')
  assertEquals(r.length, 5)
  assertEquals(r[0], 'auto')
  assertEquals(r[1], undefined)
  assertEquals(r[2], 'defer*asX')
  assertEquals(r[3], undefined)
  assertEquals(r[4], '{parse}with{type:json}')
})

Deno.test('sparse: single entry', () => {
  const r = splitTreeshake('2:[{ animate }]')
  assertEquals(r.length, 3)
  assertEquals(r[0], undefined)
  assertEquals(r[1], undefined)
  assertEquals(r[2], '{ animate }')
})

// =============================================================================
// buildInputCode — base= slot resolution
// =============================================================================

Deno.test('base: missing base = auto|default', () => {
  const result = buildInputCode('react', undefined, undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * as react from "react";',
    'export { default as reactDefault } from "react";',
  ].join('\n'))
})

Deno.test('base: explicit base=auto (safe, one line)', () => {
  const result = buildInputCode('react', undefined, 'auto', undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * as react from "react";',
  ].join('\n'))
})

Deno.test('base: explicit base=auto|default (same as missing)', () => {
  const result = buildInputCode('react', undefined, 'auto|default', undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * as react from "react";',
    'export { default as reactDefault } from "react";',
  ].join('\n'))
})

Deno.test('base: multi-module all get base', () => {
  const result = buildInputCode('react,vue', undefined, 'auto', undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * as react from "react";',
    'export * as vue from "vue";',
  ].join('\n'))
})

Deno.test('base: treeshake overrides specific slots, rest get base', () => {
  const result = buildInputCode(
    'react,vue,angular',
    '1:[{ createApp }]',
    'auto',
    undefined,
    undefined,
  )
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * as react from "react";',
    'export { createApp } from "vue";',
    'export * as angular from "angular";',
  ].join('\n'))
})

Deno.test('base: base=* gives bare re-export all', () => {
  const result = buildInputCode('react', undefined, '*', undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * from "react";',
  ].join('\n'))
})

Deno.test('base: base=*|{default} gives old-school re-export', () => {
  const result = buildInputCode('react', undefined, '*|{default}', undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * from "react";',
    'export { default } from "react";',
  ].join('\n'))
})

Deno.test('base: import mode uses base too', () => {
  const result = buildInputCode('(import)react', undefined, 'auto', undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import * as react from "react";',
  ].join('\n'))
})

Deno.test('base: import with base=auto|default', () => {
  const result = buildInputCode('(import)react', undefined, 'auto|default', undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import * as react from "react";',
    'import reactDefault from "react";',
  ].join('\n'))
})

// =============================================================================
// buildInputCode — type phase (imports)
// =============================================================================

Deno.test('type import: type * as X', () => {
  const result = buildInputCode('(import)@types/react', '[type * as React]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import type * as React from "@types/react";',
  ].join('\n'))
})

Deno.test('type import: type { Config, Theme }', () => {
  const result = buildInputCode('(import)@lib/types', '[type { Config, Theme }]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import type { Config, Theme } from "@lib/types";',
  ].join('\n'))
})

Deno.test('type import: type React (identifier)', () => {
  const result = buildInputCode('(import)react', '[type React]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import type React from "react";',
  ].join('\n'))
})

Deno.test('type import: type auto', () => {
  const result = buildInputCode('(import)react', '[type auto]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import type * as react from "react";',
  ].join('\n'))
})

Deno.test('type import: type default', () => {
  const result = buildInputCode('(import)react', '[type default]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import type reactDefault from "react";',
  ].join('\n'))
})

Deno.test('type import: type bare → drops phase (invalid)', () => {
  const result = buildInputCode('(import)react', '[type bare]', undefined, undefined, undefined)
  // type + bare is invalid, phase dropped → bare import without type
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import "react";',
  ].join('\n'))
})

// =============================================================================
// buildInputCode — type phase (exports — NOT dropped)
// =============================================================================

Deno.test('type export: type { Config }', () => {
  const result = buildInputCode('@lib/types', '[type { Config }]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export type { Config } from "@lib/types";',
  ].join('\n'))
})

Deno.test('type export: type * as Types', () => {
  const result = buildInputCode('@lib/types', '[type * as Types]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export type * as Types from "@lib/types";',
  ].join('\n'))
})

Deno.test('type export: type auto', () => {
  const result = buildInputCode('@lib/types', '[type auto]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export type * as libTypes from "@lib/types";',
  ].join('\n'))
})

Deno.test('type export: type *', () => {
  const result = buildInputCode('@lib/types', '[type *]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export type * from "@lib/types";',
  ].join('\n'))
})

Deno.test('type export: type default', () => {
  const result = buildInputCode('@lib/types', '[type default]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export type { default as libTypesDefault } from "@lib/types";',
  ].join('\n'))
})

// =============================================================================
// buildInputCode — defer/source phases (import only, dropped on export)
// =============================================================================

Deno.test('defer import: defer * as Lazy', () => {
  const result = buildInputCode('(import)./lazy.js', '[defer * as Lazy]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import defer * as Lazy from "./lazy.js";',
  ].join('\n'))
})

Deno.test('source import: source:Wasm', () => {
  const result = buildInputCode('(import)./mod.wasm', '[source:Wasm]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import source Wasm from "./mod.wasm";',
  ].join('\n'))
})

Deno.test('defer on export → phase dropped', () => {
  const result = buildInputCode('lodash', '[defer * as _]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * as _ from "lodash";',
  ].join('\n'))
})

Deno.test('source on export → phase dropped', () => {
  const result = buildInputCode('lodash', '[source:_]', undefined, undefined, undefined)
  // source + identifier on export → phase dropped, identifier becomes default alias
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export { default as _ } from "lodash";',
  ].join('\n'))
})

Deno.test('defer invalid clause → phase dropped', () => {
  const result = buildInputCode('(import)pkg', '[defer { a }]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import { a } from "pkg";',
  ].join('\n'))
})

Deno.test('source invalid clause → phase dropped', () => {
  const result = buildInputCode('(import)pkg', '[source * as X]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import * as X from "pkg";',
  ].join('\n'))
})

// =============================================================================
// buildInputCode — attributes
// =============================================================================

Deno.test('import attrs: {parse} with{type:json}', () => {
  const result = buildInputCode('(import)./data.json', '[{parse} with{type:json}]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import { parse } from "./data.json" with { type: "json" };',
  ].join('\n'))
})

Deno.test('export attrs: * as Styles with{type:css}', () => {
  const result = buildInputCode('./styles.css', '[* as Styles with{type:css}]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * as Styles from "./styles.css" with { type: "css" };',
  ].join('\n'))
})

Deno.test('bare import attrs: bare with{type:css}', () => {
  const result = buildInputCode('(import)./styles.css', '[bare with{type:css}]', undefined, undefined, undefined)
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import "./styles.css" with { type: "css" };',
  ].join('\n'))
})

// =============================================================================
// buildInputCode — sparse treeshake + base
// =============================================================================

Deno.test('sparse + base: override slots, rest use base', () => {
  const result = buildInputCode(
    '(import)data.json,(import)styles.css,@okikio/animate',
    '0:[{parse} with{type:json}];1:[bare with{type:css}]',
    'auto',
    undefined,
    undefined,
  )
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import { parse } from "data.json" with { type: "json" };',
    'import "styles.css" with { type: "css" };',
    'export * as okikioAnimate from "@okikio/animate";',
  ].join('\n'))
})

// =============================================================================
// buildInputCode — positional empty slots + base
// =============================================================================

Deno.test('positional empty slots use base', () => {
  const result = buildInputCode(
    'react,vue,angular',
    '[{ useState }],,',
    'auto',
    undefined,
    undefined,
  )
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export { useState } from "react";',
    'export * as vue from "vue";',
    'export * as angular from "angular";',
  ].join('\n'))
})

// =============================================================================
// Backward compat — classic URLs still work
// =============================================================================

Deno.test('compat: existing import/export URL with treeshake', () => {
  const result = buildInputCode(
    '(import)@okikio/emitter,(import)@okikio/animate',
    '[T],[{ animate }]',
    undefined,
    undefined,
    undefined,
  )
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import T from "@okikio/emitter";',
    'import { animate } from "@okikio/animate";',
  ].join('\n'))
})

Deno.test('compat: existing namespace treeshake format', () => {
  const result = buildInputCode(
    '(import)@okikio/animate,(import)@okikio/animate',
    '[{ animate as B }],[* as TR]',
    undefined,
    undefined,
    undefined,
  )
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import { animate as B } from "@okikio/animate";',
    'import * as TR from "@okikio/animate";',
  ].join('\n'))
})

// =============================================================================
// Realistic full URL scenarios
// =============================================================================

Deno.test('scenario: defer + source + JSON attrs (doc3)', () => {
  const result = buildInputCode(
    '(import)lodash,(import)./config.json,(import)wasm-tools',
    '[defer*asLodash],[{settings}with{type:json}],[source:WasmTools]',
    undefined,
    undefined,
    undefined,
  )
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'import defer * as Lodash from "lodash";',
    'import { settings } from "./config.json" with { type: "json" };',
    'import source WasmTools from "wasm-tools";',
  ].join('\n'))
})

Deno.test('scenario: type exports + CSS attrs (doc3)', () => {
  const result = buildInputCode(
    '@lib/types,./theme.css',
    '[type { Config, Theme }],[*_as_theme_with{type:css}]',
    undefined,
    undefined,
    undefined,
  )
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export type { Config, Theme } from "@lib/types";',
    'export * as theme from "./theme.css" with { type: "css" };',
  ].join('\n'))
})

Deno.test('scenario: sparse + base=auto (doc5)', () => {
  const result = buildInputCode(
    'react,react-dom/client,three',
    '1:[auto|default];2:[{Scene,Mesh}]',
    'auto',
    undefined,
    undefined,
  )
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * as react from "react";',
    'export * as reactDomClient from "react-dom/client";',
    'export { default as reactDomClientDefault } from "react-dom/client";',
    'export { Scene,Mesh } from "three";',
  ].join('\n'))
})

Deno.test('scenario: v=1 canonical share link', () => {
  // ?v=1&q=react,react-dom/client&base=auto|default
  const result = buildInputCode(
    'react,react-dom/client',
    undefined,
    'auto|default',
    undefined,
    undefined,
  )
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export * as react from "react";',
    'export { default as reactDefault } from "react";',
    'export * as reactDomClient from "react-dom/client";',
    'export { default as reactDomClientDefault } from "react-dom/client";',
  ].join('\n'))
})

Deno.test('scenario: all type exports', () => {
  // ?v=1&q=@lib/types&base=type auto|type default
  const result = buildInputCode(
    '@lib/types',
    undefined,
    'type auto|type default',
    undefined,
    undefined,
  )
  assertEquals(result, [
    '// Click Build for the Bundled, Minified & Compressed package size',
    'export type * as libTypes from "@lib/types";',
    'export type { default as libTypesDefault } from "@lib/types";',
  ].join('\n'))
})