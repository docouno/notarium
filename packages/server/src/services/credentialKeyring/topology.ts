import { isAbsolute, join, resolve, sep } from 'node:path'

import { META_DB_TARGET_KIND, metaDbTargetOf } from '../metaDb'

export const CREDENTIAL_KEYRING_DIRNAME = 'secret-keyring'

export const CREDENTIAL_KEY_TOPOLOGY = {
  canonicalLocal: 'canonical-local',
  externalShared: 'external-shared',
} as const

export type CredentialKeyTopology =
  (typeof CREDENTIAL_KEY_TOPOLOGY)[keyof typeof CREDENTIAL_KEY_TOPOLOGY]

export type CredentialKeyringConfig = {
  path: string
  topology: CredentialKeyTopology
  packedRoots: readonly string[]
}

const under = (path: string, root: string): boolean => path === root || path.startsWith(root + sep)

export const credentialKeyringConfigFromEnv = (
  input: {
    dataDir: string
    metaDbUrl: string
    packedRoots: readonly string[]
  },
  env: NodeJS.ProcessEnv = process.env,
): CredentialKeyringConfig => {
  const dataDir = resolve(input.dataDir)
  const target = metaDbTargetOf(input.metaDbUrl)
  const canonicalPath = join(dataDir, CREDENTIAL_KEYRING_DIRNAME)
  const canonicalMeta = join(dataDir, 'meta.db')
  const configured = env.NOTARIUM_CREDENTIAL_KEYRING_DIR?.trim()
  const isCanonicalMeta =
    target.kind === META_DB_TARGET_KIND.file && resolve(target.path) === canonicalMeta
  let path: string
  let topology: CredentialKeyTopology

  if (isCanonicalMeta) {
    if (configured) {
      throw new Error(
        `canonical SQLite topology keeps credential keys at ${canonicalPath}; NOTARIUM_CREDENTIAL_KEYRING_DIR is only for an external meta-DB`,
      )
    }
    path = canonicalPath
    topology = CREDENTIAL_KEY_TOPOLOGY.canonicalLocal
  } else {
    if (!configured) {
      throw new Error(
        'external meta-DB topology requires NOTARIUM_CREDENTIAL_KEYRING_DIR on one shared durable filesystem',
      )
    }
    if (!isAbsolute(configured)) {
      throw new Error('NOTARIUM_CREDENTIAL_KEYRING_DIR must be an absolute shared path')
    }
    path = resolve(configured)
    topology = CREDENTIAL_KEY_TOPOLOGY.externalShared
  }

  const packedRoots = input.packedRoots.map((root) => resolve(root))
  const packedRoot = packedRoots.find((root) => under(path, root))

  if (packedRoot) {
    throw new Error(
      `credential keyring must stay outside backup roots: ${path} is inside ${packedRoot}`,
    )
  }

  return { path, topology, packedRoots }
}
