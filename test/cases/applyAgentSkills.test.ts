import { describe, expect, it, vi } from 'vitest'
import { analyzeDocumentState, DOCUMENT_ROLE, type KnowledgeStore } from '@notarium/core'
import type { RoleLibrary, RolesService } from '@notarium/server'

import { applyAgentSkillDeclarations } from './applyAgentSkills'

describe('Agent Skill seed applier', () => {
  it('derives a configured package root from the live note instead of a default mount literal', async () => {
    const noteId = 'AbCdefGhij_1'
    const raw = `---\nnotarium-id: ${noteId}\nname: mount-proof\ndescription: Mount proof.\n---\n\n`
    const documentState = analyzeDocumentState({
      source: new TextEncoder().encode(raw),
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: noteId,
    })
    const write = vi.fn(async () => ({ id: noteId }))
    const removeDir = vi.fn(async () => undefined)
    const store = {
      read: vi.fn(async () => ({
        id: noteId,
        title: 'mount-proof',
        class: 'skill',
        filePath: `.roles-library/${noteId}/SKILL.md`,
        content: '',
        frontmatter: { name: 'mount-proof', description: 'Mount proof.' },
        documentState,
        versionToken: 'seed-version',
      })),
      write,
      removeDir,
    } as unknown as KnowledgeStore
    const roles = {
      createCustomSkill: vi.fn(async () => ({ noteId })),
    } as unknown as RolesService

    await applyAgentSkillDeclarations({
      declarations: [
        {
          name: 'mount-proof',
          description: 'Mount proof.',
          instructions: 'Check the configured mount.',
          deleted: true,
          home: { kind: 'space', space: 'main' },
        },
      ],
      roles,
      library: {} as RoleLibrary,
      resolveLocation: async () => ({
        role: { scope: 'space', space: 'space-id' },
        skill: { scope: 'space', space: 'space-id' },
      }),
      storeForSpace: async () => store,
    })

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({ originalId: noteId, preservePath: true }),
    )
    expect(removeDir).toHaveBeenCalledWith(`.roles-library/${noteId}`, {
      internalAddress: true,
      principal: 'seed',
    })
  })

  it('forks a catalog skill once and keeps its explicit selected-project policy', async () => {
    const noteId = 'CatalogSkill_1'
    const raw = `---\nnotarium-id: ${noteId}\nname: catalog-proof\ndescription: Catalog proof.\n---\n\nKeep catalog instructions.\n`
    const documentState = analyzeDocumentState({
      source: new TextEncoder().encode(raw),
      role: DOCUMENT_ROLE.skillRoot,
      skillDirectoryName: noteId,
    })
    const store = {
      read: vi.fn(async () => ({
        id: noteId,
        title: 'catalog-proof',
        class: 'skill',
        filePath: `.notarium/skills/${noteId}/SKILL.md`,
        content: 'Keep catalog instructions.',
        frontmatter: { name: 'catalog-proof', description: 'Catalog proof.' },
        documentState,
        versionToken: 'seed-version',
      })),
      write: vi.fn(async () => ({ id: noteId })),
    } as unknown as KnowledgeStore
    const addSkillFromCatalog = vi.fn(async () => ({ noteId }))
    const roles = { addSkillFromCatalog } as unknown as RolesService
    const availability = { mode: 'selected-projects' as const, projectIds: ['alpha', 'beta'] }

    await applyAgentSkillDeclarations({
      declarations: [
        {
          source: 'catalog',
          name: 'catalog-proof',
          home: { kind: 'space', space: 'team' },
          availability: {
            mode: 'selected-projects',
            projects: [
              { space: 'team', path: 'alpha' },
              { space: 'team', path: 'beta' },
            ],
          },
        },
      ],
      roles,
      library: {} as RoleLibrary,
      resolveLocation: async () => ({
        role: { scope: 'space', space: 'team-id' },
        skill: { scope: 'space', space: 'team-id' },
        availability,
      }),
      storeForSpace: async () => store,
    })

    expect(addSkillFromCatalog).toHaveBeenCalledWith(
      'catalog-proof',
      { scope: 'space', space: 'team-id' },
      availability,
    )
    expect(store.write).toHaveBeenCalledWith(
      expect.objectContaining({
        originalId: noteId,
        content: 'Keep catalog instructions.',
      }),
    )
  })
})
