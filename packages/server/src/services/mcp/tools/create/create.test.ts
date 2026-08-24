import { describe, expect, it, vi } from 'vitest'

import type { ProjectRecord } from '../../../metaDb'
import { ToolFailure } from '../../gateway'
import { resolveCreateFolder } from './create'

const project = (path = 'workspace/docs'): ProjectRecord => ({
  id: 'project-docs',
  space: 'space-team',
  path,
  slug: 'docs',
  aliases: [],
  pathAliases: [],
  displayName: 'Docs',
  status: 'active',
  lastSeen: '2026-08-24T00:00:00.000Z',
  createdAt: '2026-08-24T00:00:00.000Z',
})

describe('resolveCreateFolder', () => {
  it('gives exact space-relative and collapsed-root forms priority over classification', async () => {
    const resolveProject = vi.fn()

    await expect(
      resolveCreateFolder(
        { resolveProject },
        project(),
        'team/docs',
        'workspace/docs/team/docs/nested',
        new Map(),
      ),
    ).resolves.toBe('workspace/docs/team/docs/nested')
    await expect(
      resolveCreateFolder({ resolveProject }, project(''), 'team', 'team/team/nested', new Map()),
    ).resolves.toBe('team/team/nested')
    expect(resolveProject).not.toHaveBeenCalled()
  })

  it('rejects a selected-project prefix and memoizes it for the batch', async () => {
    const rec = project()
    const resolveProject = vi.fn(async () => rec)
    const cache = new Map<string, string | null>()

    await expect(
      resolveCreateFolder({ resolveProject }, rec, 'team/docs', 'team/docs/a', cache),
    ).rejects.toThrow(/folder, not a project handle/i)
    await expect(
      resolveCreateFolder({ resolveProject }, rec, 'team/docs', 'team/docs/b', cache),
    ).rejects.toThrow(/folder, not a project handle/i)
    expect(resolveProject).toHaveBeenCalledTimes(1)
    expect(resolveProject).toHaveBeenCalledWith('team/docs')
  })

  it('keeps unresolved and different-project prefixes relative but propagates infrastructure errors', async () => {
    const rec = project()
    const unresolved = vi.fn(async () => {
      throw new ToolFailure('no such project')
    })

    await expect(
      resolveCreateFolder(
        { resolveProject: unresolved },
        rec,
        'team/docs',
        'missing/docs/a',
        new Map(),
      ),
    ).resolves.toBe('workspace/docs/missing/docs/a')
    await expect(
      resolveCreateFolder(
        { resolveProject: vi.fn(async () => ({ ...rec, id: 'another-project' })) },
        rec,
        'team/docs',
        'team/other/a',
        new Map(),
      ),
    ).resolves.toBe('workspace/docs/team/other/a')

    const failure = new Error('registry unavailable')

    await expect(
      resolveCreateFolder(
        {
          resolveProject: vi.fn(async () => {
            throw failure
          }),
        },
        rec,
        'team/docs',
        'team/docs/a',
        new Map(),
      ),
    ).rejects.toBe(failure)
  })
})
