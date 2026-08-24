import { describe, expect, it, vi } from 'vitest'
import { NOTE_CLASS } from '@notarium/contract'

import type { Ctx } from '../../gateway'
import { handleDeleteNote, handleEditNote, handleMoveNote, handleRenameNote } from './noteLifecycle'

const skillContext = (replay: 'durable' | 'in-flight'): Ctx => {
  const principal = { id: 'pat:alice:test' }
  const recorded = { noteId: 'skill-note', versionToken: 'recorded-token' }
  const flightKey = `idem:${principal.id}:edit_note:skill-note\0old-key`
  const inFlight = new Map()

  if (replay === 'in-flight') {
    inFlight.set(flightKey, Promise.resolve({ result: recorded, wasHit: false }))
  }

  return {
    principal,
    store: {
      noteStore: vi.fn().mockResolvedValue({
        space: 'personal-id',
        store: {
          read: vi.fn().mockResolvedValue({
            id: 'skill-note',
            class: NOTE_CLASS.skill,
            title: 'Packaged instructions',
            content: '# Packaged instructions\n\nOriginal body.',
            frontmatter: {},
            filePath: '.notarium/skills/skill-note/SKILL.md',
          }),
        },
      }),
    },
    gatewayState:
      replay === 'durable'
        ? {
            dedupGet: vi.fn().mockResolvedValue(recorded),
            dedupPut: vi.fn(),
            dedupPrune: vi.fn(),
          }
        : undefined,
    idempotencyInFlight: inFlight,
    spaces: { slugOf: vi.fn().mockReturnValue('personal') },
    personalSpace: vi.fn().mockResolvedValue('personal-id'),
    now: () => new Date('2026-08-22T00:00:00.000Z'),
  } as unknown as Ctx
}

const ordinaryContextWithLegacySkillReplay = (replay: 'durable' | 'in-flight'): Ctx => {
  const principal = { id: 'pat:alice:test' }
  const recorded = { noteId: 'skill-note', versionToken: 'recorded-token' }
  const legacyScope = `idem:${principal.id}:edit_note`
  const inFlight = new Map()

  if (replay === 'in-flight') {
    inFlight.set(`${legacyScope}\0old-key`, Promise.resolve({ result: recorded, wasHit: false }))
  }
  const read = vi.fn().mockResolvedValue({
    id: 'ordinary-note',
    class: NOTE_CLASS.userDoc,
    title: 'Ordinary note',
    content: '# Ordinary note\n\nOriginal body.',
    frontmatter: {},
    filePath: 'ordinary-note.md',
    versionToken: 'ordinary-token',
  })
  const write = vi.fn().mockResolvedValue({
    id: 'ordinary-note',
    filePath: 'ordinary-note.md',
    versionToken: 'ordinary-next-token',
  })

  return {
    principal,
    store: {
      noteStore: vi.fn().mockResolvedValue({
        space: 'personal-id',
        store: { read, write },
      }),
    },
    gatewayState:
      replay === 'durable'
        ? {
            dedupGet: vi.fn(async (scope: string) => (scope === legacyScope ? recorded : null)),
            dedupPut: vi.fn(),
            dedupPrune: vi.fn(),
          }
        : undefined,
    idempotencyInFlight: inFlight,
    spaces: { slugOf: vi.fn().mockReturnValue('personal') },
    personalSpace: vi.fn().mockResolvedValue('personal-id'),
    now: () => new Date('2026-08-22T00:00:00.000Z'),
  } as unknown as Ctx
}

const reoccupiedContext = () => {
  const ordinary = {
    id: 'ordinary-note',
    class: NOTE_CLASS.userDoc,
    title: 'Ordinary note',
    content: 'Original body.',
    frontmatter: {},
    filePath: 'ordinary-note.md',
    versionToken: 'ordinary-token',
  }
  const skill = {
    ...ordinary,
    class: NOTE_CLASS.skill,
    filePath: '.notarium/skills/ordinary-note/SKILL.md',
    versionToken: 'skill-token',
  }
  const read = vi.fn().mockResolvedValueOnce(ordinary).mockResolvedValue(skill)

  const assertMutation = async (options: { assertCurrent?: (note: typeof skill) => void }) => {
    await options.assertCurrent?.(skill)
  }
  const write = vi.fn(async (_input, options) => {
    await assertMutation(options)
    return { id: ordinary.id, filePath: ordinary.filePath, versionToken: 'next-token' }
  })
  const move = vi.fn(async (_input, options) => {
    await assertMutation(options)
    return { id: ordinary.id, filePath: 'docs/ordinary-note.md' }
  })
  const remove = vi.fn(async (_id, options) => assertMutation(options))
  const store = { read, write, move, remove }
  const ctx = {
    principal: { id: 'pat:alice:test' },
    store: { noteStore: vi.fn().mockResolvedValue({ space: 'personal-id', store }) },
    spaces: { slugOf: vi.fn().mockReturnValue('personal') },
    personalSpace: vi.fn().mockResolvedValue('personal-id'),
    projectsInSpace: vi.fn().mockResolvedValue([]),
    now: () => new Date('2026-08-22T00:00:00.000Z'),
  } as unknown as Ctx

  return { ctx, move, remove, write }
}

