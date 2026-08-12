import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import { describeAgentDeltaCursorsContract } from './agentDeltaCursorsContract'
import { describeAgentSessionsContract } from './agentSessionsContract'
import { describeFavoritesContract } from './favoritesContract'
import { describeGatewayStateContract } from './gatewayStateContract'
import { describeIdentityPersistenceContract } from './identityPersistenceContract'
import { describeRevisionPersistenceContract } from './revisionPersistenceContract'
import { describeSessionAuditContract } from './sessionAuditContract'

describeGatewayStateContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.gateway, teardown: () => db.close() }
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

describeFavoritesContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.favorites, teardown: () => db.close() }
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
