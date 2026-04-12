import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import {
  BaseCookieSchema,
  BaseParamSchema,
  BaseQuerySchema,
  makeBaseFormSchema,
  makeHeaderSchema,
} from './schemas.ts'

describe('BaseQuerySchema', () => {
  it('accepts arbitrary query keys with string and string[] values', () => {
    const parsed = BaseQuerySchema.parse({
      page: '2',
      filter: ['active', 'archived'],
    })

    expect(parsed).toEqual({
      page: '2',
      filter: ['active', 'archived'],
    })
  })
})

describe('makeBaseFormSchema', () => {
  it('accepts scalar and repeated form values', () => {
    const FormSchema = makeBaseFormSchema<string>()

    const parsed = FormSchema.parse({
      name: 'Quarterly report',
      tags: ['finance', 'ops'],
    })

    expect(parsed).toEqual({
      name: 'Quarterly report',
      tags: ['finance', 'ops'],
    })
  })
})

describe('makeHeaderSchema', () => {
  it('normalizes header keys to lowercase', () => {
    const HeaderSchema = makeHeaderSchema()

    const parsed = HeaderSchema.parse({
      Authorization: 'Bearer token',
      'X-Request-Id': 'req_123',
    })

    expect(parsed).toEqual({
      authorization: 'Bearer token',
      'x-request-id': 'req_123',
    })
  })
})

describe('BaseCookieSchema', () => {
  it('accepts arbitrary cookie keys as strings', () => {
    const parsed = BaseCookieSchema.parse({
      session: 'abc',
      theme: 'dark',
    })

    expect(parsed).toEqual({
      session: 'abc',
      theme: 'dark',
    })
  })
})

describe('BaseParamSchema', () => {
  it('accepts arbitrary route params as strings', () => {
    const parsed = BaseParamSchema.parse({
      organizationId: 'org_123',
      memberId: 'mem_456',
    })

    expect(parsed).toEqual({
      organizationId: 'org_123',
      memberId: 'mem_456',
    })
  })
})