describe('edit_note skill preflight', () => {
  it.each(['durable', 'in-flight'] as const)(
    'refuses a skill before a stale %s idempotency replay can escape',
    async (replay) => {
      await expect(
        handleEditNote(skillContext(replay), {
          ref: 'skill-note',
          operation: 'append',
          content: 'must not land',
          idempotencyKey: 'old-key',
        }),
      ).rejects.toThrow(/ability package.*edit_ability/is)
    },
  )

  it.each(['durable', 'in-flight'] as const)(
    'does not let a legacy skill %s replay escape through an ordinary ref',
    async (replay) => {
      const result = await handleEditNote(ordinaryContextWithLegacySkillReplay(replay), {
        ref: 'ordinary-note',
        operation: 'append',
        content: 'New body.',
        idempotencyKey: 'old-key',
      })

      expect(result.structured).toMatchObject({
        noteId: 'ordinary-note',
        versionToken: 'ordinary-next-token',
      })
    },
  )

  it('rechecks the current class inside edit mutation semantics', async () => {
    const { ctx, write } = reoccupiedContext()

    await expect(
      handleEditNote(ctx, {
        ref: 'ordinary-note',
        operation: 'append',
        content: 'must not land',
      }),
    ).rejects.toThrow(/ability package.*edit_ability/is)
    expect(write).not.toHaveBeenCalled()
  })

  it('rechecks the current class inside delete, move and rename mutations', async () => {
    const deleteWorld = reoccupiedContext()
    const moveWorld = reoccupiedContext()
    const renameWorld = reoccupiedContext()

    await expect(handleDeleteNote(deleteWorld.ctx, { ref: 'ordinary-note' })).rejects.toThrow(
      /ability package.*delete_ability/is,
    )
    await expect(
      handleMoveNote(moveWorld.ctx, { ref: 'ordinary-note', toFolder: 'docs' }),
    ).rejects.toThrow(/ability package/is)
    await expect(
      handleRenameNote(renameWorld.ctx, { ref: 'ordinary-note', title: 'Renamed' }),
    ).rejects.toThrow(/ability package/is)
    expect(deleteWorld.remove).toHaveBeenCalledOnce()
    expect(moveWorld.move).toHaveBeenCalledOnce()
    expect(renameWorld.write).toHaveBeenCalledOnce()
  })

  it('checks the live class before joining a real in-flight replay', async () => {
    let currentClass: (typeof NOTE_CLASS)[keyof typeof NOTE_CLASS] = NOTE_CLASS.userDoc
    let releaseWrite!: () => void
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let markEntered!: () => void
    const writeEntered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    const read = vi.fn(async () => ({
      id: 'ordinary-note',
      class: currentClass,
      title: 'Ordinary note',
      content: 'Original body.',
      frontmatter: {},
      filePath: 'ordinary-note.md',
      versionToken: 'ordinary-token',
    }))
    const write = vi.fn(async (_input, options) => {
      await options.assertCurrent?.(await read())
      markEntered()
      await writeHeld
      return {
        id: 'ordinary-note',
        filePath: 'ordinary-note.md',
        versionToken: 'ordinary-next-token',
      }
    })
    const ctx = {
      principal: { id: 'pat:alice:test' },
      store: {
        noteStore: vi.fn().mockResolvedValue({
          space: 'personal-id',
          store: { read, write },
        }),
      },
      idempotencyInFlight: new Map(),
      spaces: { slugOf: vi.fn().mockReturnValue('personal') },
      personalSpace: vi.fn().mockResolvedValue('personal-id'),
      now: () => new Date('2026-08-22T00:00:00.000Z'),
    } as unknown as Ctx
    const args = {
      ref: 'ordinary-note',
      operation: 'append' as const,
      content: 'New body.',
      idempotencyKey: 'old-key',
    }
    const first = handleEditNote(ctx, args)

    await writeEntered
    currentClass = NOTE_CLASS.skill
    await expect(handleEditNote(ctx, args)).rejects.toThrow(/ability package.*edit_ability/is)
    releaseWrite()
    await expect(first).resolves.toMatchObject({
      structured: { noteId: 'ordinary-note', versionToken: 'ordinary-next-token' },
    })
    expect(write).toHaveBeenCalledOnce()
    expect(ctx.idempotencyInFlight).toHaveProperty('size', 0)
  })
})
