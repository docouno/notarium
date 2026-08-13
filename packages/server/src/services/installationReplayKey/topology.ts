import { isAbsolute, join, resolve } from 'node:path'

import { META_DB_TARGET_KIND, metaDbTargetOf } from '../metaDb'
import { REPLAY_KEY_TOPOLOGY, type ReplayKeyTopology } from './installationReplayKey'

export const REPLAY_KEYRING_DIRNAME = 'replay-keyring'

export type ReplayKeyringConfig = {
  path: string
  topology: ReplayKeyTopology
}

export const replayKeyringConfigFromEnv = (
  dataDir: string,
  metaDbUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): ReplayKeyringConfig => {
  const target = metaDbTargetOf(metaDbUrl)
  const canonicalPath = join(dataDir, REPLAY_KEYRING_DIRNAME)
  const canonicalMeta = join(dataDir, 'meta.db')
  const configured = env.NOTARIUM_REPLAY_KEYRING_DIR?.trim()
  const isCanonicalMeta =
    target.kind === META_DB_TARGET_KIND.file && resolve(target.path) === resolve(canonicalMeta)

  if (!configured && isCanonicalMeta) {
    return { path: canonicalPath, topology: REPLAY_KEY_TOPOLOGY.canonicalLocal }
  }
  if (!configured) {
    throw new Error(
      'external meta-DB topology requires NOTARIUM_REPLAY_KEYRING_DIR on one shared durable filesystem',
    )
  }
  if (!isAbsolute(configured)) {
    throw new Error('NOTARIUM_REPLAY_KEYRING_DIR must be an absolute shared path')
  }
  const path = resolve(configured)

  return {
    path,
    topology:
      isCanonicalMeta && path === resolve(canonicalPath)
        ? REPLAY_KEY_TOPOLOGY.canonicalLocal
        : REPLAY_KEY_TOPOLOGY.externalShared,
  }
}
