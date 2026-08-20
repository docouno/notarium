import { createInMemoryRoleLibrary } from '../../packages/server/src/services/roles'
import {
  describeRoleLibraryAddressCollisionContract,
  describeRoleLibraryContract,
} from './roleLibraryContract'

describeRoleLibraryContract('InMemoryRoleLibrary', async () => ({
  library: createInMemoryRoleLibrary(),
}))

describeRoleLibraryAddressCollisionContract('InMemoryRoleLibrary', async () => ({
  library: createInMemoryRoleLibrary(),
}))
