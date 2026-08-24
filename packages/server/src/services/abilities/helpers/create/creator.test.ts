import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ABILITY_AVAILABILITY_MODE } from '@notarium/contract'
import {
  analyzeDocumentState,
  CachedStore,
  DOCUMENT_ROLE,
  NOTE_CLASS,
  type PublishedResourceEvidence,
} from '@notarium/core'
import {
  createNotariumStore,
  ensureNotariumResourceAuthority,
  NotariumStoreCompositionOwner,
  renameNoReplaceIfAvailable,
  SpaceResourceAuthorityRegistry,
} from '@notarium/engine'

import type { Principal } from '../../../authz'
import { type AbilityCreatePersistence, SqliteMetaDb } from '../../../metaDb'
import {
  createFsRoleLibrary,
  createRolesService,
  loadBundledAbilityInventory,
} from '../../../roles'
import { SpaceManager, type SpaceStore } from '../../../spaces'
import type { PreparedAbilityCreate } from '../../types'
import { DurableAbilityCreator } from './creator'

const SPACE = 'space-main'
const SKILL_PREFIX = '.notarium/skills'

const principal: Principal = {
  id: 'pat:agent:creator-test',
  username: 'alice',
  admin: false,
  scope: 'write',
  grants: new Map([[SPACE, 'writer']]),
  spaces: new Set([SPACE]),
  system: false,
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

describe('DurableAbilityCreator — crash cuts over real FS + SQLite', () => {
  let root: string
  let db: SqliteMetaDb

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'notarium-ability-create-'))
    db = new SqliteMetaDb(join(root, 'meta.db'))
    await db.spaces.upsert({
      id: SPACE,
      slug: 'main',
      displayName: 'Main',
      notesDir: 'main',
      aliases: [],
      createdAt: '2026-08-22T12:00:00.000Z',
      archivedAt: null,
      archivedBy: null,
    })
  })

  afterEach(async () => {
    await db.close()
    await rm(root, { recursive: true, force: true })
  })

  const world = async (
    mode:
      | 'before-commit'
      | 'lost-ack'
      | 'finalize-outage'
      | 'identity-order'
      | 'projection-order'
      | 'lock-order'
      | 'lifecycle-closing'
      | 'accepted-crash'
      | 'legacy-system-policy',
    options: {
      name?: string
      systemNamePolicy?: 'allow' | 'reject'
    } = {},
  ) => {
    const skillRoot = join(root, 'skills')
    const registry = new SpaceResourceAuthorityRegistry()
    const compositions = new NotariumStoreCompositionOwner()
    const authority = ensureNotariumResourceAuthority({
      spaceId: SPACE,
      resourceAuthorityRegistry: registry,
      composition: compositions.getOrCreate(SPACE, [
        { class: 'skill', dir: skillRoot, prefix: SKILL_PREFIX },
      ]),
    })
    const library = createFsRoleLibrary({
      rootForSpace: (space) => (space === SPACE ? skillRoot : null),
      resourcePrefixForSpace: (space) => (space === SPACE ? SKILL_PREFIX : null),
      authorityForSpace: async (space) => (space === SPACE ? authority : null),
      publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
    })
    const roles = createRolesService({
      catalog: loadBundledAbilityInventory,
      ...library,
      abilityAvailability: db.abilityAvailability,
      abilityPreferences: db.abilityPreferences,
      abilityPlacement: db.abilityPlacement,
    })
    const location = roles.resolveOwnedPlacement({ scope: 'space', space: SPACE }, null)!
    const prepared = {
      kind: 'skill',
      source: 'custom',
      body: {
        name: options.name ?? 'durable-proof',
        description: 'Prove durable ability publication.',
        instructions: '# Durable proof\n\nThe exact body.',
        scope: 'space',
        space: 'main',
        availability: { mode: 'all-projects' },
      },
      principal,
      personalSpace: null,
      location,
      availability: { mode: ABILITY_AVAILABILITY_MODE.allProjects },
    } as Extract<PreparedAbilityCreate, { source: 'custom' }>
    let armed = true
    let identityPrimed = false
    let projectionEntered = false
    let projectionAdopted = false
    const globalRequested = deferred()
    const placementRequested = deferred()
    const releaseOrdinaryGlobal = deferred()
    const publishStrictAdmitted = authority.publishStrictAdmitted.bind(authority)
    const admitSkillPlacement = authority.admitSkillPlacement.bind(authority)

    authority.publishStrictAdmitted = async (...args) => {
      if (mode === 'identity-order' && !identityPrimed) {
        throw new Error('physical publication preceded warm identity priming')
      }

      return publishStrictAdmitted(...args)
    }
    authority.admitSkillPlacement = async (...args) => {
      if (mode === 'lock-order' && args[2] === 'ability-create-placement') {
        placementRequested.resolve()
      }

      return admitSkillPlacement(...args)
    }
    const projectedState = (evidence: PublishedResourceEvidence) => {
      const packageId = evidence.path.split('/').at(-2)

      if (!packageId) {
        throw new Error('published skill path has no package id')
      }

      return analyzeDocumentState({
        source: evidence.source,
        role: DOCUMENT_ROLE.skillRoot,
        skillDirectoryName: packageId,
        ownerProof: evidence.ownerProof,
      })
    }
    const manager =
      mode === 'lifecycle-closing'
        ? new SpaceManager({
            spaces: [],
            createStore: () =>
              ({
                beginCausalPublication: async () => () => {},
                primeCommittedIdentity: async () => {},
                confirmCommittedIdentity: async () => {},
                releasePrimedIdentity: async () => {},
                adoptPublishedResource: async (evidence: PublishedResourceEvidence) =>
                  projectedState(evidence),
                reconcile: async () => {},
                identityReady: async () => {},
              }) as unknown as SpaceStore,
            metaDb: db,
          })
        : null

    await manager?.init()
    const persistence: AbilityCreatePersistence = {
      ...db.abilityCreate,
      accept: async (input) => {
        if (mode === 'projection-order' && !projectionEntered) {
          throw new Error('ability acceptance preceded causal projection admission')
        }
        const accepted =
          mode !== 'legacy-system-policy'
            ? await db.abilityCreate.accept(input)
            : await (async () => {
                const evidence = JSON.parse(input.preparedEvidence) as Record<string, unknown>

                delete evidence.systemNamePolicy
                return db.abilityCreate.accept({
                  ...input,
                  preparedEvidence: JSON.stringify(evidence),
                })
              })()

        if (mode === 'lifecycle-closing' && manager && accepted.status === 'accepted') {
          await authority.closeAdmission({ owner: 'archive-race' })
          await manager.archive(input.space).then(
            () => {
              throw new Error('accepted ability operation did not pin lifecycle closing')
            },
            (error: unknown) => {
              if ((error as { reason?: string }).reason !== 'space_busy') {
                throw error
              }
            },
          )
        }

        return accepted
      },
      commit: async (input) => {
        if (armed && mode === 'before-commit') {
          armed = false
          throw new Error('injected terminal outage')
        }
        if (mode === 'projection-order' && !projectionAdopted) {
          throw new Error('terminal metadata preceded exact projection adoption')
        }
        const result = await db.abilityCreate.commit(input)

        if (armed && mode === 'lost-ack') {
          armed = false
          throw new Error('injected lost acknowledgement')
        }

        return result
      },
      finalize: async (...args) => {
        if (armed && mode === 'finalize-outage') {
          armed = false
          throw new Error('injected cleanup acknowledgement outage')
        }

        return db.abilityCreate.finalize(...args)
      },
    }
    const creator = new DurableAbilityCreator({
      persistence,
      roles,
      authorityForSpace: (() => {
        let lookups = 0

        return async (space: string) => {
          lookups++
          if (mode === 'accepted-crash' && lookups > 1) {
            throw new Error('simulated process exit after durable acceptance')
          }

          return space === SPACE ? authority : null
        }
      })(),
      beginProjection: async (space, operationId) => {
        if (mode === 'lock-order') {
          globalRequested.resolve()
          await releaseOrdinaryGlobal.promise
        }
        if (manager) {
          return manager.beginCausalPublication(space, {
            kind: 'ability-create',
            operationId,
          })
        }
        projectionEntered = true
        return () => {
          projectionEntered = false
        }
      },
      primeIdentity: manager
        ? (space, record) => manager.primeWarmCausalIdentity(space, record)
        : async () => {
            identityPrimed = true
          },
      adoptPublication: async (_space, evidence) => {
        if (manager) {
          return manager.adoptCausalPublication(_space, evidence)
        }
        if (mode === 'projection-order' && !projectionEntered) {
          throw new Error('exact projection adoption escaped its admission lease')
        }
        projectionAdopted = true
        return projectedState(evidence)
      },
      reconcile: manager
        ? (space, noteId) => manager.reconcileCausalProjection(space, noteId)
        : async () => undefined,
      operationId: () => 'ability-operation-1',
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      onError: () => undefined,
    })
    let packageAvailable = true
    const preparePackage = vi.fn(async () => {
      if (!packageAvailable) {
        throw new Error('attachment disappeared before retry')
      }

      return {
        prepared,
        pkg: roles.prepareCustomSkill(
          prepared.body.name,
          prepared.body.description,
          prepared.body.instructions,
        ),
      }
    })
    const create = () =>
      creator.createDurably({
        prepared,
        attribution: {
          principal: principal.id,
          agent: {
            owner: 'alice',
            agent: 'Codex',
            session: { id: 'session-one', name: 'V8', attach: 'declared' },
          },
        },
        preparePackage,
        operation: {
          idempotencyKey: 'same-request',
          scopeKey: 'space-main/skill',
          systemNamePolicy: options.systemNamePolicy ?? 'reject',
        },
      })

    return {
      authority,
      create,
      creator,
      skillRoot,
      manager,
      preparePackage,
      removeAttachment: () => {
        packageAvailable = false
      },
      lockOrder: { globalRequested, placementRequested, releaseOrdinaryGlobal },
    }
  }

  it('keeps a pre-terminal physical publish fenced, then recovers one attributed origin', async () => {
    const { authority, create, creator, skillRoot } = await world('before-commit')

    await expect(create()).rejects.toThrow('injected terminal outage')
    const [pending] = await db.abilityCreate.listRecoverable()

    expect(pending).toMatchObject({
      phase: 'failed-recoverable',
      packageId: expect.any(String),
      noteId: expect.any(String),
    })
    expect(
      (await db.revisions.listByNote(SPACE, pending.noteId, { offset: 0, limit: 10 })).total,
    ).toBe(0)
    await expect(
      authority.observe(pending.targetPath, { packagePath: join(SKILL_PREFIX, pending.packageId) }),
    ).rejects.toThrow(/admission is closed/i)

    await creator.recover()
    const replay = await create()
    const rows = await db.revisions.listByNote(SPACE, replay.ability.noteId, {
      offset: 0,
      limit: 10,
    })

    expect(replay.ability.packageId).toBe(pending.packageId)
    expect(rows.items).toHaveLength(1)
    expect(rows.items[0]).toMatchObject({
      kind: 'write',
      entryRole: 'origin',
      principal: principal.id,
      agent: {
        owner: 'alice',
        agent: 'Codex',
        session: { id: 'session-one', name: 'V8', attach: 'declared' },
      },
    })
    await expect(
      readFile(join(skillRoot, replay.ability.packageId, 'SKILL.md'), 'utf8'),
    ).resolves.toContain('The exact body.')
    expect(await db.abilityAvailability.get(SPACE, replay.ability.packageId)).toEqual({
      homeSpace: SPACE,
      packageId: replay.ability.packageId,
      mode: ABILITY_AVAILABILITY_MODE.allProjects,
    })
  })

  it('recovers a nonterminal accepted create in a new coordinator, authority and cold store', async () => {
    const crashed = await world('accepted-crash')

    await expect(crashed.create()).rejects.toThrow(
      'simulated process exit after durable acceptance',
    )
    const [accepted] = await db.abilityCreate.listRecoverable()

    expect(accepted).toMatchObject({
      phase: 'accepted',
      physicalReceipt: null,
      terminalResult: null,
    })
    expect(await db.identity.findById!(accepted.noteId)).toMatchObject({
      id: accepted.noteId,
      filePath: accepted.targetPath,
      materialized: false,
      deletedAt: null,
      addressRevision: 1,
    })

    const freshProcess = async (indexName: string) => {
      const registry = new SpaceResourceAuthorityRegistry()
      const compositions = new NotariumStoreCompositionOwner()
      const mounts = [
        {
          class: NOTE_CLASS.skill,
          dir: crashed.skillRoot,
          prefix: SKILL_PREFIX,
        },
      ]
      const composition = compositions.getOrCreate(SPACE, mounts)
      const authority = ensureNotariumResourceAuthority({
        spaceId: SPACE,
        resourceAuthorityRegistry: registry,
        composition,
      })
      let storesCreated = 0
      const manager = new SpaceManager({
        spaces: [],
        metaDb: db,
        createStore: () => {
          storesCreated++
          return new CachedStore({
            inner: createNotariumStore({
              spaceId: SPACE,
              resourceAuthorityRegistry: registry,
              composition,
              indexDb: join(root, indexName),
            }),
            identityPersistence: db.identity,
            revisionPersistence: db.revisions,
            space: SPACE,
            pollIntervalMs: 0,
            readBody: async (filePath) => {
              const prefix = `${SKILL_PREFIX}/`

              if (!filePath.startsWith(prefix)) {
                return null
              }

              return readFile(join(crashed.skillRoot, filePath.slice(prefix.length)), 'utf8').catch(
                () => null,
              )
            },
          })
        },
      })

      await manager.init()
      const library = createFsRoleLibrary({
        rootForSpace: (space) => (space === SPACE ? crashed.skillRoot : null),
        resourcePrefixForSpace: (space) => (space === SPACE ? SKILL_PREFIX : null),
        authorityForSpace: async (space) => (space === SPACE ? authority : null),
        publishDirectoryIfAbsent: renameNoReplaceIfAvailable(),
      })
      const roles = createRolesService({
        catalog: loadBundledAbilityInventory,
        ...library,
        abilityAvailability: db.abilityAvailability,
        abilityPreferences: db.abilityPreferences,
        abilityPlacement: db.abilityPlacement,
      })
      const projection = vi.spyOn(manager, 'beginCausalPublication')
      const creator = new DurableAbilityCreator({
        persistence: db.abilityCreate,
        roles,
        authorityForSpace: async (space) => (space === SPACE ? authority : null),
        beginProjection: (space, operationId) =>
          manager.beginCausalPublication(space, { kind: 'ability-create', operationId }),
        primeIdentity: (space, record) => manager.primeWarmCausalIdentity(space, record),
        confirmIdentity: (space, noteId) => manager.confirmCausalIdentity(space, noteId),
        releaseIdentity: (space, noteId) => manager.releasePrimedIdentity(space, noteId),
        adoptPublication: (space, evidence) => manager.adoptCausalPublication(space, evidence),
        reconcile: (space, noteId) => manager.reconcileCausalProjection(space, noteId),
        onError: () => undefined,
      })

      return {
        authority,
        creator,
        manager,
        projection,
        storesCreated: () => storesCreated,
      }
    }

    const recoveredProcess = await freshProcess('recovered-engine.db')

    try {
      await recoveredProcess.creator.recover()
      expect(recoveredProcess.projection).toHaveBeenCalledWith(SPACE, {
        kind: 'ability-create',
        operationId: accepted.id,
      })
      expect(recoveredProcess.storesCreated()).toBe(1)
      expect(recoveredProcess.authority).not.toBe(crashed.authority)
      const operation = await db.abilityCreate.get(accepted.id)

      expect(operation).toMatchObject({ phase: 'succeeded' })
      const revisions = await db.revisions.listByNote(SPACE, accepted.noteId, {
        offset: 0,
        limit: 10,
      })
      expect(revisions.items).toEqual([
        expect.objectContaining({
          kind: 'write',
          entryRole: 'origin',
          principal: principal.id,
          agent: {
            owner: 'alice',
            agent: 'Codex',
            session: { id: 'session-one', name: 'V8', attach: 'declared' },
          },
        }),
      ])
      expect(await db.ownerProofs.get(accepted.noteId)).toMatchObject({
        noteId: accepted.noteId,
        space: SPACE,
        addressRevision: 1,
        proofRevision: 1,
        receiptId: accepted.id,
      })
      expect(await db.abilityAvailability.get(SPACE, accepted.packageId)).toEqual({
        homeSpace: SPACE,
        packageId: accepted.packageId,
        mode: ABILITY_AVAILABILITY_MODE.allProjects,
      })
      const raw = new DatabaseSync(join(root, 'meta.db'), { readOnly: true })

      try {
        expect(
          raw
            .prepare(
              `SELECT registry_note_id FROM ability_availability
                WHERE home_space = ? AND package_id = ?`,
            )
            .get(SPACE, accepted.packageId),
        ).toEqual({ registry_note_id: accepted.noteId })
      } finally {
        raw.close()
      }
      expect(await db.identity.findById!(accepted.noteId)).toMatchObject({
        id: accepted.noteId,
        filePath: accepted.targetPath,
        materialized: true,
        deletedAt: null,
        addressRevision: 1,
      })
      await expect(
        (await recoveredProcess.manager.store(SPACE)).read(accepted.noteId),
      ).resolves.toMatchObject({ id: accepted.noteId, filePath: accepted.targetPath })
    } finally {
      await recoveredProcess.manager.stopAll()
    }

    const nextProcess = await freshProcess('recovered-engine.db')

    try {
      await nextProcess.creator.recover()
      expect(nextProcess.projection).not.toHaveBeenCalled()
      const restarted = await nextProcess.manager.store(SPACE)

      await restarted.identityReady?.()
      await expect(restarted.read(accepted.noteId)).resolves.toMatchObject({
        id: accepted.noteId,
        filePath: accepted.targetPath,
      })
      expect(
        (await db.revisions.listByNote(SPACE, accepted.noteId, { offset: 0, limit: 10 })).items,
      ).toHaveLength(1)
      expect(await db.identity.findById!(accepted.noteId)).toMatchObject({
        addressRevision: 1,
        deletedAt: null,
      })
    } finally {
      await nextProcess.manager.stopAll()
    }
  })

  it('adopts a committed terminal after a lost acknowledgement without recovery debt', async () => {
    const { create } = await world('lost-ack')
    const created = await create()
    const operations = await db.abilityCreate.listRecoverable()
    const revisions = await db.revisions.listByNote(SPACE, created.ability.noteId, {
      offset: 0,
      limit: 10,
    })

    expect(operations).toEqual([])
    expect(revisions.items).toHaveLength(1)
    await expect(create()).resolves.toMatchObject({
      ability: {
        packageId: created.ability.packageId,
        noteId: created.ability.noteId,
      },
    })
    expect(
      (await db.revisions.listByNote(SPACE, created.ability.noteId, { offset: 0, limit: 10 }))
        .items,
    ).toHaveLength(1)
  })

  it('persists caller System-name policy and applies it at the durable name gate', async () => {
    const { create } = await world('lost-ack', {
      name: 'research-evidence',
      systemNamePolicy: 'allow',
    })

    await expect(create()).resolves.toMatchObject({ ability: { name: 'research-evidence' } })
    const operation = await db.abilityCreate.get('ability-operation-1')
    expect(JSON.parse(operation!.preparedEvidence)).toMatchObject({ systemNamePolicy: 'allow' })
  })

  it('rejects same-kind System shadowing for durable agent creates', async () => {
    const { create } = await world('lost-ack', {
      name: 'research-evidence',
      systemNamePolicy: 'reject',
    })

    await expect(create()).rejects.toThrow('conflicts with a System ability')
  })

  it('treats legacy evidence without caller policy as conservative reject', async () => {
    const { create } = await world('legacy-system-policy', {
      name: 'research-evidence',
      systemNamePolicy: 'allow',
    })

    await expect(create()).rejects.toThrow('conflicts with a System ability')
    await expect(db.abilityCreate.get('ability-operation-1')).resolves.toMatchObject({
      phase: 'rejected',
    })
  })

  it('replays a lost acknowledgement before a disappeared attachment rebuilds the package', async () => {
    const { create, preparePackage, removeAttachment } = await world('lost-ack')
    const created = await create()

    expect(preparePackage).toHaveBeenCalledTimes(1)
    removeAttachment()
    await expect(create()).resolves.toMatchObject({
      replayed: true,
      ability: {
        packageId: created.ability.packageId,
        noteId: created.ability.noteId,
      },
    })
    expect(preparePackage).toHaveBeenCalledTimes(1)
  })

  it('rechecks durable replay when concurrent dependency preparation loses the race', async () => {
    const { create, preparePackage } = await world('lost-ack')
    const original = preparePackage.getMockImplementation()!
    let firstEntered!: () => void
    const firstReady = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let secondEntered!: () => void
    const secondReady = new Promise<void>((resolve) => {
      secondEntered = resolve
    })
    let releaseSecond!: () => void
    const secondHeld = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    let attempt = 0

    preparePackage.mockImplementation(async () => {
      attempt++
      if (attempt === 1) {
        firstEntered()
        await firstHeld
        return original()
      }
      secondEntered()
      await secondHeld
      throw new Error('attachment disappeared during the concurrent retry')
    })
    const winner = create()

    await firstReady
    const retry = create()
    await secondReady
    releaseFirst()
    const created = await winner
    releaseSecond()

    await expect(retry).resolves.toMatchObject({
      replayed: true,
      ability: {
        packageId: created.ability.packageId,
        noteId: created.ability.noteId,
      },
    })
    expect(preparePackage).toHaveBeenCalledTimes(2)
  })

  it('returns the committed result when cleanup acknowledgement is unavailable', async () => {
    const { create } = await world('finalize-outage')
    const committed = await create()

    await expect(db.abilityCreate.get('ability-operation-1')).resolves.toMatchObject({
      phase: 'metadata-committed',
    })
    await expect(create()).resolves.toMatchObject({
      ability: {
        packageId: committed.ability.packageId,
        noteId: committed.ability.noteId,
      },
    })
    expect(
      (await db.revisions.listByNote(SPACE, committed.ability.noteId, { offset: 0, limit: 10 }))
        .items,
    ).toHaveLength(1)
    expect(await db.causalOutbox.pending('creator-test-replica', 10)).toHaveLength(1)
  })

  it('primes a warm identity registry before physical bytes become observable', async () => {
    const { create } = await world('identity-order')

    await expect(create()).resolves.toMatchObject({
      ability: { name: 'durable-proof' },
    })
  })

  it('adopts the exact projection under admission before terminal metadata', async () => {
    const { create } = await world('projection-order')

    await expect(create()).resolves.toMatchObject({
      ability: { name: 'durable-proof' },
    })
  })

  it('takes the global mutation claim before placement against an ordinary delete', async () => {
    const { authority, create, lockOrder } = await world('lock-order')
    const creating = create()
    const first = await Promise.race([
      lockOrder.globalRequested.promise.then(() => 'global' as const),
      lockOrder.placementRequested.promise.then(() => 'placement' as const),
    ])

    if (first === 'global') {
      const ordinaryPlacement = await authority.admitSkillPlacement(
        `${SKILL_PREFIX}/ordinary-delete/SKILL.md`,
        'exclusive',
        'ordinary-delete',
      )
      ordinaryPlacement.settle()
    }
    lockOrder.releaseOrdinaryGlobal.resolve()
    await creating

    expect(first).toBe('global')
    await expect(lockOrder.placementRequested.promise).resolves.toBeUndefined()
  })

  it('finishes a preaccepted create through closing while fresh placement stays closed', async () => {
    const { authority, create, manager } = await world('lifecycle-closing')

    const created = await create()

    expect(created).toMatchObject({ ability: { name: 'durable-proof' } })
    await expect(db.spaceLifecycle.get(SPACE)).resolves.toMatchObject({ phase: 'closing' })
    await expect(
      authority.admitSkillPlacement(
        `${SKILL_PREFIX}/fresh-package/SKILL.md`,
        'exclusive',
        'fresh-create',
      ),
    ).rejects.toMatchObject({ code: 'SPACE_LIFECYCLE_CLOSED' })
    expect(
      (
        await db.revisions.listByNote(SPACE, created.ability.noteId, {
          offset: 0,
          limit: 10,
        })
      ).total,
    ).toBe(1)
    await manager?.stopAll()
  })
})
