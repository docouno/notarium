import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import { describeAgentDeltaCursorsContract } from './agentDeltaCursorsContract'
import { describeAgentSessionsContract } from './agentSessionsContract'
import { describeGatewayStateContract } from './gatewayStateContract'
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

describeRevisionPersistenceContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.revisions, teardown: () => db.close() }
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
