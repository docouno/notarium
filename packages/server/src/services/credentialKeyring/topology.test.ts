import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CREDENTIAL_KEY_TOPOLOGY,
  CREDENTIAL_KEYRING_DIRNAME,
  credentialKeyringConfigFromEnv,
} from './topology'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'notarium-credential-topology-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const input = (metaDbUrl = `sqlite:${join(root, 'meta.db')}`) => ({
  dataDir: root,
  metaDbUrl,
  packedRoots: [join(root, 'spaces'), join(root, 'jobs'), join(root, 'replay-keyring')],
})

describe('credential keyring topology', () => {
  it('derives the canonical SQLite path without touching the filesystem', async () => {
    const config = credentialKeyringConfigFromEnv(input(), {})

    expect(config).toEqual({
      path: join(root, CREDENTIAL_KEYRING_DIRNAME),
      topology: CREDENTIAL_KEY_TOPOLOGY.canonicalLocal,
      packedRoots: input().packedRoots,
    })
    await expect(stat(config.path)).rejects.toThrow(/ENOENT/)
  })

  it('requires one absolute shared path for every external meta-DB', () => {
    expect(() => credentialKeyringConfigFromEnv(input('postgres://db/notarium'), {})).toThrow(
      /requires NOTARIUM_CREDENTIAL_KEYRING_DIR/,
    )
    expect(() =>
      credentialKeyringConfigFromEnv(input('postgres://db/notarium'), {
        NOTARIUM_CREDENTIAL_KEYRING_DIR: 'relative/keyring',
      }),
    ).toThrow(/must be an absolute shared path/)
    expect(() =>
      credentialKeyringConfigFromEnv(input('postgres://db/notarium'), {
        CREDENTIAL_KEYRING_DIR: join(root, 'legacy-alias'),
        NOTARIUM_SECRET_KEYRING_DIR: join(root, 'legacy-alias'),
      }),
    ).toThrow(/requires NOTARIUM_CREDENTIAL_KEYRING_DIR/)

    expect(
      credentialKeyringConfigFromEnv(input('postgres://db/notarium'), {
        NOTARIUM_CREDENTIAL_KEYRING_DIR: join(root, 'shared-keyring'),
      }),
    ).toEqual({
      path: join(root, 'shared-keyring'),
      topology: CREDENTIAL_KEY_TOPOLOGY.externalShared,
      packedRoots: input('postgres://db/notarium').packedRoots,
    })
  })

  it.each(['spaces', 'jobs', 'replay-keyring'])(
    'rejects placement under the packed %s root independent of subsystem state',
    (packed) => {
      expect(() =>
        credentialKeyringConfigFromEnv(input('postgres://db/notarium'), {
          NOTARIUM_CREDENTIAL_KEYRING_DIR: join(root, packed, 'secret-keyring'),
        }),
      ).toThrow(/must stay outside backup roots/)
    },
  )

  it('does not let canonical SQLite silently relocate the keyring', () => {
    expect(() =>
      credentialKeyringConfigFromEnv(input(), {
        NOTARIUM_CREDENTIAL_KEYRING_DIR: join(root, 'somewhere-else'),
      }),
    ).toThrow(/only for an external meta-DB/)
    expect(() =>
      credentialKeyringConfigFromEnv(input(), {
        NOTARIUM_CREDENTIAL_KEYRING_DIR: join(root, CREDENTIAL_KEYRING_DIRNAME),
      }),
    ).toThrow(/only for an external meta-DB/)
  })
})
