import { describe, expect, it } from 'vitest'
import { contextScopeSearch, projectContextScope } from './contextScope'

describe('project context scope', () => {
  it('drops the Space half of a handle', () => {
    expect(projectContextScope('team/apollo')).toBe('apollo')
  })

  it('keeps a handle that names no Space', () => {
    expect(projectContextScope('apollo')).toBe('apollo')
  })

  it('keeps every segment after the first separator', () => {
    expect(projectContextScope('team/apollo/launch')).toBe('apollo/launch')
  })
})

describe('the query a context scope tab carries', () => {
  it('drops a role locator, which names a placement the destination cannot hold', () => {
    expect(contextScopeSearch('?role=owned-role-locator')).toBe('')
  })

  it('keeps every other parameter, and the leading ? with them', () => {
    expect(contextScopeSearch('?role=abc&q=deploy')).toBe('?q=deploy')
  })

  it('answers an empty search with an empty string, never a bare ?', () => {
    expect(contextScopeSearch('')).toBe('')
  })
})
