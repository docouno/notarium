import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import { describeAgentSessionsContract } from './agentSessionsContract'
import { describeGatewayStateContract } from './gatewayStateContract'
import { describeRevisionPersistenceContract } from './revisionPersistenceContract'

describeGatewayStateContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.gateway, teardown: () => db.close() }
})

describeAgentSessionsContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.sessions, teardown: () => db.close() }
})

describeRevisionPersistenceContract('SQLite', async () => {
  const db = new SqliteMetaDb(':memory:')
  return { persistence: db.revisions, teardown: () => db.close() }
})
