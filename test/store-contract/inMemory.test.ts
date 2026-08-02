import { InMemoryStore } from '@notarium/engine-memory'

import { describeKnowledgeStoreContract } from './storeContract'

describeKnowledgeStoreContract('InMemoryStore', async () => ({
  store: new InMemoryStore({ space: 'main', now: '2026-06-10T12:00:00.000Z', notes: [] }),
  directory: 'contract-spec',
}))
