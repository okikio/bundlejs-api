import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'

import type {
  CursorData as CollectionCursorData,
  FieldSelectionNormalized as CollectionFieldSelection,
} from '@utils/query/schemas'

import {
  applyPagination,
  buildSelectColumns,
  getColumnMap,
  getRelationSqlName,
  getRelationTable,
  normalizeBaseFilters,
  readExplainPlanRows,
  requireColumn,
  resolveSelectedFieldNames,
} from './db.ts'

describe('relation registry', () => {
  it('resolves a known relation table and SQL name', () => {
    const table = getRelationTable('user')

    expect(table).toBeDefined()
    expect(getRelationSqlName('user')).toBe('user')
  })

  it('rejects an unknown relation', () => {
    expect(() => getRelationTable('does_not_exist')).toThrow()
  })
})

describe('column resolution', () => {
  it('returns real Drizzle columns for a relation', () => {
    const columns = getColumnMap('user')

    expect(columns.email).toBeDefined()
    expect(columns.id).toBeDefined()
  })

  it('rejects unknown fields through requireColumn', () => {
    const columns = getColumnMap('user')

    expect(() => requireColumn(columns, 'drop_table', 'user.list')).toThrow()
  })
})

describe('field selection helpers', () => {
  it('resolves simple field selections directly', () => {
    const selection: CollectionFieldSelection = {
      type: 'simple',
      fields: ['id', 'email'],
    }

    expect(resolveSelectedFieldNames(selection)).toEqual(['id', 'email'])
  })

  it('resolves JSON:API field selections by resource type', () => {
    const selection: CollectionFieldSelection = {
      type: 'jsonapi',
      fields: {
        user: ['id', 'email'],
        organization: ['id', 'name'],
      },
    }

    expect(resolveSelectedFieldNames(selection, 'organization')).toEqual(['id', 'name'])
  })

  it('builds projected select columns for the requested fields', () => {
    const columns = getColumnMap('user')
    const selection: CollectionFieldSelection = {
      type: 'simple',
      fields: ['id', 'email'],
    }

    const projected = buildSelectColumns(columns, selection, 'user.list')

    expect(Object.keys(projected)).toEqual(['id', 'email'])
  })
})

describe('normalizeBaseFilters', () => {
  it('adds the default eq operator when one is omitted', () => {
    const filters = normalizeBaseFilters([{ field: 'userId', value: 'user_123' }])

    expect(filters).toEqual([{ field: 'userId', operator: 'eq', value: 'user_123' }])
  })

  it('returns null when no base filters are provided', () => {
    expect(normalizeBaseFilters()).toBeNull()
  })
})

describe('applyPagination', () => {
  const columns = getColumnMap('user')

  it('uses the given offset and limit for offset pagination', () => {
    const plan = applyPagination(columns, { type: 'offset', offset: 40, limit: 20 })

    expect(plan).toEqual({ offset: 40, limit: 20 })
  })

  it('asks for one extra row on the first cursor page', () => {
    const plan = applyPagination(columns, { type: 'cursor', limit: 20 })

    expect(plan).toEqual({ limit: 21 })
  })

  it('builds a boundary clause when a decoded cursor is present', () => {
    const decodedCursor: CollectionCursorData = {
      sortField: 'email',
      sortValue: 'm@example.com',
      tiebreaker: 'id',
      tiebreakerValue: 'user_10',
      direction: 'asc',
      createdAt: new Date('2026-04-06T00:00:00.000Z'),
    }

    const plan = applyPagination(columns, {
      type: 'cursor',
      limit: 20,
      cursor: 'opaque',
      decodedCursor,
    })

    expect(plan.limit).toBe(21)
    expect(plan.where).toBeDefined()
  })
})

describe('readExplainPlanRows', () => {
  it('reads planner rows from an already-parsed explain payload', () => {
    const planRows = readExplainPlanRows({
      explain: [{ Plan: { 'Plan Rows': 42 } }],
    })

    expect(planRows).toBe(42)
  })

  it('reads planner rows from a stringified explain payload', () => {
    const planRows = readExplainPlanRows({
      explain: JSON.stringify([{ Plan: { 'Plan Rows': '84' } }]),
    })

    expect(planRows).toBe(84)
  })

  it('returns null when the explain payload is missing or unreadable', () => {
    expect(readExplainPlanRows(undefined)).toBeNull()
    expect(readExplainPlanRows({ explain: 'not-json' })).toBeNull()
  })
})