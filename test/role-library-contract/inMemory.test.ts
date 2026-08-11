import { createInMemoryRoleLibrary } from '../../packages/server/src/services/roles'
import { describeRoleLibraryContract } from './roleLibraryContract'

describeRoleLibraryContract('InMemoryRoleLibrary', async () => ({
  library: createInMemoryRoleLibrary(),
}))
