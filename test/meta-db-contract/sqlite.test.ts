import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'

import type { RevisionInput } from '@notarium/core'

import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import { describeAbilityAvailabilityContract } from './abilityAvailabilityContract'
import { describeAbilityCreateContract } from './abilityCreateContract'
import { describeAbilityPlacementContract } from './abilityPlacementContract'
import { describeAbilityPlacementCostContract } from './abilityPlacementCostContract'
import { describeAbilityPreferencesContract } from './abilityPreferencesContract'
import { describeAccountContract } from './accountContract'
import { describeAgentCallsContract } from './agentCallsContract'
import { describeAgentDeltaCursorsContract } from './agentDeltaCursorsContract'
import { describeAgentSessionsContract } from './agentSessionsContract'
import { describeCausalMetadataContract } from './causalMetadataContract'
import { describeContextSetBulkIdentityContract } from './contextSetBulkIdentityContract'
import { describeContextSetsContract } from './contextSetsContract'
import { describeFavoritesContract } from './favoritesContract'
import { describeGatewayStateContract } from './gatewayStateContract'
import { describeIdentityPersistenceContract } from './identityPersistenceContract'
import { describeImportReservationsContract } from './importReservationsContract'
import { describeJobsContract } from './jobsContract'
import { describeLegacyNameAliasesContract } from './legacyNameAliasesContract'
import { describeProviderCallLogContract } from './providerCallLogContract'
import { describeProviderCiphertextsContract } from './providerCiphertextsContract'
import { describeProviderFacetsContract } from './providerFacetsContract'
import { describeRevisionPersistenceContract } from './revisionPersistenceContract'
import { describeSecretKeyringContract } from './secretKeyringContract'
import { describeSessionAuditContract } from './sessionAuditContract'
import { describeSpaceLifecycleWriterContract } from './spaceLifecycleWriterContract'

describeGatewayStateContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.gateway, teardown: () => db.close() }
})

describeAccountContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { auth: db.auth, teardown: () => db.close() }
})

describeSecretKeyringContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.secretKeyring, teardown: () => db.close() }
})

describeProviderFacetsContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return {
    secretKeyring: db.secretKeyring,
    credentials: db.credentials,
    resources: db.providerResources,
    attachments: db.providerAttachments,
    lifecycle: db,
    ciphertexts: db.providerCiphertexts,
    spaces: db.spaces,
    auth: db.auth,
    retargetProviderCredential: (input) => db.retargetProviderCredential(input),
    removeMemberAndProviderAttachments: (space, username) =>
      db.removeMemberAndProviderAttachments(space, username),
    purgeSpace: (space: string) => db.purgeSpace(space),
    teardown: () => db.close(),
  }
})

describeProviderCallLogContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return {
    callLog: db.providerCallLog,
    jobs: db.jobs,
    purgeSpace: (space: string) => db.purgeSpace(space),
    teardown: () => db.close(),
  }
})

describeProviderCiphertextsContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return {
    secretKeyring: db.secretKeyring,
    credentials: db.credentials,
    resources: db.providerResources,
    ciphertexts: db.providerCiphertexts,
    teardown: () => db.close(),
  }
})

describeAgentDeltaCursorsContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return {
    persistence: db.agentDeltaCursors,
    sessions: db.sessions,
    projects: db.projects,
    folders: db.folders,
    teardown: () => db.close(),
  }
})

describeAgentSessionsContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.sessions, teardown: () => db.close() }
})

describeAgentCallsContract('SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notarium-agent-calls-contract-'))
  const path = join(root, 'meta.db')
  let db = new SqliteMetaDb(path)
  const facets = () => ({
    calls: db.agentCalls,
    sessions: db.sessions,
    audit: db.sessionAudit,
    retrievals: db.retrievalLog,
    revisions: db.revisions,
  })

  return {
    ...facets(),
    restart: async () => {
      await db.close()
      db = new SqliteMetaDb(path)
      return facets()
    },
    teardown: async () => {
      await db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
})

describeAbilityPreferencesContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { db, teardown: () => db.close() }
})

describeAbilityCreateContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { db, teardown: () => db.close() }
})

describeFavoritesContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.favorites, teardown: () => db.close() }
})

describeContextSetsContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.contextSets, teardown: () => db.close() }
})

describeContextSetBulkIdentityContract('SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notarium-context-set-bulk-contract-'))
  const path = join(dir, 'meta.sqlite')
  const db = new SqliteMetaDb(path)

  await db.contextSets.getSet('migration-probe')
  const observer = new DatabaseSync(path)
  observer.exec(`
    CREATE TABLE context_set_update_audit (set_id TEXT NOT NULL);
    CREATE TRIGGER context_set_update_count
      AFTER UPDATE ON context_sets
      BEGIN
        INSERT INTO context_set_update_audit(set_id) VALUES (NEW.id);
      END;
  `)

  return {
    contextSets: db.contextSets,
    identity: db.identity,
    updateCount: async () =>
      Number(
        (
          observer
            .prepare(
              "SELECT COUNT(*) AS count FROM context_set_update_audit WHERE set_id = 'bulk-observed'",
            )
            .get() as { count: number }
        ).count,
      ),
    teardown: async () => {
      observer.close()
      await db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
})

describeImportReservationsContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return {
    reservations: db.importReservations,
    jobs: db.jobs,
    purgeSpace: (space) => db.purgeSpace(space),
    teardown: () => db.close(),
  }
})

describeJobsContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { jobs: db.jobs, teardown: () => db.close() }
})

// File-backed, unlike the contracts above: a settled quarantine is written by the
// identity aggregate's transaction, which the revision port cannot reach — so the
// state is installed the way that transaction leaves it, through a second handle.
describeRevisionPersistenceContract('SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notarium-revision-contract-'))
  const path = join(dir, 'meta.sqlite')
  const db = new SqliteMetaDb(path)

  return {
    persistence: db.revisions,
    quarantine: async (revisionIds) => {
      const raw = new DatabaseSync(path)

      try {
        const mark = raw.prepare(`UPDATE note_revisions SET integrity = 'quarantined' WHERE id = ?`)

        for (const id of revisionIds) {
          mark.run(id)
        }
      } finally {
        raw.close()
      }
    },
    teardown: async () => {
      await db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
})

it('keeps bounded raw events available while every grouped SQLite read rebuilds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notarium-activity-rebuilding-'))
  const path = join(dir, 'meta.sqlite')
  const db = new SqliteMetaDb(path)
  const revision: RevisionInput = {
    noteId: 'note-a',
    space: 'space-a',
    baseRevisionId: null,
    theirRevisionId: null,
    sourceRevisionId: null,
    kind: 'write',
    entryRole: 'origin',
    principal: 'user:alice',
    contentHash: 'hash-a',
    title: 'A',
    class: 'user-doc',
    slug: null,
    tags: [],
    createdAt: '2026-08-30T00:00:00.000Z',
    charsAdded: 1,
    charsRemoved: 0,
  }

  try {
    const stored = await db.revisions.append(revision, 'a')
    const raw = new DatabaseSync(path)

    try {
      raw.prepare("UPDATE note_revisions SET integrity = 'quarantined' WHERE id = ?").run(stored.id)
    } finally {
      raw.close()
    }

    await expect(
      db.revisions.activityGroupsByNote('space-a', {
        from: '2026-08-29T00:00:00.000Z',
        to: '2026-08-31T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ reason: 'activity_projection_rebuilding', isUnavailable: true })
    const bounded = await db.revisions.activityEvents('space-a', {
      from: '2026-08-29T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
      offset: 0,
      limit: 10,
    })

    expect(bounded.total).toBe(1)
    expect(bounded).not.toHaveProperty('activityLease')
    expect(await db.revisions.prepareActivityProjection('space-a')).toEqual({
      state: 'rebuilding',
    })
    await expect(db.revisions.maintainActivityProjection('space-a')).resolves.toMatchObject({
      state: 'ready',
      published: true,
    })
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

describeCausalMetadataContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return {
    operations: db.restoreOperations,
    lifecycle: db.spaceLifecycle,
    outbox: db.causalOutbox,
    installation: db.installationGeneration,
    ownerProofs: db.ownerProofs,
    revisions: db.revisions,
    terminal: db.restoreTerminal,
    setAddress: async (noteId, space, revision, legacyNameAliases = []) => {
      await db.identity.claimMany([
        {
          id: noteId,
          legacyNameAliases,
          filePath: `address-${revision}.md`,
          space,
          createdAt: null,
          materialized: true,
          deletedAt: null,
        },
      ])
    },
    getAddress: (noteId) => db.identity.findById!(noteId),
    prepareTerminalResurrection: async (noteId, space, filePath, at) => {
      const current = await db.identity.findById!(noteId)

      if (!current) {
        throw new Error(`missing identity ${noteId}`)
      }
      await db.identity.settleFileClaim({
        space,
        filePath,
        current,
        observedId: 'terminal-successor',
        at,
      })
      const retired = await db.identity.findById!(noteId)

      if (!retired) {
        throw new Error(`missing retired identity ${noteId}`)
      }

      return retired
    },
    mergeLegacyNameAlias: (noteId, space, alias) =>
      db.identity.mergeLegacyNameAlias({ id: noteId, space, alias }),
    teardown: () => db.close(),
  }
})

describeSpaceLifecycleWriterContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { db, teardown: () => db.close() }
})

describeSessionAuditContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return {
    audit: db.sessionAudit,
    retrievals: db.retrievalLog,
    revisions: db.revisions,
    sessions: db.sessions,
    teardown: () => db.close(),
  }
})

describeAbilityAvailabilityContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { db, teardown: () => db.close() }
})

describeAbilityPlacementContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { db, teardown: () => db.close() }
})

describeAbilityPlacementCostContract(
  'SQLite',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notarium-ability-placement-cost-'))
    const path = join(dir, 'meta.sqlite')
    const statements: string[] = []
    const db = new SqliteMetaDb(path, { observeStatement: (sql) => statements.push(sql) })
    await db.abilityPlacement.resolveMovedOwnedRoleLocator('init')
    const observer = new DatabaseSync(path)

    observer.exec('CREATE TABLE pointer_audit (table_name TEXT NOT NULL)')
    for (const table of [
      'context_set_attachments',
      'context_scope_pins',
      'context_order',
      'ability_preferences',
      'agent_sessions',
    ]) {
      for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        observer.exec(
          `CREATE TRIGGER audit_${table}_${event.toLowerCase()}
             AFTER ${event} ON ${table}
             BEGIN INSERT INTO pointer_audit(table_name) VALUES ('${table}'); END`,
        )
      }
    }
    await db.spaces.upsert({
      id: 'space-main',
      slug: 'space-main',
      displayName: 'Space main',
      notesDir: '/space-main',
      aliases: [],
      createdAt: '2026-09-02T00:00:00.000Z',
      archivedAt: null,
      archivedBy: null,
    })
    await db.identity.claimMany([
      {
        id: 'PinnedNote01',
        legacyNameAliases: [],
        filePath: 'pinned.md',
        space: 'space-main',
        createdAt: '2026-09-02T00:00:00.000Z',
        materialized: true,
        deletedAt: null,
      },
    ])
    await db.contextSets.createSet({
      id: 'set-cost',
      homeSpace: 'space-main',
      name: 'Cost set',
      items: [],
      createdAt: '2026-09-02T00:00:00.000Z',
    })
    await db.sessions.insert({
      id: 'session-cost',
      owner: 'user:cost',
      name: 'cost',
      named: true,
      parentId: null,
      createdAt: '2026-09-02T00:00:00.000Z',
      lastSeenAt: '2026-09-02T00:00:00.000Z',
      calls: 1,
      role: null,
      roleLocator: null,
      roleContextProjectId: null,
      projectId: null,
    })
    observer.exec('DELETE FROM pointer_audit')
    statements.length = 0

    return {
      abilityPlacement: db.abilityPlacement,
      contextSets: db.contextSets,
      scopePins: db.scopePins,
      contextOrder: db.contextOrder,
      sessions: db.sessions,
      seedUnrelatedTrail: async (count) => {
        const insert = observer.prepare(
          `INSERT INTO ability_placement_trail
             (from_locator, to_locator, space_id, registry_note_id, manifest_note_id)
           VALUES (?, ?, 'space-main', 'RegistryNote1', 'ManifestNote1')`,
        )

        for (let index = 0; index < count; index += 1) {
          insert.run(`unrelated-${index}`, `destination-${index}`)
        }
      },
      seedSourceRows: async (count) => {
        const insert = observer.prepare(
          `INSERT INTO context_order
             (target_kind, target_id, target_space, entry_kind, entry_ref, rank)
           VALUES ('role', 'project:project-a:AbCdefGhij_1', 'space-main', 'set', ?, ?)`,
        )

        for (let index = 0; index < count; index += 1) {
          insert.run(`set-source-${index}`, index)
        }
      },
      explainExactLookup: async (locator) =>
        observer
          .prepare(
            `EXPLAIN QUERY PLAN
             SELECT to_locator, registry_note_id, manifest_note_id
               FROM ability_placement_trail WHERE from_locator = ?`,
          )
          .all(locator)
          .map((row) => (row as { detail: string }).detail)
          .join('\n'),
      resetPointerAudit: async () => observer.exec('DELETE FROM pointer_audit'),
      resetStatementAudit: () => {
        statements.length = 0
      },
      statementAudit: () => [...statements],
      pointerDmlCount: async () =>
        Number(
          (
            observer.prepare('SELECT COUNT(*) AS count FROM pointer_audit').get() as {
              count: number
            }
          ).count,
        ),
      teardown: async () => {
        observer.close()
        await db.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
  /sqlite_autoindex_ability_placement_trail_1/i,
)

// Two connections onto ONE file database: ':memory:' would give each handle its
// own private table and the arbitration contract would prove nothing.
describeIdentityPersistenceContract('SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notarium-identity-contract-'))
  const path = join(dir, 'meta.sqlite')
  const alpha = new SqliteMetaDb(path)
  const beta = new SqliteMetaDb(path)

  return {
    alpha,
    beta,
    corruptContextSetItems: async (setId, raw) => {
      // A third connection on the same file: the port cannot produce a payload
      // it refuses to read back, so the test writes it the way a hand edit would.
      const raw3 = new DatabaseSync(path)

      try {
        raw3.prepare('UPDATE context_sets SET items = ? WHERE id = ?').run(raw, setId)
      } finally {
        raw3.close()
      }
    },
    teardown: async () => {
      await alpha.close()
      await beta.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
})

