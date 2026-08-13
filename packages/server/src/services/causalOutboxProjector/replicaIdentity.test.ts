import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { causalReplicaId } from './replicaIdentity'

const roots: string[] = []

describe('causal outbox replica identity', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('survives process reopen while independent cache roots get independent subscribers', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'notarium-replica-id-'))
    roots.push(parent)
    const firstRoot = join(parent, 'replica-a')
    const secondRoot = join(parent, 'replica-b')
    const first = await causalReplicaId(firstRoot)

    expect(await causalReplicaId(firstRoot)).toBe(first)
    expect(await causalReplicaId(secondRoot)).not.toBe(first)
  })
})
