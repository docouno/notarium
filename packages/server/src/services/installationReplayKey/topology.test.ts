import { describe, expect, it } from 'vitest'

import { REPLAY_KEY_TOPOLOGY } from './installationReplayKey'
import { replayKeyringConfigFromEnv } from './topology'

describe('replayKeyringConfigFromEnv', () => {
  it('uses the canonical DATA_DIR keyring with its file SQLite database', () => {
    expect(replayKeyringConfigFromEnv('/data', 'sqlite:/data/meta.db', {})).toEqual({
      path: '/data/replay-keyring',
      topology: REPLAY_KEY_TOPOLOGY.canonicalLocal,
    })
  })

  it('requires one explicit absolute shared path for external metadata', () => {
    expect(() => replayKeyringConfigFromEnv('/data', 'postgres://db/notarium', {})).toThrow(
      /requires NOTARIUM_REPLAY_KEYRING_DIR/,
    )
    expect(() =>
      replayKeyringConfigFromEnv('/data', 'postgres://db/notarium', {
        NOTARIUM_REPLAY_KEYRING_DIR: 'relative',
      }),
    ).toThrow(/must be an absolute shared path/)
    expect(
      replayKeyringConfigFromEnv('/data', 'postgres://db/notarium', {
        NOTARIUM_REPLAY_KEYRING_DIR: '/shared/replay',
      }),
    ).toEqual({ path: '/shared/replay', topology: REPLAY_KEY_TOPOLOGY.externalShared })
  })
})