describeLegacyNameAliasesContract('SQLite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notarium-alias-contract-'))
  const path = join(dir, 'meta.sqlite')
  const alpha = new SqliteMetaDb(path)
  const beta = new SqliteMetaDb(path)

  return {
    alpha: alpha.identity,
    beta: beta.identity,
    corruptAliases: async (id, raw) => {
      const connection = new DatabaseSync(path)

      try {
        connection
          .prepare('UPDATE note_identity SET legacy_name_aliases = ? WHERE id = ?')
          .run(raw, id)
      } finally {
        connection.close()
      }
    },
    teardown: async () => {
      await alpha.close()
      await beta.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
})

it('serves cumulative Activity integers above Number.MAX_SAFE_INTEGER as exact decimals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notarium-activity-bigint-'))
  const path = join(dir, 'meta.sqlite')
  const db = new SqliteMetaDb(path)
  const exact = 9_007_199_254_740_993n

  try {
    await db.revisions.append(
      {
        noteId: 'note-bigint',
        space: 'alpha',
        baseRevisionId: null,
        theirRevisionId: null,
        sourceRevisionId: null,
        kind: 'write',
        entryRole: 'origin',
        principal: 'user:viewer',
        contentHash: null,
        title: 'BigInt Activity',
        class: 'user-doc',
        slug: null,
        tags: [],
        createdAt: '2026-08-31T00:00:00.000Z',
        charsAdded: 1,
        charsRemoved: 0,
      },
      null,
    )
    const raw = new DatabaseSync(path)

    try {
      raw
        .prepare(
          `UPDATE activity_note_actor_states
              SET event_count = ?, chars_added_sum = ?, chars_added_known = 1
            WHERE space = 'alpha'`,
        )
        .run(exact, exact)
    } finally {
      raw.close()
    }
    const result = await db.revisions.activityGroupsByNote('alpha', {})

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      noteId: 'note-bigint',
      count: String(exact),
      charsAdded: String(exact),
      lastSourceOrdinal: '1',
    })
  } finally {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
