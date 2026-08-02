// The untrusted-path guard (#16 security spec §5) — OUR first line before any
// engine. Fail-closed: traversal is rejected, never resolved.

import { describe, expect, it } from 'vitest'

import { safeRelPath } from '../../packages/server/src/libs/relPath'

describe('safeRelPath', () => {
  it('normalises honest relative paths', () => {
    expect(safeRelPath('demo/sub')).toBe('demo/sub')
    expect(safeRelPath('demo//sub/')).toBe('demo/sub')
    expect(safeRelPath('./demo/./x.md')).toBe('demo/x.md')
    expect(safeRelPath('')).toBe('') // the space root is a legal directory
  })

  it('rejects everything that tries to leave the space', () => {
    expect(safeRelPath('../up')).toBeNull()
    expect(safeRelPath('a/../../b')).toBeNull() // .. is rejected, not resolved
    expect(safeRelPath('a/..')).toBeNull()
    expect(safeRelPath('/absolute')).toBeNull()
    expect(safeRelPath('a\0b')).toBeNull()
    expect(safeRelPath('..\\win')).toBeNull() // backslashes are separators too
  })

  it('rejects dot-prefixed segments — reserved/hidden namespaces (#78)', () => {
    // .notarium/memory is the agent-mount: a user write there would poison
    // agent-memory or vanish on the next rescan (the scan skips dot-dirs).
    expect(safeRelPath('.notarium/memory')).toBeNull()
    expect(safeRelPath('.notarium')).toBeNull()
    expect(safeRelPath('.git')).toBeNull()
    expect(safeRelPath('.obsidian/cache')).toBeNull()
    expect(safeRelPath('foo/.bar')).toBeNull() // dot-dir at any depth
  })
})
