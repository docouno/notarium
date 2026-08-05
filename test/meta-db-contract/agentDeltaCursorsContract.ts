import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  AgentDeltaCursorScope,
  AgentDeltaCursorsPersistence,
  AgentSessionRecord,
  AgentSessionsPersistence,
  FolderIdentityPersistence,
  FolderRecord,
  ProjectRecord,
  ProjectsPersistence,
} from '../../packages/server/src/services/metaDb/types'

export type AgentDeltaCursorsContractFactory = () => Promise<{
  persistence: AgentDeltaCursorsPersistence
  sessions: AgentSessionsPersistence
  projects: ProjectsPersistence
  folders: FolderIdentityPersistence
  teardown?: () => Promise<void>
}>

const session = (
  id: string,
  owner: string,
  parentId: string | null = null,
): AgentSessionRecord => ({
  id,
  owner,
  name: id,
  named: true,
  parentId,
  createdAt: '2026-08-04T09:00:00.000Z',
  lastSeenAt: '2026-08-04T10:00:00.000Z',
  calls: 1,
})

const root = (owner: string, id: string): AgentDeltaCursorScope => ({
  owner,
  session: { id, parentId: null },
})

const project = (id: string, path: string): ProjectRecord => ({
  id,
  space: 'space-a',
  path,
  slug: id,
  aliases: [],
  pathAliases: [],
  displayName: id,
  status: 'active',
  lastSeen: '2026-08-04T10:00:00.000Z',
  createdAt: '2026-08-04T09:00:00.000Z',
})

const folder = (id: string, path: string): FolderRecord => ({
  id,
  space: 'space-a',
  path,
  pathAliases: [],
  lastSeen: '2026-08-04T11:00:00.000Z',
  createdAt: '2026-08-04T09:00:00.000Z',
})

