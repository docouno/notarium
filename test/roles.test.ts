import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import type { Ctx } from '../packages/server/src/services/mcp/gateway'
import { activateRole } from '../packages/server/src/services/mcp/tools/roles'
import {
  createInMemoryRoleLibrary,
  createRolesService,
  loadBuiltinRoleCatalog,
  packageRevision,
  parseRoleContextTarget,
  parseSkillFile,
  RoleAlreadyExistsError,
  roleContextTargetOf,
  RoleDependencyConflictError,
  type SkillPackage,
  withBuiltinProvenance,
} from '../packages/server/src/services/roles'

const pkg = (name: string, description: string, body: string): SkillPackage => ({
  name,
  files: new Map([
    [
      'SKILL.md',
      Buffer.from(
        `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  notarium.kind: role\n---\n\n${body}`,
      ),
    ],
  ]),
})

const skillPkg = (name: string, description: string, body = ''): SkillPackage => ({
  name,
  files: new Map([
    ['SKILL.md', Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`)],
  ]),
})

describe('role catalog and owned libraries', () => {
  it('does not persist a session role when context assembly fails', async () => {
    const setRole = vi.fn()
    const contextFailure = new Error('context store unavailable')
    const ctx = {
      roles: {},
      agentSessions: { setRole },
      session: {},
      personalSpace: () => Promise.reject(contextFailure),
    } as unknown as Ctx

    await expect(
      activateRole(ctx, { personalSpace: 'personal' }, 'research', 4_000, {
        role: {
          name: 'research',
          description: 'Research.',
          instructions: 'Research carefully.',
          scope: 'personal',
        },
        skills: [],
        truncated: false,
        location: { scope: 'personal', space: 'personal' },
      }),
    ).rejects.toBe(contextFailure)
    expect(setRole).not.toHaveBeenCalled()
  })

  it('derives one reversible stable context target per exact owned placement', () => {
    const personal = roleContextTargetOf({
      role: { name: 'research' },
      location: { scope: 'personal', space: 'space:one' },
    })
    const project = roleContextTargetOf({
      role: { name: 'research' },
      location: { scope: 'project', space: 'shared', projectId: 'project:one' },
    })

    expect(personal.id).not.toBe(project.id)
    expect(parseRoleContextTarget(personal.id)).toEqual({
      scope: 'personal',
      ownerId: 'space:one',
      name: 'research',
    })
    expect(parseRoleContextTarget(project.id)).toEqual({
      scope: 'project',
      ownerId: 'project:one',
      name: 'research',
    })
    expect(parseRoleContextTarget('project:broken')).toBeNull()
  })

  it('keeps built-ins discovery-only until Add copies a role and its linked skill', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({ catalog: loadBuiltinRoleCatalog, library })
    const context = { personalSpace: 'space-personal' }

    expect((await roles.listCatalog()).map(({ name }) => name)).toEqual(['grooming', 'research'])
    expect(await roles.listEffective(context)).toEqual({ roles: [], truncated: false })
    expect(await roles.loadCatalog('grooming', 4_000)).toMatchObject({
      role: {
        name: 'grooming',
        scope: 'catalog',
        instructions: expect.stringContaining('# Grooming'),
      },
      skills: [{ name: 'grooming-evidence' }],
      truncated: false,
    })

    const added = await roles.addFromCatalog('grooming', {
      scope: 'personal',
      space: 'space-personal',
    })
    expect(added).toMatchObject({
      name: 'grooming',
      scope: 'personal',
      origin: 'builtin:grooming',
    })
    expect(added.originRevision).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(await roles.listEffective(context)).toEqual({
      roles: [expect.objectContaining({ name: 'grooming', scope: 'personal' })],
      truncated: false,
    })
    expect(await roles.loadEffective(context, 'grooming', 4_000)).toMatchObject({
      role: { name: 'grooming' },
      location: { scope: 'personal', space: 'space-personal' },
      skills: [{ name: 'grooming-evidence' }],
      truncated: false,
    })
    expect(
      await roles.loadAt({ scope: 'personal', space: 'space-personal' }, 'grooming', 4_000),
    ).toMatchObject({
      role: { name: 'grooming', scope: 'personal' },
      skills: [{ name: 'grooming-evidence' }],
    })
  })

  it('never overwrites an owned fork and lets a project fork shadow personal', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({ catalog: loadBuiltinRoleCatalog, library })
    const personal = { scope: 'personal' as const, space: 'personal' }
    const project = { scope: 'project' as const, space: 'shared', projectId: 'project-a' }

    await roles.addFromCatalog('grooming', personal)
    await expect(roles.addFromCatalog('grooming', personal)).rejects.toBeInstanceOf(
      RoleAlreadyExistsError,
    )
    await library.putIfAbsent(project, pkg('grooming', 'Project wording.', 'Project rules win.'))

    expect(
      await roles.loadEffective(
        {
          personalSpace: 'personal',
          project: {
            id: 'project-a',
            space: 'shared',
            path: 'a',
            slug: 'a',
            aliases: [],
            pathAliases: [],
            displayName: 'A',
            status: 'active',
            createdAt: 'x',
            lastSeen: 'x',
          },
        },
        'grooming',
        4_000,
      ),
    ).toMatchObject({
      role: {
        scope: 'project',
        description: 'Project wording.',
        instructions: 'Project rules win.',
      },
      location: project,
    })
    expect(await roles.loadAt(personal, 'grooming', 4_000)).toMatchObject({
      role: { scope: 'personal', instructions: expect.not.stringContaining('Project rules win.') },
    })
    expect(await roles.loadAt(project, 'grooming', 4_000)).toMatchObject({
      role: { scope: 'project', instructions: 'Project rules win.' },
    })
  })

  it('rejects a linked-skill collision instead of binding a role to different bytes', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({ catalog: loadBuiltinRoleCatalog, library })
    const personal = { scope: 'personal' as const, space: 'personal' }
    await library.putIfAbsent(personal, {
      name: 'grooming-evidence',
      files: new Map([
        [
          'SKILL.md',
          Buffer.from(
            '---\nname: grooming-evidence\ndescription: Different owned skill.\n---\n\nDo something else.',
          ),
        ],
      ]),
    })

    await expect(roles.addFromCatalog('grooming', personal)).rejects.toBeInstanceOf(
      RoleDependencyConflictError,
    )
    expect(await library.get(personal, 'grooming')).toBeNull()
    expect(
      Buffer.from(
        (await library.get(personal, 'grooming-evidence'))!.files.get('SKILL.md')!,
      ).toString('utf8'),
    ).toContain('Different owned skill')
  })

  it('reports truncation instead of silently exceeding the requested budget', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({ catalog: async () => [], library })
    await library.putIfAbsent(
      { scope: 'personal', space: 'personal' },
      pkg('long-role', 'Long role.', 'x'.repeat(1_000)),
    )

    const loaded = await roles.loadEffective({ personalSpace: 'personal' }, 'long-role', 100)
    expect(loaded!.role.instructions.length).toBeLessThanOrEqual(400)
    expect(loaded!.role.instructions.length).toBeGreaterThan(0)
    expect(loaded?.truncated).toBe(true)
  })

  it('budgets linked names and descriptions even when their instruction bodies are empty', async () => {
    const library = createInMemoryRoleLibrary()
    const dependencies = Array.from({ length: 8 }, (_, index) =>
      skillPkg(`support-${index}`, `Supporting description ${index} ${'x'.repeat(80)}`),
    )
    const role = pkg('bounded-role', 'Bounded role.', '')
    const links = dependencies.map((dependency) => `[[${dependency.name}]]`).join(' ')
    role.files.set(
      'SKILL.md',
      Buffer.from(
        `---\nname: bounded-role\ndescription: Bounded role.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "${links}"\n---\n`,
      ),
    )
    const roles = createRolesService({ catalog: async () => [role, ...dependencies], library })
    const loaded = await roles.loadCatalog('bounded-role', 100)
    const returnedCharacters =
      loaded!.role.name.length +
      loaded!.role.description.length +
      loaded!.role.instructions.length +
      loaded!.skills.reduce(
        (total, skill) =>
          total + skill.name.length + skill.description.length + skill.instructions.length,
        0,
      )

    expect(returnedCharacters).toBeLessThanOrEqual(400)
    expect(loaded?.skills.length).toBeLessThan(dependencies.length)
    expect(loaded?.truncated).toBe(true)
  })

  it('forks every file in a complete Agent Skills package', async () => {
    const library = createInMemoryRoleLibrary()
    const role = pkg('resource-role', 'Resource role.', 'Instructions.')
    role.files.set('scripts/run.sh', Buffer.from('#!/bin/sh\necho safe-copy\n'))
    role.files.set('references/guide.md', Buffer.from('# Guide\n\nSupporting evidence.'))
    role.files.set('assets/template.bin', Buffer.from([0, 1, 2, 255]))
    const roles = createRolesService({ catalog: async () => [role], library })
    const location = { scope: 'personal' as const, space: 'personal' }

    await expect(roles.listCatalog()).resolves.toEqual([
      expect.objectContaining({ name: 'resource-role' }),
    ])
    await roles.addFromCatalog('resource-role', location)
    const installed = await library.get(location, 'resource-role')

    expect([...installed!.files.keys()].sort()).toEqual([
      'SKILL.md',
      'assets/template.bin',
      'references/guide.md',
      'scripts/run.sh',
    ])
    expect(Buffer.from(installed!.files.get('scripts/run.sh')!)).toEqual(
      Buffer.from(role.files.get('scripts/run.sh')!),
    )
    expect(Buffer.from(installed!.files.get('references/guide.md')!)).toEqual(
      Buffer.from(role.files.get('references/guide.md')!),
    )
    expect(Buffer.from(installed!.files.get('assets/template.bin')!)).toEqual(
      Buffer.from(role.files.get('assets/template.bin')!),
    )
    expect(Buffer.from(installed!.files.get('SKILL.md')!).toString('utf8')).toContain(
      'notarium.origin: builtin:resource-role',
    )
  })

  it('does not expose arbitrary owned provenance as trusted built-in ancestry', async () => {
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({ catalog: async () => [], library })
    const location = { scope: 'personal' as const, space: 'personal' }
    const hostile = pkg('claimed-role', 'Claimed role.', 'Instructions.')
    hostile.files.set(
      'SKILL.md',
      Buffer.from(
        '---\nname: claimed-role\ndescription: Claimed role.\nmetadata:\n  notarium.kind: role\n  notarium.origin: builtin:someone-else\n  notarium.originRevision: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n\nInstructions.',
      ),
    )
    await library.putIfAbsent(location, hostile)

    const [summary] = (await roles.listEffective({ personalSpace: 'personal' })).roles
    expect(summary).toMatchObject({ name: 'claimed-role', scope: 'personal' })
    expect(summary).not.toHaveProperty('origin')
    expect(summary).not.toHaveProperty('originRevision')
  })

  it('frames package revision fields so NUL bytes cannot create an ambiguous digest', () => {
    const skill = Buffer.from('---\nname: framed\ndescription: Framed.\n---\n')
    const oneFile = new Map<string, Uint8Array>([
      ['SKILL.md', skill],
      ['a', Buffer.from('x\0b\0y')],
    ])
    const twoFiles = new Map<string, Uint8Array>([
      ['SKILL.md', skill],
      ['a', Buffer.from('x')],
      ['b', Buffer.from('y')],
    ])

    expect(packageRevision(oneFile)).not.toBe(packageRevision(twoFiles))
  })

  it('activates an exact known role outside a truncated discovery window', async () => {
    const backing = createInMemoryRoleLibrary()
    const location = { scope: 'personal' as const, space: 'personal' }
    await backing.putIfAbsent(location, pkg('known-role', 'Known role.', 'Direct instructions.'))
    const roles = createRolesService({
      catalog: async () => [],
      library: {
        ...backing,
        listManifests: async () => ({ packages: [], truncated: true }),
      },
    })

    await expect(roles.listEffective({ personalSpace: 'personal' })).resolves.toEqual({
      roles: [],
      truncated: true,
    })
    await expect(
      roles.loadEffective({ personalSpace: 'personal' }, 'known-role', 4_000),
    ).resolves.toMatchObject({
      role: { name: 'known-role', scope: 'personal', instructions: 'Direct instructions.' },
    })
  })

  it('stops progressive linked-skill reads when the role consumes the output budget', async () => {
    const backing = createInMemoryRoleLibrary()
    const location = { scope: 'personal' as const, space: 'personal' }
    const role = pkg('progressive-role', 'Progressive role.', 'x'.repeat(1_000))
    role.files.set(
      'SKILL.md',
      Buffer.from(
        `---\nname: progressive-role\ndescription: Progressive role.\nmetadata:\n  notarium.kind: role\n  notarium.skills: "[[support-one]] [[support-two]]"\n---\n\n${'x'.repeat(1_000)}`,
      ),
    )
    await backing.putIfAbsent(location, role)
    await backing.putIfAbsent(location, skillPkg('support-one', 'First support.', 'First body.'))
    await backing.putIfAbsent(location, skillPkg('support-two', 'Second support.', 'Second body.'))
    const reads: string[] = []
    const roles = createRolesService({
      catalog: async () => [],
      library: {
        ...backing,
        getSkill: async (where, name) => {
          reads.push(name)
          return backing.getSkill(where, name)
        },
      },
    })

    await expect(
      roles.loadEffective({ personalSpace: 'personal' }, 'progressive-role', 100),
    ).resolves.toMatchObject({ truncated: true, skills: [] })
    expect(reads).toEqual(['progressive-role'])
  })

  it('rejects a catalog manifest whose owned provenance rewrite would exceed the shared bound', async () => {
    const name = 'near-limit'
    const revision = `sha256:${'a'.repeat(64)}`
    let source = ''

    for (let padding = 15_500; padding < 16_384; padding++) {
      const candidate = `---\nname: ${name}\ndescription: Near limit.\nmetadata:\n  notarium.kind: role\n  padding: ${'x'.repeat(padding)}\n---\n`

      try {
        parseSkillFile(candidate, name)
        parseSkillFile(withBuiltinProvenance(candidate, name, revision), name)
      } catch {
        try {
          parseSkillFile(candidate, name)
          source = candidate
          break
        } catch {
          // The source itself crossed the bound; keep searching is pointless.
          break
        }
      }
    }
    expect(source).not.toBe('')
    const roles = createRolesService({
      catalog: async () => [{ name, files: new Map([['SKILL.md', Buffer.from(source)]]) }],
      library: createInMemoryRoleLibrary(),
    })

    await expect(roles.listCatalog()).rejects.toThrow(/frontmatter is too large/)
  })

  it('rejects a catalog package whose provenance rewrite would cross the package bound', async () => {
    const role = pkg('package-limit', 'Package limit.', 'Instructions.')
    const skillBytes = role.files.get('SKILL.md')!.byteLength
    role.files.set('assets/fill.bin', Buffer.alloc(8 * 1024 * 1024 - skillBytes))
    const library = createInMemoryRoleLibrary()
    const roles = createRolesService({ catalog: async () => [role], library })

    await expect(roles.listCatalog()).rejects.toThrow(/package is too large/)
    await expect(
      library.get({ scope: 'personal', space: 'personal' }, 'package-limit'),
    ).resolves.toBeNull()
  })
})
