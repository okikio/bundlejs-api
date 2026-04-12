import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import { getEnv, isDeno, isNode, requireEnv } from './mod.ts'

describe('runtime detection', () => {
  it('reports the Deno runtime when tests run under Deno', () => {
    expect(isDeno).toBe(true)
    expect(isNode).toBe(false)
  })
})

describe('getEnv', () => {
  it('returns the fallback when the variable is missing', () => {
    expect(getEnv('FINANCE_APP_TEST_MISSING_ENV', 'fallback-value')).toBe('fallback-value')
  })

  it('reads the runtime environment when the variable exists', () => {
    const key = 'FINANCE_APP_TEST_RUNTIME_ENV'
    const previousValue = Deno.env.get(key)

    try {
      Deno.env.set(key, 'runtime-value')

      expect(getEnv(key)).toBe('runtime-value')
    } finally {
      if (previousValue === undefined) {
        Deno.env.delete(key)
      } else {
        Deno.env.set(key, previousValue)
      }
    }
  })
})

describe('requireEnv', () => {
  it('returns the configured value when present', () => {
    const key = 'FINANCE_APP_TEST_REQUIRED_ENV'
    const previousValue = Deno.env.get(key)

    try {
      Deno.env.set(key, 'required-value')

      expect(requireEnv(key)).toBe('required-value')
    } finally {
      if (previousValue === undefined) {
        Deno.env.delete(key)
      } else {
        Deno.env.set(key, previousValue)
      }
    }
  })

  it('throws when the variable is missing', () => {
    const key = 'FINANCE_APP_TEST_MISSING_REQUIRED_ENV'
    const previousValue = Deno.env.get(key)

    try {
      Deno.env.delete(key)

      expect(() => requireEnv(key)).toThrow(/Missing required environment variable/)
    } finally {
      if (previousValue !== undefined) {
        Deno.env.set(key, previousValue)
      }
    }
  })
})