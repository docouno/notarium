import { InMemoryStore } from '@notarium/engine-memory'

import { createStoreRoleLibrary } from '../fake-server/storeRoleLibrary'
import { writableLibrary } from '../roleLibraryComposition'
import { describeRoleLibraryContract } from './roleLibraryContract'

/** The fake server's library is the ONLY `RoleLibrary` under every browser gate, so
 *  whatever it cannot express is a class of states those gates can never reach. It
 *  was the one implementation of the port that had never been run against the port's
 *  own contract. */
describeRoleLibraryContract('createStoreRoleLibrary', async () => {
  const store = new InMemoryStore({
    space: 'personal',
    now: '2099-08-05T12:00:00.000Z',
    notes: [],
  })

  return { library: writableLibrary(createStoreRoleLibrary(() => Promise.resolve(store))) }
})
