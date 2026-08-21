import { createInMemoryRoleLibrary } from '../../packages/server/src/services/roles'
import { writableLibrary } from '../roleLibraryComposition'
import {
  describeRoleLibraryAddressCollisionContract,
  describeRoleLibraryContract,
} from './roleLibraryContract'

describeRoleLibraryContract('InMemoryRoleLibrary', async () => ({
  library: writableLibrary(createInMemoryRoleLibrary()),
}))

describeRoleLibraryAddressCollisionContract('InMemoryRoleLibrary', async () => ({
  library: writableLibrary(createInMemoryRoleLibrary()),
}))
