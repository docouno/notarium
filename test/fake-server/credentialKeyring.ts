import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CredentialKeyring,
  CredentialKeyringService,
  type ProviderCiphertextsPersistence,
} from '@notarium/server'

import { InMemorySecretKeyringPersistence } from './secretKeyring'

export const createFakeCredentialKeyring = (
  ciphertexts: ProviderCiphertextsPersistence,
  persistence = new InMemorySecretKeyringPersistence(),
) => {
  const root = mkdtempSync(join(tmpdir(), 'notarium-fake-credential-keyring-'))
  const service = new CredentialKeyringService({
    persistence,
    keyring: new CredentialKeyring(join(root, 'keyring'), []),
    ciphertexts,
  })

  return {
    service,
    close: () => rm(root, { recursive: true, force: true }),
  }
}
