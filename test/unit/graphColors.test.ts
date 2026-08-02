import { describe, expect, it } from 'vitest'
import {
  buildGroupColors,
  buildPalette,
  groupKey,
  groupKeyOfPath,
} from '../../packages/web/src/libs/graph/graphColors'

// Folder grouping for the graph: first two path segments share a colour. Pure
// and deterministic so the canvas and the legend derive identical colours (#25).

describe('groupKeyOfPath', () => {
  it('takes the first two segments', () => {
    expect(groupKeyOfPath('demo/projects/2024/x')).toBe('demo/projects')
    expect(groupKeyOfPath('demo')).toBe('demo')
  })
  it('maps the empty path to "root"', () => {
    expect(groupKeyOfPath('')).toBe('root')
  })
})

describe('groupKey', () => {
  it('groups a deep note by its first two folder segments', () => {
    expect(groupKey({ filePath: 'demo/projects/2024/x.md' })).toBe('demo/projects')
  })
  it('groups a single-folder note by that folder', () => {
    expect(groupKey({ filePath: 'demo/x.md' })).toBe('demo')
  })
  it('groups a root-level note as "root"', () => {
    expect(groupKey({ filePath: 'x.md' })).toBe('root')
  })
  it('has no group for a ghost or a null node', () => {
    expect(groupKey({ ghost: true, filePath: 'demo/x.md' })).toBeNull()
    expect(groupKey(null)).toBeNull()
  })
})

describe('buildPalette', () => {
  it('assigns evenly-spaced hues by position', () => {
    const map = buildPalette(['x', 'y'], false)
    expect(map.get('x')).toBe('hsl(0, 58%, 46%)')
    expect(map.get('y')).toBe('hsl(180, 58%, 46%)')
  })
  it('uses the dark-theme saturation/lightness when dark', () => {
    expect(buildPalette(['x'], true).get('x')).toBe('hsl(0, 60%, 64%)')
  })
})

describe('buildGroupColors', () => {
  it('keys off distinct folder groups, sorted, ignoring ghosts', () => {
    const nodes = [
      { filePath: 'beta/x.md' },
      { filePath: 'alpha/y.md' },
      { filePath: 'alpha/z.md' }, // same group as y → one key
      { ghost: true },
    ]
    const map = buildGroupColors(nodes, false)
    expect([...map.keys()]).toEqual(['alpha', 'beta'])
  })
})
