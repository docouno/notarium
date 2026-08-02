// The production dual-run composition (#69): CachedStore over the Notarium
// engine — the exact stack a notarium-engine space serves from. The decorator
// equips the bare engine with identity/CAS/journal, so the full spec including
// the optimistic-write scenarios runs here.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CachedStore } from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'

import { describeKnowledgeStoreContract } from './storeContract'

describeKnowledgeStoreContract('CachedStore(NotariumStore)', async () => {
  const notesDir = mkdtempSync(join(tmpdir(), 'notarium-engine-cached-'))
  // Two typed mounts (#78): the production stack a notarium space serves from,
  // with the hidden agent-memory mount the class/visibility spec exercises.
  const inner = createNotariumStore({
    mounts: [
      { class: 'user-doc', dir: notesDir, prefix: '' },
      {
        class: 'agent-memory',
        dir: join(notesDir, '.notarium/memory'),
        prefix: '.notarium/memory',
      },
    ],
  })
  const store = new CachedStore({ inner, pollIntervalMs: 0 })
  await store.start()
  return {
    store,
    directory: 'contract-spec',
    teardown: async () => {
      store.stop()
      await store.settle() // let the engine's index handle close before we rm
      rmSync(notesDir, { recursive: true, force: true })
    },
  }
})
