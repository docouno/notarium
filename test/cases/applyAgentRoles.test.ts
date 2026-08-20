import { describe, expect, it, vi } from 'vitest'
import type { KnowledgeStore } from '@notarium/core'
import type { RolesService } from '@notarium/server'

import { applyAgentRoleDeclarations } from './applyAgentRoles'

describe('Agent Role seed applier', () => {
  it('creates the authored role body and deletes the exact published package', async () => {
    const noteId = 'CustomRole_1'
    const instructions = '# Release captain\n\n' + 'Keep the whole prompt. '.repeat(100)
    const createCustomRole = vi.fn(async () => ({
      name: 'release-captain',
      description: 'Release role.',
      scope: 'personal' as const,
      space: 'personal-id',
      packageId: noteId,
      noteId,
    }))
    const removeDir = vi.fn(async () => undefined)
    const store = {
      read: vi.fn(async () => ({
        id: noteId,
        filePath: `.notarium/skills/${noteId}/SKILL.md`,
      })),
      removeDir,
    } as unknown as KnowledgeStore

    await applyAgentRoleDeclarations({
      declarations: [
        {
          source: 'custom',
          name: 'release-captain',
          description: 'Release role.',
          instructions,
          deleted: true,
          target: { kind: 'personal', user: 'maya' },
        },
      ],
      roles: { createCustomRole } as unknown as RolesService,
      resolveLocation: async () => ({
        location: { scope: 'personal', space: 'personal-id' },
        personalSpace: 'personal-id',
      }),
      storeForSpace: async () => store,
    })

    expect(createCustomRole).toHaveBeenCalledWith(
      'release-captain',
      'Release role.',
      instructions,
      { scope: 'personal', space: 'personal-id' },
      { personalSpace: 'personal-id' },
    )
    expect(removeDir).toHaveBeenCalledWith(`.notarium/skills/${noteId}`, {
      internalAddress: true,
      principal: 'seed',
    })
  })

  it('injects a legacy malformed attachment through the normal note write seam', async () => {
    const noteId = 'LegacyRole_1'
    const createCustomRole = vi.fn(async () => ({
      name: 'legacy-role',
      description: 'Legacy role.',
      scope: 'personal' as const,
      space: 'personal-id',
      packageId: noteId,
      noteId,
    }))
    const write = vi.fn(async () => ({ id: noteId, versionToken: 'v2' }))
    const store = {
      read: vi.fn(async () => ({
        id: noteId,
        title: 'legacy-role',
        content: 'Legacy body.',
        versionToken: 'v1',
        documentState: {
          projection: {
            frontmatterEntries: [
              { key: 'metadata', lines: ['metadata:', '  notarium.kind: role'] },
            ],
          },
        },
      })),
      write,
    } as unknown as KnowledgeStore

    await applyAgentRoleDeclarations({
      declarations: [
        {
          source: 'custom',
          name: 'legacy-role',
          description: 'Legacy role.',
          instructions: 'Legacy body.',
          invalidAttachment: '[[notarium-id:space:broken|legacy-helper]]',
          target: { kind: 'personal', user: 'maya' },
        },
      ],
      roles: { createCustomRole } as unknown as RolesService,
      resolveLocation: async () => ({
        location: { scope: 'personal', space: 'personal-id' },
        personalSpace: 'personal-id',
      }),
      storeForSpace: async () => store,
    })

    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        originalId: noteId,
        versionToken: 'v1',
        preservePath: true,
        frontmatter: [
          expect.objectContaining({
            key: 'metadata',
            lines: expect.arrayContaining([
              expect.stringContaining(
                'notarium.skills: "[[notarium-id:space:broken|legacy-helper]]"',
              ),
            ]),
          }),
        ],
      }),
    )
  })

  // The seam production answers with `peekPersonalSpace` on every publish. It decides
  // where a role's dependencies LIVE (`homeOf`): Personal is the root of
  // its own space, so a role placed in a PROJECT of a personal space takes personal
  // skills. Answering `null` here — which both seeders did — made the Add install its
  // supporting package under a Space root that space does not have, and serialise the
  // role's only link as `[[notarium-id:space:…]]`, an address `ownedPlacementOf`
  // refuses. The seed still finished, so the stand shipped a published role whose
  // dependency nothing could read.
  it('hands the placement owner’s personal space to the Add, not a null', async () => {
    const addFromCatalog = vi.fn(async () => ({
      name: 'grooming',
      description: 'Groom the backlog.',
      scope: 'project' as const,
      space: 'maya-home-id',
      projectId: 'work-id',
      packageId: 'GroomingPkg1',
      noteId: 'GroomingPkg1',
    }))

    await applyAgentRoleDeclarations({
      declarations: [
        { name: 'grooming', target: { kind: 'project', space: 'maya-home', path: 'work' } },
      ],
      roles: { addFromCatalog } as unknown as RolesService,
      resolveLocation: async () => ({
        location: { scope: 'project', space: 'maya-home-id', projectId: 'work-id' },
        personalSpace: 'maya-home-id',
      }),
      storeForSpace: async () => ({}) as unknown as KnowledgeStore,
    })

    expect(addFromCatalog).toHaveBeenCalledWith(
      'grooming',
      { scope: 'project', space: 'maya-home-id', projectId: 'work-id' },
      'maya-home-id',
    )
  })

  it('refuses a catalog declaration that carries reach the Add path cannot express', async () => {
    const addFromCatalog = vi.fn()

    await expect(
      applyAgentRoleDeclarations({
        declarations: [
          {
            name: 'grooming',
            target: { kind: 'space', space: 'team' },
            availability: {
              mode: 'selected-projects',
              projects: [{ space: 'team', path: 'alpha' }],
            },
          },
        ],
        roles: { addFromCatalog } as unknown as RolesService,
        resolveLocation: async () => ({
          location: { scope: 'space', space: 'team-id' },
          personalSpace: null,
          availability: { mode: 'selected-projects', projectIds: ['alpha-id'] },
        }),
        storeForSpace: async () => ({}) as unknown as KnowledgeStore,
      }),
    ).rejects.toThrow(/Catalog Add cannot carry/)
    expect(addFromCatalog).not.toHaveBeenCalled()
  })

  it('attaches an earlier role as an exact locator, which is what wrong-kind needs', async () => {
    const created = [
      { name: 'research', packageId: 'ResearchRol1', noteId: 'ResearchRol1' },
      { name: 'evidence-lead', packageId: 'EvidenceLed1', noteId: 'EvidenceLed1' },
    ]
    const createCustomRole = vi.fn(async () => ({
      ...created.shift()!,
      description: 'Role.',
      scope: 'personal' as const,
      space: 'personal-id',
    }))
    const write = vi.fn(async () => ({ id: 'EvidenceLed1', versionToken: 'v2' }))
    const store = {
      read: vi.fn(async () => ({
        id: 'EvidenceLed1',
        title: 'evidence-lead',
        content: 'Body.',
        versionToken: 'v1',
        documentState: {
          projection: {
            frontmatterEntries: [
              { key: 'metadata', lines: ['metadata:', '  notarium.kind: role'] },
            ],
          },
        },
      })),
      write,
    } as unknown as KnowledgeStore
    const role = (name: string, attachRole?: string) => ({
      source: 'custom' as const,
      name,
      description: 'Role.',
      instructions: `# ${name}`,
      target: { kind: 'personal' as const, user: 'maya' },
      ...(attachRole ? { attachRole } : {}),
    })

    const published = await applyAgentRoleDeclarations({
      declarations: [role('research'), role('evidence-lead', 'research')],
      roles: { createCustomRole } as unknown as RolesService,
      resolveLocation: async () => ({
        location: { scope: 'personal', space: 'personal-id' },
        personalSpace: 'personal-id',
      }),
      storeForSpace: async () => store,
    })

    expect(published.map((entry) => entry.packageId)).toEqual(['ResearchRol1', 'EvidenceLed1'])
    expect(write).toHaveBeenCalledWith(
      expect.objectContaining({
        frontmatter: [
          expect.objectContaining({
            lines: expect.arrayContaining([
              expect.stringContaining(
                'notarium.skills: "[[notarium-id:personal:ResearchRol1|research]]"',
              ),
            ]),
          }),
        ],
      }),
    )
  })
})
