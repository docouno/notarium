import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import { describeAbilityAvailabilityContract } from './abilityAvailabilityContract'
import { describeAbilityCreateContract } from './abilityCreateContract'
import { describeAbilityPlacementContract } from './abilityPlacementContract'
import { describeAbilityPreferencesContract } from './abilityPreferencesContract'
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
