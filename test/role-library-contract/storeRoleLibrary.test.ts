import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import { analyzeDocumentState, DOCUMENT_ROLE, NOTE_CLASS } from '@notarium/core'
import { InMemoryStore } from '@notarium/engine-memory'
import { AbilityUnavailableError, type RoleLocation, type SkillPackage } from '@notarium/server'

import { createStoreRoleLibrary } from '../fake-server/storeRoleLibrary'
import { writableLibrary } from '../roleLibraryComposition'
import { describeRoleLibraryContract, packageDirectoryOf, packageOf } from './roleLibraryContract'

/** The fake server's library is the ONLY `RoleLibrary` under every browser gate, so
 *  whatever it cannot express is a class of states those gates can never reach. It
 *  was the one implementation of the port that had never been run against the port's
 *  own contract. */
describeRoleLibraryContract('createStoreRoleLibrary', async () => {
  const store = new InMemoryStore({
    space: 'personal',
    now: '2099-08-05T12:00:00.000Z',
    notes: [],
  })

  return { library: writableLibrary(createStoreRoleLibrary(() => Promise.resolve(store))) }
})

const PROJECT: RoleLocation = {
  scope: 'project',
  space: 'personal',
  projectId: 'project-a',
}
const PERSONAL: RoleLocation = { scope: 'personal', space: 'personal' }

const rolePackage = (name: string): SkillPackage => {
  const directoryName = packageDirectoryOf(name)

  return {
    ...packageOf(name, 'Original role body.'),
    files: new Map([
      [
        'SKILL.md',
        Buffer.from(
          `---\nnotarium-id: ${directoryName}\nname: ${name}\ndescription: ${name}.\nmetadata:\n  notarium.kind: role\n---\n\nOriginal role body.`,
        ),
      ],
    ]),
  }
}

class ReplacementBeforeExactScopeStore extends InMemoryStore {
  #replacement: (() => Promise<void>) | undefined

  replaceBeforeNextExactScope(replacement: () => Promise<void>): void {
    this.#replacement = replacement
  }

  async withExactNoteClaim<Result>(
    noteId: string,
    task: (current: Awaited<ReturnType<InMemoryStore['read']>>) => Promise<Result>,
  ): Promise<Result> {
    const replacement = this.#replacement

    this.#replacement = undefined
    await replacement?.()
    return task(await this.read(noteId))
  }
}

describe('store role library move identity', () => {
  it('rejects a role replaced by a skill when the move acquires its exact scope', async () => {
    const store = new ReplacementBeforeExactScopeStore({
      space: 'personal',
      now: '2099-08-05T12:00:00.000Z',
      notes: [],
    })
    const composition = createStoreRoleLibrary(() => Promise.resolve(store))
    const library = writableLibrary(composition)
    const original = rolePackage('wanted')

    await expect(library.putIfAbsent(PROJECT, original)).resolves.toBe(true)
    const captured = await library.captureExactPackage(PROJECT, original.directoryName)

    expect(captured).toMatchObject({ kind: 'role' })
    store.replaceBeforeNextExactScope(async () => {
      const current = await store.read(original.directoryName)
      const replacement = packageOf('wanted', 'Replacement skill body.')
      const manifest = replacement.files.get('SKILL.md')!
      const state = analyzeDocumentState({
        source: manifest,
        role: DOCUMENT_ROLE.skillRoot,
        pathFallbackTitle: 'SKILL',
        skillDirectoryName: original.directoryName,
      })
      const projection = state.projection

      expect(projection).not.toBeNull()
      await store.write({
        id: original.directoryName,
        originalId: original.directoryName,
        versionToken: current.versionToken,
        title: projection!.title,
        content: projection!.body,
        frontmatter: projection!.frontmatterEntries,
        frontmatterMode: 'replace',
        targetClass: NOTE_CLASS.skill,
        restorePath: current.filePath!,
      })
    })
    const publisher = await composition.publication.publicationFor(PERSONAL)
    const beforeMove = vi.fn(async () => undefined)
    const finalize = vi.fn(async () => undefined)

    await expect(
      publisher!.moveFrom(PROJECT, original.directoryName, captured!, {
        beforeMove,
        finalize,
        rollback: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(AbilityUnavailableError)
    expect(beforeMove).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
    await expect(library.getByDirectory(PERSONAL, original.directoryName)).resolves.toBeNull()
    const replacement = await library.getByDirectory(PROJECT, original.directoryName)

    expect(Buffer.from(replacement!.files.get('SKILL.md')!).toString('utf8')).not.toContain(
      'notarium.kind: role',
    )
  })
})
