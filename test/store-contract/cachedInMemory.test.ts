// The read-model decorator must be contract-transparent: CachedStore over the
// reference engine passes the exact spec the bare engines pass — write-through
// and snapshot serving included, nothing observable changes for a consumer.

import { CachedStore } from '@notarium/core'
import { InMemoryStore } from '@notarium/engine-memory'

import { describeKnowledgeStoreContract } from './storeContract'

describeKnowledgeStoreContract('CachedStore(InMemoryStore)', async () => {
  const inner = new InMemoryStore({ space: 'main', now: '2026-06-10T12:00:00.000Z', notes: [] })
  const store = new CachedStore({
    inner,
    pollIntervalMs: 0,
    relationType: 'links_to',
  })
  await store.start()
  return {
    store,
    directory: 'contract-spec',
    teardown: async () => store.stop(),
  }
})
