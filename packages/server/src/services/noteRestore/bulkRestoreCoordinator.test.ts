import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  REVISION_RESTORE_AVAILABILITY,
  SPACE_LIFECYCLE_PHASE,
  type TrashEntry,
} from '@notarium/core'

import { SYSTEM_PRINCIPAL } from '../authz'
import { InstallationReplayKey, ReplayKeyring } from '../installationReplayKey'
import { createMetaDb } from '../metaDb'
import { BulkRestoreCoordinator } from './bulkRestoreCoordinator'
import type { RestoreCommand, RestoreCommandResult } from './restoreCoordinator'

const roots: string[] = []
const CREATED_AT = '2026-08-12T00:00:00.000Z'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const trashEntry = (id: string, revisionId = `revision-${id}`): TrashEntry => ({
  noteId: id,
  title: id,
  filePath: `${id}.md`,
  class: 'user-doc',
  deletedAt: CREATED_AT,
  principal: 'ui',
  revisionId,
  contentHash: `hash-${id}`,
  restoreAvailability: REVISION_RESTORE_AVAILABILITY.full,
  stateFormat: 'markdown-v2',
})

const fixture = async (roster: TrashEntry[]) => {
  const root = await mkdtemp(join(tmpdir(), 'notarium-bulk-restore-'))
  roots.push(root)
  const metaDb = createMetaDb(`sqlite:${join(root, 'meta.db')}`)
  const replayKey = new InstallationReplayKey({
    persistence: metaDb.installationGeneration,
    keyring: new ReplayKeyring(join(root, 'replay-keys')),
    topology: 'canonical-local',
  })
  await metaDb.spaceLifecycle.ensure('space-a', SPACE_LIFECYCLE_PHASE.active, CREATED_AT)
  const writes = new Map<string, RestoreCommandResult>()
  const calls: Array<{
    command: RestoreCommand
    options?: { acceptedByParentOperationId?: string }
  }> = []
  const single = {
    execute: vi.fn(
      async (
        command: RestoreCommand,
        options?: { acceptedByParentOperationId?: string },
      ): Promise<RestoreCommandResult> => {
        calls.push({ command, options })
        const replay = writes.get(command.idempotencyKey)

        if (replay) {
          return replay
        }
        const result: RestoreCommandResult = {
          status: 'succeeded',
          operationId: `child-${command.noteId}`,
          noteId: command.noteId,
          revisionId: `restored-${command.noteId}`,
          filePath: `${command.noteId}.md`,
          versionToken: `version-${command.noteId}`,
        }

        writes.set(command.idempotencyKey, result)
        return result
      },
    ),
  }
  const spaces = { resumeLifecycle: vi.fn(async () => {}) }
  let nextOperation = 0
  const coordinator = () =>
    new BulkRestoreCoordinator({
      metaDb,
      replayKey,
      single,
      spaces,
      rosterForSelection: async () => roster,
      operationId: () => `parent-${++nextOperation}`,
      now: () => new Date(CREATED_AT),
    })

  return { metaDb, single, spaces, calls, writes, coordinator }
}

describe('BulkRestoreCoordinator', () => {
  it('freezes explicit order, deduplicates ids and replays one terminal parent', async () => {
    const f = await fixture([trashEntry('a'), trashEntry('b')])
    const command = {
      principal: SYSTEM_PRINCIPAL,
      space: 'space-a',
      idempotencyKey: 'same-command',
      ids: ['b', 'a', 'b', 'gone'],
    }
    const completed = await f.coordinator().execute(command)

    expect(completed).toMatchObject({
      status: 'completed',
      operationId: 'parent-1',
      counts: { total: 3, succeeded: 2, conflict: 1 },
      items: [
        { id: 'b', status: 'succeeded' },
        { id: 'a', status: 'succeeded' },
        { id: 'gone', status: 'conflict', reason: 'note_not_in_trash' },
      ],
    })
    expect(await f.coordinator().execute(command)).toEqual(completed)
    expect(f.writes).toHaveLength(2)

    await expect(f.coordinator().execute({ ...command, ids: ['a', 'b'] })).resolves.toEqual({
      status: 'conflict',
      operationId: 'parent-1',
      reason: 'idempotency-conflict',
    })
    await f.metaDb.close()
  })

  it('returns progress at the dispatch bound and finishes the frozen roster on recovery', async () => {
    const roster = Array.from({ length: 30 }, (_, index) => trashEntry(`note-${index}`))
    const f = await fixture(roster)
    const command = {
      principal: SYSTEM_PRINCIPAL,
      space: 'space-a',
      idempotencyKey: 'large-command',
      all: true,
      onlyRestorable: true,
    }
    const running = await f.coordinator().execute(command)

    expect(running).toMatchObject({
      status: 'running',
      operationId: 'parent-1',
      counts: { total: 30, succeeded: 25, queued: 5 },
    })
    await f.metaDb.spaceLifecycle.transition({
      space: 'space-a',
      expectedPhases: [SPACE_LIFECYCLE_PHASE.active],
      phase: SPACE_LIFECYCLE_PHASE.closing,
      changedAt: '2026-08-12T00:01:00.000Z',
    })
    await f.coordinator().recover()
    const completed = await f.coordinator().execute(command)

    expect(completed).toMatchObject({
      status: 'completed',
      operationId: 'parent-1',
      counts: { total: 30, succeeded: 30, queued: 0 },
    })
    expect(f.writes).toHaveLength(30)
    expect(f.calls).toHaveLength(30)
    expect(f.calls.every((call) => call.options?.acceptedByParentOperationId === 'parent-1')).toBe(
      true,
    )
    expect(f.spaces.resumeLifecycle).toHaveBeenCalledWith('space-a')
    await f.metaDb.close()
  })
})