export const describeAgentDeltaCursorsContract = (
  name: string,
  factory: AgentDeltaCursorsContractFactory,
): void => {
  describe(`AgentDeltaCursorsPersistence contract — ${name}`, { timeout: 15_000 }, () => {
    let persistence: AgentDeltaCursorsPersistence
    let sessions: AgentSessionsPersistence
    let projects: ProjectsPersistence
    let folders: FolderIdentityPersistence
    let teardown: (() => Promise<void>) | undefined

    beforeEach(async () => {
      ;({ persistence, sessions, projects, folders, teardown } = await factory())
      await projects.upsert(project('project-a', 'a'))
      await projects.upsert(project('project-b', 'b'))
    })

    afterEach(async () => {
      await teardown?.()
    })

    it('freezes a root session at first project-touch while owner fallback advances', async () => {
      const a = session('ses_aaaaaaaaaaaa', 'alice')
      const b = session('ses_bbbbbbbbbbbb', 'alice')
      await sessions.insert(a)
      await sessions.insert(b)
      await persistence.advance({ owner: 'alice' }, 'project-a', '10', '2026-08-04T10:00:00Z')

      expect(
        await persistence.getOrInit(root('alice', a.id), 'project-a', '2026-08-04T10:01:00Z'),
      ).toBe('10')
      await persistence.advance({ owner: 'alice' }, 'project-a', '20', '2026-08-04T10:02:00Z')
      // A's materialised position does not follow the fallback.
      expect(
        await persistence.getOrInit(root('alice', a.id), 'project-a', '2026-08-04T10:03:00Z'),
      ).toBe('10')
      // A later first-touch starts from the now-current fallback.
      expect(
        await persistence.getOrInit(root('alice', b.id), 'project-a', '2026-08-04T10:04:00Z'),
      ).toBe('20')
      // Project and owner are independent axes.
      expect(
        await persistence.getOrInit(root('alice', a.id), 'project-b', '2026-08-04T10:05:00Z'),
      ).toBeNull()
      expect(
        await persistence.getOrInit({ owner: 'bob' }, 'project-a', '2026-08-04T10:05:00Z'),
      ).toBeNull()
    })

    it('freezes an initial null instead of following a fallback created later', async () => {
      const a = session('ses_aaaaaaaaaaaa', 'alice')
      await sessions.insert(a)
      expect(
        await persistence.getOrInit(root('alice', a.id), 'project-a', '2026-08-04T10:00:00Z'),
      ).toBeNull()

      await persistence.advance({ owner: 'alice' }, 'project-a', '9', '2026-08-04T10:01:00Z')
      expect(
        await persistence.getOrInit(root('alice', a.id), 'project-a', '2026-08-04T10:02:00Z'),
      ).toBeNull()
    })

    it('initialises a fork from its parent cursor, then advances independently', async () => {
      const parent = session('ses_aaaaaaaaaaaa', 'alice')
      const fork = session('ses_bbbbbbbbbbbb', 'alice', parent.id)
      await sessions.insert(parent)
      await sessions.insert(fork)
      await persistence.advance({ owner: 'alice' }, 'project-a', '10', '2026-08-04T10:00:00Z')
      await persistence.getOrInit(root('alice', parent.id), 'project-a', '2026-08-04T10:01:00Z')
      await persistence.advance({ owner: 'alice' }, 'project-a', '30', '2026-08-04T10:02:00Z')

      const forkScope: AgentDeltaCursorScope = {
        owner: 'alice',
        session: { id: fork.id, parentId: parent.id },
      }
      expect(await persistence.getOrInit(forkScope, 'project-a', '2026-08-04T10:03:00Z')).toBe('10')

      await persistence.advance(forkScope, 'project-a', '20', '2026-08-04T10:04:00Z')
      expect(await persistence.getOrInit(forkScope, 'project-a', '2026-08-04T10:05:00Z')).toBe('20')
      expect(
        await persistence.getOrInit(root('alice', parent.id), 'project-a', '2026-08-04T10:05:00Z'),
      ).toBe('10')
      // The owner fallback was already further and never regressed to the fork's 20.
      expect(
        await persistence.getOrInit({ owner: 'alice' }, 'project-a', '2026-08-04T10:05:00Z'),
      ).toBe('30')
    })

    it('advances session and owner monotonically when stale acknowledgements finish last', async () => {
      const a = session('ses_aaaaaaaaaaaa', 'alice')
      await sessions.insert(a)
      const scope = root('alice', a.id)
      await persistence.getOrInit(scope, 'project-a', '2026-08-04T10:00:00Z')
      await persistence.advance(scope, 'project-a', '44', '2026-08-04T10:01:00Z')
      await persistence.advance(scope, 'project-a', '12', '2026-08-04T10:02:00Z')

      expect(await persistence.getOrInit(scope, 'project-a', '2026-08-04T10:03:00Z')).toBe('44')
      expect(
        await persistence.getOrInit({ owner: 'alice' }, 'project-a', '2026-08-04T10:03:00Z'),
      ).toBe('44')
    })

    it('drops owner and session positions with the project lifecycle', async () => {
      const a = session('ses_aaaaaaaaaaaa', 'alice')
      await sessions.insert(a)
      const scope = root('alice', a.id)
      await persistence.advance(scope, 'project-a', '42', '2026-08-04T10:00:00Z')
      await persistence.advance(scope, 'project-b', '84', '2026-08-04T10:01:00Z')

      await projects.delete('project-a')
      expect(
        await persistence.getOrInit({ owner: 'alice' }, 'project-a', '2026-08-04T10:02:00Z'),
      ).toBeNull()
      await expect(
        persistence.advance({ owner: 'alice' }, 'project-a', '43', '2026-08-04T10:02:00Z'),
      ).rejects.toThrow(/project|foreign key/i)

      // Re-adopting the same id proves the old session row was deleted too: a
      // getOrInit now starts from an empty owner fallback instead of rev 42.
      await projects.upsert(project('project-a', 'a'))
      expect(await persistence.getOrInit(scope, 'project-a', '2026-08-04T10:03:00Z')).toBeNull()
      expect(
        await persistence.getOrInit({ owner: 'alice' }, 'project-b', '2026-08-04T10:04:00Z'),
      ).toBe('84')
      expect(await persistence.getOrInit(scope, 'project-b', '2026-08-04T10:04:00Z')).toBe('84')
    })

    it('drops positions and rejects reinsertion when a project row flips to a folder', async () => {
      const a = session('ses_aaaaaaaaaaaa', 'alice')
      await sessions.insert(a)
      const scope = root('alice', a.id)
      await persistence.advance(scope, 'project-a', '42', '2026-08-04T10:00:00Z')

      await folders.upsert(folder('project-a', 'a'))
      expect(await projects.getById('project-a')).toBeNull()
      expect(await folders.getById('project-a')).not.toBeNull()
      expect(
        await persistence.getOrInit({ owner: 'alice' }, 'project-a', '2026-08-04T10:01:00Z'),
      ).toBeNull()
      await expect(
        persistence.advance(scope, 'project-a', '43', '2026-08-04T10:02:00Z'),
      ).rejects.toThrow(/project|foreign key/i)

      await projects.upsert(project('project-a', 'a'))
      expect(await persistence.getOrInit(scope, 'project-a', '2026-08-04T10:03:00Z')).toBeNull()
    })

    it('keeps the project and its positions when a project-to-folder retype is rejected', async () => {
      const a = session('ses_aaaaaaaaaaaa', 'alice')
      await sessions.insert(a)
      const scope = root('alice', a.id)
      await persistence.advance(scope, 'project-a', '42', '2026-08-04T10:00:00Z')

      // project-b already owns path b. The shared folders table rejects this
      // project-a retype atomically, including its cursor-cascade side effects.
      await expect(folders.upsert(folder('project-a', 'b'))).rejects.toThrow(/unique/i)

      expect(await projects.getById('project-a')).not.toBeNull()
      expect(await folders.getById('project-a')).toBeNull()
      expect(
        await persistence.getOrInit({ owner: 'alice' }, 'project-a', '2026-08-04T10:01:00Z'),
      ).toBe('42')
      expect(await persistence.getOrInit(scope, 'project-a', '2026-08-04T10:01:00Z')).toBe('42')
    })

    it('cascades a pruned session position while keeping its owner fallback', async () => {
      const a = session('ses_aaaaaaaaaaaa', 'alice')
      const scope = root('alice', a.id)
      await sessions.insert(a)
      expect(await persistence.getOrInit(scope, 'project-a', '2026-08-04T10:00:00Z')).toBeNull()

      await sessions.prune('2026-08-04T10:01:00.000Z')
      await persistence.advance({ owner: 'alice' }, 'project-a', '9', '2026-08-04T10:02:00Z')
      await sessions.insert({
        ...a,
        lastSeenAt: '2026-08-04T11:00:00.000Z',
      })
      expect(await persistence.getOrInit(scope, 'project-a', '2026-08-04T11:01:00Z')).toBe('9')
    })
  })
}
