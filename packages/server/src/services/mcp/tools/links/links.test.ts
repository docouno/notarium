import { describe, expect, it, vi } from 'vitest'
import { NOTE_CLASS } from '@notarium/contract'

import type { Ctx } from '../../gateway'
import { handleLink, handleLinkMany, resolveLinkTitle } from './links'

const context = (detail: { id: string; title: string }): Ctx =>
  ({
    principal: { id: 'agent' },
    store: {
      noteStore: vi.fn().mockResolvedValue({
        space: 'main',
        store: { read: vi.fn().mockResolvedValue(detail) },
      }),
    },
  }) as unknown as Ctx

describe('resolveLinkTitle', () => {
  it('rejects a forward title that already resolves back to the source', async () => {
    const ctx = context({ id: 'other-id', title: 'Other' })
    ctx.store.spaceStore = vi.fn().mockResolvedValue({
      resolveWikilink: vi.fn().mockResolvedValue({ id: 'durable-source', title: 'Source' }),
    })

    await expect(
      resolveLinkTitle(ctx, {
        fromId: 'durable-source',
        fromSpace: 'main',
        relation: 'links_to',
        toTitle: 'Former Source Name',
      }),
    ).rejects.toThrow(/cannot be linked to itself/i)
  })

  it('materializes the durable id returned for a provisional target', async () => {
    await expect(
      resolveLinkTitle(context({ id: 'durable-id', title: 'Target' }), {
        fromSpace: 'main',
        relation: 'links_to',
        to: 'provisional-id',
      }),
    ).resolves.toBe('notarium-id:durable-id|Target')
  })

  it('rejects a self-link revealed only after provisional id reconciliation', async () => {
    await expect(
      resolveLinkTitle(context({ id: 'durable-id', title: 'Target' }), {
        fromId: 'durable-id',
        fromSpace: 'main',
        relation: 'links_to',
        to: 'provisional-id',
      }),
    ).rejects.toThrow(/cannot be linked to itself/i)
  })
})

describe('link source class linearization', () => {
  const reoccupied = () => {
    const source = {
      id: 'source-id',
      class: NOTE_CLASS.userDoc,
      title: 'Source',
      content: 'Body.',
      frontmatter: {},
      filePath: 'source.md',
      versionToken: 'source-token',
    }
    const skill = {
      ...source,
      class: NOTE_CLASS.skill,
      filePath: '.notarium/skills/source-id/SKILL.md',
      versionToken: 'skill-token',
    }
    const read = vi.fn().mockResolvedValueOnce(source).mockResolvedValue(skill)
    const write = vi.fn()
    const store = { read, write }
    const ctx = {
      principal: { id: 'agent' },
      store: {
        noteStore: vi.fn().mockResolvedValue({ space: 'main', store }),
        spaceStore: vi.fn().mockResolvedValue({}),
      },
    } as unknown as Ctx

    return { ctx, write }
  }

  it('refuses a reoccupied skill source for single and grouped link writes', async () => {
    const single = reoccupied()
    const grouped = reoccupied()

    await expect(
      handleLink(single.ctx, {
        from: 'source-id',
        toTitle: 'Future note',
        relation: 'relates_to',
      }),
    ).rejects.toThrow(/ability package/is)
    await expect(
      handleLinkMany(grouped.ctx, {
        links: [{ from: 'source-id', toTitle: 'Future note', relation: 'relates_to' }],
      }),
    ).resolves.toMatchObject({
      structured: {
        results: [{ index: 0, ok: false, error: expect.stringMatching(/ability package/i) }],
      },
    })
    expect(single.write).not.toHaveBeenCalled()
    expect(grouped.write).not.toHaveBeenCalled()
  })
})
