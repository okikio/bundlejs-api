import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import type { StandardSchemaV1 } from '@standard-schema/spec'

import { toErrs } from './validation.ts'

describe('toErrs', () => {
  it('formats nested issue paths into dot notation', () => {
    const issues: StandardSchemaV1.Issue[] = [{
      message: 'Invalid email',
      path: ['user', 'profile', 'email'],
    }]

    expect(toErrs(issues)).toEqual([{ field: 'user.profile.email', message: 'Invalid email' }])
  })

  it('uses _root when an issue has no path', () => {
    const issues: StandardSchemaV1.Issue[] = [{
      message: 'Request body is required',
    }]

    expect(toErrs(issues)).toEqual([{ field: '_root', message: 'Request body is required' }])
  })
})