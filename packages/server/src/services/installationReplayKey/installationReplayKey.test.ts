import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  InMemoryInstallationGenerationPersistence,
  INSTALLATION_GENERATION_PHASE,
} from '@notarium/core'

import { InstallationReplayKey, REPLAY_KEY_TOPOLOGY } from './installationReplayKey'
import { ReplayKeyring } from './replayKeyring'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixture = async (topology = REPLAY_KEY_TOPOLOGY.canonicalLocal) => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-replay-key-'))
  roots.push(root)
  let tick = 0
  const persistence = new InMemoryInstallationGenerationPersistence()
  const keyring = new ReplayKeyring(join(root, 'keyring'))
  const service = new InstallationReplayKey({
    persistence,
    keyring,
    topology,
    now: () => new Date(Date.UTC(2026, 7, 11, 0, 0, tick++)),
  })
  return { root, persistence, keyring, service }
}

describe('InstallationReplayKey', () => {
  it('bootstraps one durable 256-bit key and signs domain-separated digests', async () => {
    const { persistence, keyring, service } = await fixture()
    const active = await service.bootstrap()

    expect(active.generation).toBe(1)
    expect(active.secret).toHaveLength(32)
    expect(await persistence.current()).toMatchObject({
      generation: 1,
      phase: 'active-installed',
      activeKeyId: active.keyId,
      activeHash: active.hash,
      candidateKeyId: null,
    })
    await expect(service.digest('actor', 'same-input')).resolves.not.toBe(
      await service.digest('idempotency', 'same-input'),
    )
    const restarted = new InstallationReplayKey({
      persistence,
      keyring,
      topology: REPLAY_KEY_TOPOLOGY.canonicalLocal,
    })
    await expect(restarted.bootstrap()).resolves.toMatchObject({
      generation: 1,
      keyId: active.keyId,
      hash: active.hash,
    })
  })

  it.each([
    INSTALLATION_GENERATION_PHASE.candidateReady,
    INSTALLATION_GENERATION_PHASE.publishingActive,
  ])('recovers a witnessed %s replacement after restart', async (phase) => {
    const { persistence, keyring, service } = await fixture()
    const active = await service.bootstrap()
    const installed = await persistence.current()
    const candidate = await keyring.createCandidate()

    if (!installed) {
      throw new Error('expected installed generation')
    }
    const interrupted = {
      generation: 2,
      phase,
      activeKeyId: active.keyId,
      activeHash: active.hash,
      candidateKeyId: candidate.keyId,
      candidateHash: candidate.hash,
      changedAt: '2026-08-11T01:00:00.000Z',
    }
    await expect(
      persistence.compareAndSet({ expected: installed, record: interrupted }),
    ).resolves.toMatchObject({ status: 'installed' })
    const recovered = await service.bootstrap()

    expect(recovered).toMatchObject({ generation: 2, keyId: candidate.keyId })
    expect(await keyring.readKey(active.keyId)).not.toBeNull()
    expect(await persistence.current()).toMatchObject({
      phase: 'active-installed',
      activeKeyId: candidate.keyId,
      candidateKeyId: null,
    })
  })

  it('signs new identity only with the active key while retaining old replay candidates', async () => {
    const { service } = await fixture()
    const first = await service.bootstrap()
    const oldDigest = await service.digest('actor', 'alice')
    const second = await service.rotate()
    const newDigest = await service.digest('actor', 'alice')

    expect(second.generation).toBe(2)
    expect(second.keyId).not.toBe(first.keyId)
    expect(newDigest).not.toBe(oldDigest)
    await expect(service.digestCandidates('actor', 'alice')).resolves.toEqual([
      newDigest,
      oldDigest,
    ])
  })

  it('promotes a pointer already published before the database acknowledgement', async () => {
    const { persistence, keyring, service } = await fixture()
    const active = await service.bootstrap()
    const installed = await persistence.current()
    const candidate = await keyring.createCandidate()

    if (!installed) {
      throw new Error('expected installed generation')
    }
    const publishing = {
      generation: 2,
      phase: INSTALLATION_GENERATION_PHASE.publishingActive,
      activeKeyId: active.keyId,
      activeHash: active.hash,
      candidateKeyId: candidate.keyId,
      candidateHash: candidate.hash,
      changedAt: '2026-08-11T01:00:00.000Z',
    }
    await persistence.compareAndSet({ expected: installed, record: publishing })
    await keyring.installActive(2, candidate)

    await expect(service.bootstrap()).resolves.toMatchObject({
      generation: 2,
      keyId: candidate.keyId,
    })
  })

  it('replaces complete local key loss but refuses corrupt present state', async () => {
    const { root, persistence, keyring, service } = await fixture()
    const first = await service.bootstrap()

    await rm(keyring.root, { recursive: true })
    await expect(service.bootstrap()).resolves.toMatchObject({ generation: 2 })

    const pointer = await readFile(keyring.activePath, 'utf8')
    await writeFile(keyring.activePath, pointer.replace('sha256:', 'sha256:corrupt-'))
    await expect(service.bootstrap()).rejects.toThrow(/corrupt or mismatched keyring state/)
    expect(await persistence.current()).toMatchObject({ generation: 2 })
    expect(root).toBeTruthy()
    expect(first.generation).toBe(1)
  })

  it('fails closed on external stable+missing and requires checked offline recovery', async () => {
    const local = await fixture()
    const first = await local.service.bootstrap()

    await rm(local.keyring.root, { recursive: true })
    const external = new InstallationReplayKey({
      persistence: local.persistence,
      keyring: local.keyring,
      topology: REPLAY_KEY_TOPOLOGY.externalShared,
    })
    await expect(external.bootstrap()).rejects.toThrow(/admin recover-replay-key/)
    await expect(
      external.recoverMissingExternal({ expectedKeyId: 'rk_wrong', apply: false }),
    ).rejects.toThrow(/expected key id/)
    await expect(
      external.recoverMissingExternal({ expectedKeyId: first.keyId, apply: false }),
    ).resolves.toMatchObject({ generation: 1, applied: false })
    await expect(
      external.recoverMissingExternal({ expectedKeyId: first.keyId, apply: true }),
    ).resolves.toMatchObject({ generation: 2, previousKeyId: first.keyId, applied: true })
  })

  it('does not start a replacement while a durable backup freeze is live', async () => {
    const { persistence, service } = await fixture()
    await service.bootstrap()
    await persistence.acquireBackupFreeze({
      owner: 'backup',
      now: '2026-08-11T00:00:10.000Z',
      expiresAt: '2026-08-11T00:10:00.000Z',
    })

    await expect(service.rotate()).rejects.toThrow(/frozen by backup/)
  })
})
