import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const COMMON_VIEW_FILES = [
  'packages/core/src/views/parse.ts',
  'packages/core/src/views/registry.ts',
  'packages/core/src/views/types.ts',
  'packages/core/src/views/viewRef.ts',
  'packages/core/src/views/write.ts',
]

describe('generic view carrier boundary', () => {
  it('contains no reader-specific board branch', () => {
    for (const file of COMMON_VIEW_FILES) {
      expect(readFileSync(file, 'utf8').toLowerCase(), file).not.toContain('board')
    }
  })
})
