// SqliteMetaDb: the default meta-DB driver (node:sqlite, dependency-free) and
// its two tenant facets — the identity registry (#51) and the revision journal
// (#12) — over one connection and one checksummed schema history. Pinned: init is
// idempotent; the identity facet
// round-trips records exactly; the journal facet appends in timeline order,
// content-addresses blobs by hash and windows a note's history honestly.

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IdentityRecord, RevisionInput } from '@notarium/core'

// Deep import on purpose: @notarium/server's root export pulls the whole
// Fastify host; the test needs only the driver module.
import { SqliteMetaDb } from '../../packages/server/src/services/metaDb/sqliteMetaDb'
import type {
  FavoriteRecord,
  FolderRecord,
  OAuthClientRecord,
  ProjectRecord,
  RetrievalLogInput,
  SpaceRecord,
  UserRecord,
} from '../../packages/server/src/services/metaDb/types'

const REC_A: IdentityRecord = {
  id: 'id-aaaaaaaa01',
  legacyNameAliases: [],
  addressRevision: 1,
  filePath: 'demo/a.md',
  space: 'main',
  createdAt: '2026-01-01T00:00:00Z',
  materialized: true,
  deletedAt: null,
}
const REC_B: IdentityRecord = {
  id: 'id-bbbbbbbb01',
  legacyNameAliases: [],
  addressRevision: 1,
  filePath: 'demo/b.md',
  space: 'work',
  createdAt: null,
  materialized: false,
  deletedAt: '2026-06-01T00:00:00Z',
}

const REV_SPACE = 'main'
const revInput = (over: Partial<RevisionInput> = {}): RevisionInput => ({
  noteId: 'note-1',
  space: REV_SPACE,
  baseRevisionId: null,
  theirRevisionId: null,
  sourceRevisionId: null,
  kind: 'write',
  entryRole: 'origin',
  principal: 'ui',
  contentHash: 'hash-1',
  stateFormat: null,
  title: 'Note one',
  class: null,
  slug: null,
  tags: ['x'],
  createdAt: '2026-06-12T10:00:00Z',
  charsAdded: 8,
  charsRemoved: 0,
  ...over,
})

describe('SqliteMetaDb', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    while (cleanups.length) {
      cleanups.pop()!()
    }
  })

  const make = (path = ':memory:') => {
    const db = new SqliteMetaDb(path)
    cleanups.push(() => void db.close())
    return db
  }

  describe('identity facet (#51)', () => {
    it('claimMany → loadAll round-trips records exactly (:memory:)', async () => {
      const db = make()
      expect(await db.identity.loadAll('main')).toEqual([])

      await db.identity.claimMany([REC_A, REC_B])
      // loadAll is space-scoped (#16): each registry sees only its own rows.
      expect(await db.identity.loadAll('main')).toEqual([REC_A])
      expect(await db.identity.loadAll('work')).toEqual([REC_B]) // null createdAt + tombstone survive
      // findById is the global id → (space, path) resolver behind /n/<id>.
      expect(await db.identity.findById!(REC_B.id)).toEqual(REC_B)
      expect(await db.identity.findById!('no-such-id')).toBeNull()
    })

    it('an id conflict updates the row in place — no duplicates, last write wins', async () => {
      const db = make()
      await db.identity.claimMany([REC_A])
      await db.identity.claimMany([
        {
          ...REC_A,
          filePath: 'archive/a.md',
          materialized: false,
          deletedAt: '2026-06-02T00:00:00Z',
        },
      ])
      const rows = await db.identity.loadAll('main')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({
        ...REC_A,
        addressRevision: 2,
        filePath: 'archive/a.md',
        materialized: false,
        deletedAt: '2026-06-02T00:00:00Z',
      })
    })

    it('keeps one live owner per space path and revisions address changes', async () => {
      const db = make()
      await db.identity.claimMany([REC_A])
      await expect(
        db.identity.claimMany([
          {
            ...REC_B,
            space: REC_A.space,
            filePath: REC_A.filePath,
            deletedAt: null,
          },
        ]),
      ).rejects.toThrow(/unique/i)

      await db.identity.claimMany([{ ...REC_A, deletedAt: '2026-06-03T00:00:00Z' }])
      await db.identity.claimMany([
        {
          ...REC_B,
          space: REC_A.space,
          filePath: REC_A.filePath,
          deletedAt: null,
        },
      ])

      expect(await db.identity.findById!(REC_A.id)).toMatchObject({
        addressRevision: 2,
        deletedAt: '2026-06-03T00:00:00Z',
      })
      expect(await db.identity.findById!(REC_B.id)).toMatchObject({
        addressRevision: 1,
        deletedAt: null,
      })
    })

    it('init is idempotent: re-opening the same file re-runs no migrations and loses no data', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'notarium-meta-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const path = join(dir, 'meta', 'meta.sqlite')

      const first = new SqliteMetaDb(path)
      await first.identity.init()
      await first.identity.init() // second init on the same instance must not throw either
      await first.identity.claimMany([REC_A])
      await first.close()

      const second = make(path)
      expect(await second.identity.loadAll('main')).toEqual([REC_A]) // migrations already applied — no-op
    })

    it('retries the same instance after an operator repairs a rejected untracked database', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'notarium-meta-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const path = join(dir, 'meta.sqlite')
      const untracked = new DatabaseSync(path)
      untracked.exec(`CREATE TABLE meta_schema (version INTEGER NOT NULL);
        INSERT INTO meta_schema (version) VALUES (26)`)
      untracked.close()
      const db = make(path)

      await expect(db.identity.init()).rejects.toThrow(/non-empty but has no migration ledger/)

      const repaired = new DatabaseSync(path)
      repaired.exec('DROP TABLE meta_schema')
      repaired.close()
      await expect(db.identity.init()).resolves.toBeUndefined()
      expect(await db.identity.loadAll('main')).toEqual([])
    })
  })

  describe('space registry facet (#16, reshaped #100 phase 4)', () => {
    const sp = (over: Partial<SpaceRecord> = {}): SpaceRecord => ({
      id: 'spc-main-0001',
      slug: 'main',
      displayName: 'Main',
      notesDir: 'main',
      aliases: [] as string[],
      createdAt: '2026-06-12T00:00:00Z',
      archivedAt: null,
      archivedBy: null,
      ...over,
    })
    it('upsert (by id) inserts on first sight and refreshes slug / displayName / aliases', async () => {
      const db = make()
      await db.spaces.upsert(sp())
      // A rename: same id, new slug, old slug retired into aliases. createdAt + notesDir survive.
      await db.spaces.upsert(
        sp({
          slug: 'home',
          displayName: 'Home',
          aliases: ['main'],
          createdAt: '2026-06-13T00:00:00Z',
        }),
      )
      await db.spaces.upsert(
        sp({
          id: 'spc-work-0002',
          slug: 'work',
          displayName: 'Work',
          notesDir: 'work',
          createdAt: '2026-06-13T00:00:00Z',
        }),
      )
      expect(await db.spaces.list()).toEqual([
        {
          id: 'spc-main-0001',
          slug: 'home',
          displayName: 'Home',
          notesDir: 'main',
          aliases: ['main'],
          createdAt: '2026-06-12T00:00:00Z',
          archivedAt: null,
          archivedBy: null,
        },
        {
          id: 'spc-work-0002',
          slug: 'work',
          displayName: 'Work',
          notesDir: 'work',
          aliases: [],
          createdAt: '2026-06-13T00:00:00Z',
          archivedAt: null,
          archivedBy: null,
        },
      ])
      expect(await db.spaces.getById('spc-main-0001')).toEqual(
        expect.objectContaining({ slug: 'home', aliases: ['main'] }),
      )
      // The current slug resolves; a retired slug does NOT (alias resolution lives in
      // the SpaceManager's in-memory index, not the registry's getBySlug).
      expect((await db.spaces.getBySlug('home'))?.id).toBe('spc-main-0001')
      expect(await db.spaces.getBySlug('main')).toBeNull()
    })

    it('archives (round-trips archived_at) and restores via upsert (#110)', async () => {
      const db = make()
      await db.spaces.upsert(sp())
      // Archive = set archived_at + archived_by; the row is otherwise untouched.
      await db.spaces.upsert(sp({ archivedAt: '2026-06-23T12:00:00Z', archivedBy: 'user:al' }))
      const archived = await db.spaces.getById('spc-main-0001')
      expect(archived?.archivedAt).toBe('2026-06-23T12:00:00Z')
      expect(archived?.archivedBy).toBe('user:al') // who deleted it (#110), for the "deleted by" line
      // The slug stays UNIQUE and reachable while archived (the handle is held).
      expect((await db.spaces.getBySlug('main'))?.id).toBe('spc-main-0001')
      // Restore = clear both back to null.
      await db.spaces.upsert(sp({ archivedAt: null, archivedBy: null }))
      const restored = await db.spaces.getById('spc-main-0001')
      expect(restored?.archivedAt).toBeNull()
      expect(restored?.archivedBy).toBeNull()
    })

    it('atomically grants only while the stable space id exists and is active', async () => {
      const db = make()
      await db.spaces.upsert(sp())

      await expect(
        db.grantMemberToActiveSpace('spc-main-0001', 'al', 'reader', '2026-08-02T12:00:00Z'),
      ).resolves.toEqual({ status: 'granted', space: sp() })
      expect(await db.auth.grantsFor('al')).toEqual([{ space: 'spc-main-0001', role: 'reader' }])

      const archived = sp({
        archivedAt: '2026-08-02T12:01:00Z',
        archivedBy: 'user:admin',
      })
      await db.spaces.upsert(archived)
      await expect(
        db.grantMemberToActiveSpace('spc-main-0001', 'al', 'owner', '2026-08-02T12:02:00Z'),
      ).resolves.toEqual({ status: 'archived', space: archived })
      expect(await db.auth.grantsFor('al')).toEqual([{ space: 'spc-main-0001', role: 'reader' }])

      await db.purgeSpace('spc-main-0001')
      await expect(
        db.grantMemberToActiveSpace('spc-main-0001', 'al', 'owner', '2026-08-02T12:03:00Z'),
      ).resolves.toEqual({ status: 'missing' })
      expect(await db.auth.grantsFor('al')).toEqual([])
    })

    it('purgeSpace erases every child place + the row, scrubs PATs, spares other spaces (#110)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'notarium-purge-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const path = join(dir, 'meta.sqlite')
      const db = make(path)
      const inspect = new DatabaseSync(path)
      cleanups.push(() => inspect.close())
      const victim = 'spc-gone-0001'
      const keep = 'spc-keep-0002'
      await db.spaces.upsert(
        sp({
          id: victim,
          slug: 'gone',
          notesDir: 'gone',
          aliases: ['retired-gone', 'shared-retired'],
        }),
      )
      await db.spaces.upsert(
        sp({
          id: keep,
          slug: 'keep',
          notesDir: 'keep',
          aliases: ['shared-retired'],
        }),
      )
      // Seed rows across the child places for BOTH spaces (only the victim's go).
      await db.identity.claimMany([
        {
          id: 'n-gone',
          legacyNameAliases: [],
          filePath: 'a.md',
          space: victim,
          createdAt: null,
          materialized: true,
          deletedAt: null,
        },
        {
          id: 'n-keep',
          legacyNameAliases: [],
          filePath: 'a.md',
          space: keep,
          createdAt: null,
          materialized: true,
          deletedAt: null,
        },
      ])
      // Both notes reference the SAME blob (same contentHash) so the purge's CAS GC is
      // exercised: the blob must survive because the kept space still references it.
      await db.revisions.append(
        revInput({ noteId: 'n-gone', space: victim, contentHash: 'sh1', title: 'G' }),
        'shared body',
      )
      await db.revisions.append(
        revInput({ noteId: 'n-keep', space: keep, contentHash: 'sh1', title: 'K' }),
        'shared body',
      )
      await db.auth.createUser({
        id: 'al',
        username: 'al',
        email: null,
        displayName: 'Al',
        passwordHash: null,
        admin: false,
        disabledAt: null,
        createdAt: 'x',
        personalSpace: keep,
      })
      await db.auth.upsertMember(victim, 'al', 'owner', 'x')
      await db.auth.upsertMember(keep, 'al', 'owner', 'x')
      await db.auth.insertPat({
        id: 'p-both',
        userId: 'al',
        name: 'both',
        secretHash: 'h',
        scope: 'read',
        spaces: [victim, keep],
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: 'x',
      })
      await db.auth.insertPat({
        id: 'p-only',
        userId: 'al',
        name: 'only',
        secretHash: 'h',
        scope: 'read',
        spaces: [victim],
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: 'x',
      })
      await db.favorites.add({
        owner: 'user:al',
        space: victim,
        kind: 'note',
        entityId: 'n-gone',
        createdAt: '2026-06-23T12:00:00Z',
        rank: null,
      })
      await db.favorites.add({
        owner: 'user:al',
        space: keep,
        kind: 'note',
        entityId: 'n-keep',
        createdAt: '2026-06-23T12:00:00Z',
        rank: null,
      })
      // Context sets (#209): a set homed in the victim, and a KEEP-homed set attached to
      // a target in the victim — purge drops the victim's set AND the stale attachment,
      // but spares the keep-homed set itself.
      await db.contextSets.createSet({
        id: 'set-gone',
        homeSpace: victim,
        name: 'Gone',
        items: [],
        createdAt: 'x',
      })
      // set-keep carries an ITEM from the victim space — the symmetric case to the scope-pin
      // below: purge must NOT rewrite the set's item list (it degrades at resolve, not eagerly).
      await db.contextSets.createSet({
        id: 'set-keep',
        homeSpace: keep,
        name: 'Keep',
        items: [{ space: victim, noteId: 'n-victim-item' }],
        createdAt: 'x',
      })
      await db.contextSets.attach({
        setId: 'set-keep',
        targetKind: 'project',
        targetId: 'proj-in-victim',
        targetSpace: victim,
        createdAt: 'x',
      })
      // Scope pins (#209): one pinned INTO the victim scope (gone with the scope), one
      // pinned into a KEEP scope but referencing a victim-space note (the row survives —
      // its cross-space ref degrades honestly at resolve, never eagerly swept).
      await db.scopePins.addPin({
        targetKind: 'personal',
        targetId: victim,
        targetSpace: victim,
        noteSpace: keep,
        noteId: 'n-keep',
        createdAt: 'x',
      })
      await db.scopePins.addPin({
        targetKind: 'personal',
        targetId: keep,
        targetSpace: keep,
        noteSpace: victim,
        noteId: 'n-gone',
        createdAt: 'x',
      })
      // Context order (#210): an overlay for a victim scope (swept) and a keep scope (survives).
      await db.contextOrder.setOrder('personal', victim, victim, [
        { entryKind: 'pin', entryRef: 'n-keep' },
      ])
      await db.contextOrder.setOrder('personal', keep, keep, [
        { entryKind: 'pin', entryRef: 'n-gone' },
      ])
      await db.projects.upsert({
        id: 'project-gone',
        space: victim,
        path: '',
        slug: 'gone',
        aliases: [],
        pathAliases: [],
        displayName: 'Gone',
        status: 'active',
        lastSeen: 'x',
        createdAt: 'x',
      })
      await db.projects.upsert({
        id: 'project-keep',
        space: keep,
        path: '',
        slug: 'keep',
        aliases: [],
        pathAliases: [],
        displayName: 'Keep',
        status: 'active',
        lastSeen: 'x',
        createdAt: 'x',
      })
      await db.sessions.insert({
        id: 'ses_aaaaaaaaaaaa',
        owner: 'al',
        name: 'purge probe',
        named: true,
        parentId: null,
        createdAt: 'x',
        lastSeenAt: 'x',
        calls: 1,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      })
      const sessionCursor = {
        owner: 'al',
        session: { id: 'ses_aaaaaaaaaaaa', parentId: null },
      }
      await db.agentDeltaCursors.advance(sessionCursor, 'project-gone', '77', 'x')
      await db.agentDeltaCursors.advance(sessionCursor, 'project-keep', '88', 'x')
      // Child rows were written while the space was active. Archive only after seeding:
      // the lifecycle gate intentionally rejects new space-owned writes after closing.
      await db.spaces.upsert(
        sp({
          id: victim,
          slug: 'gone',
          notesDir: 'gone',
          aliases: ['retired-gone', 'shared-retired'],
          archivedAt: '2026-06-23T12:00:00Z',
        }),
      )

      await db.purgeSpace(victim)

      // The victim is gone everywhere; the kept space is untouched.
      expect(await db.spaces.getById(victim)).toBeNull()
      expect(await db.spaces.getById(keep)).not.toBeNull()
      expect(await db.identity.loadAll(victim)).toEqual([])
      expect((await db.identity.loadAll(keep)).map((r) => r.id)).toEqual(['n-keep'])
      // The victim's journal is gone; the kept space's revision (and the SHARED blob it
      // still references) survives — CAS GC drops a blob only when its LAST referrer goes.
      expect(await db.revisions.latestFor(victim, 'n-gone')).toBeNull()
      expect((await db.revisions.latestFor(keep, 'n-keep'))?.contentHash).toBe('sh1')
      expect(await db.revisions.content('sh1')).toBe('shared body')
      await expect(
        db.revisions.append(
          revInput({ noteId: 'late-gone', space: victim, contentHash: 'late-gone-hash' }),
          'late body',
        ),
      ).rejects.toThrow(/revision target was permanently purged: space/)
      // Membership of the victim gone; the kept grant stays.
      expect((await db.auth.grantsFor('al')).map((g) => g.space)).toEqual([keep])
      // Favorites are UI state scoped to the stable space id; purge removes only
      // rows for the deleted space.
      expect(await db.favorites.list('user:al', victim)).toEqual([])
      expect((await db.favorites.list('user:al', keep)).map((f) => f.entityId)).toEqual(['n-keep'])
      // PAT narrowing: the victim id scrubbed; an emptied list stays [] (no access), the
      // mixed one keeps the survivor — NEVER widened to null/all (fail-closed, v14 rule).
      expect((await db.auth.getPat('p-both'))?.spaces).toEqual([keep])
      expect((await db.auth.getPat('p-only'))?.spaces).toEqual([])
      // Project cursor partitions follow the purged project while the sibling
      // project's session and owner positions survive unchanged.
      expect(await db.agentDeltaCursors.getOrInit({ owner: 'al' }, 'project-gone', 'y')).toBeNull()
      expect(
        inspect
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM mcp_delta_owner_cursors WHERE project = ?) AS owners,
               (SELECT COUNT(*) FROM mcp_delta_session_cursors WHERE project = ?) AS sessions`,
          )
          .get('project-gone', 'project-gone'),
      ).toEqual({ owners: 0, sessions: 0 })
      expect(await db.agentDeltaCursors.getOrInit({ owner: 'al' }, 'project-keep', 'y')).toBe('88')
      expect(await db.agentDeltaCursors.getOrInit(sessionCursor, 'project-keep', 'y')).toBe('88')
      // Context sets: the victim-homed set is gone; the keep-homed set survives, but its
      // attachment to the (now-purged) victim target was cascaded away.
      expect(await db.contextSets.getSet('set-gone')).toBeNull()
      const keptSet = await db.contextSets.getSet('set-keep')
      expect(keptSet).not.toBeNull()
      // The victim-space ITEM ref SURVIVES in the set definition — purge doesn't sweep set
      // items by note space; the item simply degrades (drops) at per-reader resolve time.
      expect(keptSet?.items).toEqual([{ space: victim, noteId: 'n-victim-item' }])
      expect(await db.contextSets.attachmentsForSet('set-keep')).toEqual([])
      // Scope pins: the victim-scoped pin is gone; the keep-scoped one (a stale victim-note
      // ref) survives — resolution drops it honestly, purge doesn't sweep by note space.
      expect(await db.scopePins.pinsForTarget('personal', victim)).toEqual([])
      expect((await db.scopePins.pinsForTarget('personal', keep)).map((p) => p.noteId)).toEqual([
        'n-gone',
      ])
      // Context order: the victim-scope overlay is swept; the keep-scope overlay survives.
      expect(await db.contextOrder.orderForTarget('personal', victim)).toEqual([])
      expect(
        (await db.contextOrder.orderForTarget('personal', keep)).map((r) => r.entryRef),
      ).toEqual(['n-gone'])
    })
  })

  describe('context-sets facet (#209, v21)', () => {
    it('CRUD + cross-space items round-trip; delete cascades attachments', async () => {
      const db = make()
      await db.contextSets.createSet({
        id: 'cs1',
        homeSpace: 'spc-home',
        name: 'Front',
        items: [{ space: 'spc-a', noteId: 'n1' }],
        createdAt: '2026-07-07T00:00:00Z',
      })
      const got = await db.contextSets.getSet('cs1')
      expect(got?.name).toBe('Front')
      expect(got?.items).toEqual([{ space: 'spc-a', noteId: 'n1' }])

      // addItem is atomic + idempotent by noteId and returns the updated set.
      const added = await db.contextSets.addItem('cs1', { space: 'spc-b', noteId: 'n2' })
      expect(added?.items).toEqual([
        { space: 'spc-a', noteId: 'n1' },
        { space: 'spc-b', noteId: 'n2' },
      ])
      // Re-adding the same note is a no-op (no duplicate row in the items array).
      const readd = await db.contextSets.addItem('cs1', { space: 'spc-b', noteId: 'n2' })
      expect(readd?.items).toHaveLength(2)
      expect((await db.contextSets.getSet('cs1'))?.items).toHaveLength(2)
      // removeItem drops by noteId and returns the updated set; a missing set → null.
      const removed = await db.contextSets.removeItem('cs1', { space: 'spc-b', noteId: 'n2' })
      expect(removed?.items).toEqual([{ space: 'spc-a', noteId: 'n1' }])
      expect(await db.contextSets.addItem('missing', { space: 'spc-a', noteId: 'x' })).toBeNull()
      expect(await db.contextSets.removeItem('missing', { space: 'spc-a', noteId: 'x' })).toBeNull()
      // Re-add n2 so the rest of the flow (attach/detach/delete) sees a 2-item set.
      await db.contextSets.addItem('cs1', { space: 'spc-b', noteId: 'n2' })
      expect((await db.contextSets.getSet('cs1'))?.items).toHaveLength(2)
      await db.contextSets.renameSet('cs1', 'Front v2')
      expect((await db.contextSets.getSet('cs1'))?.name).toBe('Front v2')
      expect((await db.contextSets.listSetsForSpace('spc-home')).map((s) => s.id)).toEqual(['cs1'])

      // Attach to two scopes; setsForTarget is the resolution query.
      await db.contextSets.attach({
        setId: 'cs1',
        targetKind: 'project',
        targetId: 'proj-x',
        targetSpace: 'spc-proj',
        createdAt: 'x',
      })
      await db.contextSets.attach({
        setId: 'cs1',
        targetKind: 'personal',
        targetId: 'spc-me',
        targetSpace: 'spc-me',
        createdAt: 'x',
      })
      await db.contextSets.attach({
        setId: 'cs1',
        targetKind: 'role',
        targetId: 'project:proj-x:AbCdefGhij_1',
        targetSpace: 'spc-proj',
        createdAt: 'x',
      })
      expect((await db.contextSets.setsForTarget('project', 'proj-x')).map((s) => s.id)).toEqual([
        'cs1',
      ])
      expect((await db.contextSets.setsForTarget('personal', 'spc-me')).map((s) => s.id)).toEqual([
        'cs1',
      ])
      expect(
        (await db.contextSets.setsForTarget('role', 'project:proj-x:AbCdefGhij_1')).map(
          (s) => s.id,
        ),
      ).toEqual(['cs1'])
      expect(await db.contextSets.attachmentsForSet('cs1')).toHaveLength(3)

      // attach upserts (no duplicate on the same target key).
      await db.contextSets.attach({
        setId: 'cs1',
        targetKind: 'project',
        targetId: 'proj-x',
        targetSpace: 'spc-proj',
        createdAt: 'y',
      })
      expect(await db.contextSets.attachmentsForSet('cs1')).toHaveLength(3)
      await db.contextSets.detach('cs1', 'project', 'proj-x', 's1')
      expect(await db.contextSets.setsForTarget('project', 'proj-x')).toEqual([])

      // delete cascades the remaining attachment.
      await db.contextSets.deleteSet('cs1')
      expect(await db.contextSets.getSet('cs1')).toBeNull()
      expect(await db.contextSets.setsForTarget('personal', 'spc-me')).toEqual([])
    })

    it('addItem/removeItem are ATOMIC: concurrent mutations do not lose an update', async () => {
      const db = make()
      await db.contextSets.createSet({
        id: 'cs2',
        homeSpace: 'spc-home',
        name: 'Race',
        items: [],
        createdAt: 'x',
      })
      // Two concurrent adds — the whole point of replacing the read-modify-write updateSetItems:
      // neither may clobber the other (sqlite runs each add as one synchronous SELECT+UPDATE
      // span after ensureInit; a regression that reinserts an await between them would drop one).
      await Promise.all([
        db.contextSets.addItem('cs2', { space: 'spc-a', noteId: 'a' }),
        db.contextSets.addItem('cs2', { space: 'spc-b', noteId: 'b' }),
      ])
      expect((await db.contextSets.getSet('cs2'))?.items.map((i) => i.noteId).sort()).toEqual([
        'a',
        'b',
      ])
      // Concurrent add + remove of DIFFERENT ids likewise both land.
      await Promise.all([
        db.contextSets.addItem('cs2', { space: 'spc-c', noteId: 'c' }),
        db.contextSets.removeItem('cs2', { space: 'spc-a', noteId: 'a' }),
      ])
      expect((await db.contextSets.getSet('cs2'))?.items.map((i) => i.noteId).sort()).toEqual([
        'b',
        'c',
      ])
    })

    it('reorderItems (#210) is SLOT-PRESERVING: full reorder permutes; a partial sequence leaves unnamed items in place', async () => {
      const db = make()
      await db.contextSets.createSet({
        id: 'cs3',
        homeSpace: 'spc-home',
        name: 'Order',
        items: [
          { space: 'sp', noteId: 'a' },
          { space: 'sp', noteId: 'b' },
          { space: 'sp', noteId: 'c' },
        ],
        createdAt: 'x',
      })
      // A full sequence permutes every slot.
      const ref = (noteId: string) => ({ space: 'sp', noteId })
      const r = await db.contextSets.reorderItems('cs3', ['c', 'a', 'b'].map(ref))
      expect(r?.items.map((i) => i.noteId)).toEqual(['c', 'a', 'b'])
      // A PARTIAL sequence (a member the reordering view couldn't see): only the NAMED slots are
      // permuted; the unnamed 'c' keeps its ORIGINAL slot (index 0), NOT shoved to the tail — so a
      // deduped-hidden member isn't silently relocated across every scope the set attaches to. An
      // unknown id ('zzz') is ignored.
      const r2 = await db.contextSets.reorderItems('cs3', ['b', 'zzz', 'a'].map(ref))
      expect(r2?.items.map((i) => i.noteId)).toEqual(['c', 'b', 'a'])
      expect(await db.contextSets.reorderItems('missing', [ref('a')])).toBeNull()
    })
  })

  describe('context-order facet (#210, v24)', () => {
    it('setOrder REPLACES a scope order (dense ranks); orderForTarget reads it back, scoped', async () => {
      const db = make()
      await db.contextOrder.setOrder('personal', 'spc-me', 'spc-me', [
        { entryKind: 'set', entryRef: 's1' },
        { entryKind: 'pin', entryRef: 'n1' },
        { entryKind: 'pin', entryRef: 'n2' },
      ])
      // A DIFFERENT scope is independent.
      await db.contextOrder.setOrder('project', 'proj-x', 'spc-proj', [
        { entryKind: 'pin', entryRef: 'n9' },
      ])
      await db.contextOrder.setOrder('role', 'project:proj-x:AbCdefGhij_1', 'spc-proj', [
        { entryKind: 'set', entryRef: 'role-set' },
      ])

      const rows = await db.contextOrder.orderForTarget('personal', 'spc-me')
      expect(rows.map((r) => [r.entryKind, r.entryRef, r.rank])).toEqual([
        ['set', 's1', 0],
        ['pin', 'n1', 1],
        ['pin', 'n2', 2],
      ])
      expect(
        (await db.contextOrder.orderForTarget('project', 'proj-x')).map((r) => r.entryRef),
      ).toEqual(['n9'])
      expect(
        (await db.contextOrder.orderForTarget('role', 'project:proj-x:AbCdefGhij_1')).map(
          (r) => r.entryRef,
        ),
      ).toEqual(['role-set'])

      // A re-order REPLACES the whole overlay (no stale rows, ranks re-densified).
      await db.contextOrder.setOrder('personal', 'spc-me', 'spc-me', [
        { entryKind: 'pin', entryRef: 'n2' },
        { entryKind: 'set', entryRef: 's1' },
      ])
      expect(
        (await db.contextOrder.orderForTarget('personal', 'spc-me')).map((r) => [
          r.entryRef,
          r.rank,
        ]),
      ).toEqual([
        ['n2', 0],
        ['s1', 1],
      ])

      // An empty order clears the scope.
      await db.contextOrder.setOrder('personal', 'spc-me', 'spc-me', [])
      expect(await db.contextOrder.orderForTarget('personal', 'spc-me')).toEqual([])
    })

    it('setOrder DEDUPS a duplicate (entryKind, entryRef) — first wins, no PRIMARY KEY crash', async () => {
      const db = make()
      await db.contextOrder.setOrder('personal', 'spc-me', 'spc-me', [
        { entryKind: 'pin', entryRef: 'n1' },
        { entryKind: 'set', entryRef: 'n1' }, // a set may legitimately share an id shape — NOT a dup
        { entryKind: 'pin', entryRef: 'n1' }, // the real duplicate → dropped
        { entryKind: 'pin', entryRef: 'n2' },
      ])
      expect(
        (await db.contextOrder.orderForTarget('personal', 'spc-me')).map((r) => [
          r.entryKind,
          r.entryRef,
          r.rank,
        ]),
      ).toEqual([
        ['pin', 'n1', 0],
        ['set', 'n1', 1],
        ['pin', 'n2', 2],
      ])
    })
  })

  describe('scope-pins facet (#209, v22)', () => {
    it('add/remove cross-space pins; re-pin upserts; pinsForTarget is scoped', async () => {
      const db = make()
      // Two notes from FOREIGN spaces pinned into one personal scope, plus a project scope.
      await db.scopePins.addPin({
        targetKind: 'personal',
        targetId: 'spc-me',
        targetSpace: 'spc-me',
        noteSpace: 'spc-a',
        noteId: 'n1',
        createdAt: '2026-07-07T00:00:00Z',
      })
      await db.scopePins.addPin({
        targetKind: 'personal',
        targetId: 'spc-me',
        targetSpace: 'spc-me',
        noteSpace: 'spc-b',
        noteId: 'n2',
        createdAt: '2026-07-07T00:00:01Z',
      })
      await db.scopePins.addPin({
        targetKind: 'project',
        targetId: 'proj-x',
        targetSpace: 'spc-proj',
        noteSpace: 'spc-a',
        noteId: 'n1',
        createdAt: 'x',
      })
      await db.scopePins.addPin({
        targetKind: 'role',
        targetId: 'project:proj-x:AbCdefGhij_1',
        targetSpace: 'spc-proj',
        noteSpace: 'spc-b',
        noteId: 'n-role',
        createdAt: 'x',
      })

      expect((await db.scopePins.pinsForTarget('personal', 'spc-me')).map((p) => p.noteId)).toEqual(
        ['n1', 'n2'],
      )
      expect((await db.scopePins.pinsForTarget('project', 'proj-x')).map((p) => p.noteId)).toEqual([
        'n1',
      ])
      expect(
        (await db.scopePins.pinsForTarget('role', 'project:proj-x:AbCdefGhij_1')).map(
          (p) => p.noteId,
        ),
      ).toEqual(['n-role'])
      expect((await db.scopePins.pinsForTarget('personal', 'spc-me'))[0].noteSpace).toBe('spc-a')

      // Re-pinning the SAME (scope, note) upserts — never a duplicate.
      await db.scopePins.addPin({
        targetKind: 'personal',
        targetId: 'spc-me',
        targetSpace: 'spc-me',
        noteSpace: 'spc-a2',
        noteId: 'n1',
        createdAt: 'later',
      })
      const after = await db.scopePins.pinsForTarget('personal', 'spc-me')
      expect(after).toHaveLength(2)
      expect(after.find((p) => p.noteId === 'n1')?.noteSpace).toBe('spc-a2')

      // Remove is by (scope, note); the same note in ANOTHER scope is untouched.
      await db.scopePins.removePin('personal', 'spc-me', 'spc-me', 'n1')
      expect((await db.scopePins.pinsForTarget('personal', 'spc-me')).map((p) => p.noteId)).toEqual(
        ['n2'],
      )
      expect((await db.scopePins.pinsForTarget('project', 'proj-x')).map((p) => p.noteId)).toEqual([
        'n1',
      ])
      expect(
        (await db.scopePins.pinsForTarget('role', 'project:proj-x:AbCdefGhij_1')).map(
          (p) => p.noteId,
        ),
      ).toEqual(['n-role'])
    })
  })

  describe('project registry facet (#13, v10)', () => {
    const proj = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
      id: 'proj-aaaaaa01',
      space: 'team',
      path: 'billing',
      slug: 'billing',
      aliases: [],
      pathAliases: [],
      displayName: 'Billing',
      status: 'active',
      lastSeen: '2026-06-18T00:00:00Z',
      createdAt: '2026-06-18T00:00:00Z',
      ...over,
    })

    it('upsert → getById round-trips; re-upsert refreshes derived fields but PRESERVES created_at', async () => {
      const db = make()
      expect(await db.projects.getById('proj-aaaaaa01')).toBeNull()
      await db.projects.upsert(proj())
      expect(await db.projects.getById('proj-aaaaaa01')).toEqual(proj())
      // A confirming scan moves path/displayName/status/lastSeen; the mint moment stays.
      await db.projects.upsert(
        proj({
          path: 'finance/billing',
          displayName: 'Billing v2',
          status: 'archived',
          lastSeen: '2026-06-19T00:00:00Z',
          createdAt: '2099-01-01T00:00:00Z',
        }),
      )
      expect(await db.projects.getById('proj-aaaaaa01')).toEqual(
        proj({
          path: 'finance/billing',
          displayName: 'Billing v2',
          status: 'archived',
          lastSeen: '2026-06-19T00:00:00Z',
        }),
      )
    })

    it('aliases (#100 phase 2) persist through the v12 column: [] round-trips, a non-empty list survives, refresh overwrites', async () => {
      const db = make()
      // Default [] stored as NULL → read back as [] (never undefined — the resolver
      // calls .some on it). A non-empty list JSON-round-trips. A re-upsert with a
      // different set overwrites (a rename advancing the history).
      await db.projects.upsert(proj({ aliases: [] }))
      expect((await db.projects.getById('proj-aaaaaa01'))!.aliases).toEqual([])
      await db.projects.upsert(proj({ slug: 'guides', aliases: ['billing', 'docs'] }))
      expect((await db.projects.getById('proj-aaaaaa01'))!.aliases).toEqual(['billing', 'docs'])
      await db.projects.upsert(proj({ slug: 'billing', aliases: ['guides'] }))
      expect((await db.projects.getById('proj-aaaaaa01'))!.aliases).toEqual(['guides'])
    })

    it('handle resolve: getByHandle is exact (space, slug); archived rows still resolve', async () => {
      const db = make()
      await db.projects.upsert(proj({ status: 'archived' }))
      expect(await db.projects.getByHandle('team', 'billing')).toMatchObject({
        id: 'proj-aaaaaa01',
      })
      expect(await db.projects.getByHandle('other', 'billing')).toBeNull()
    })

    it('UNIQUE(space,slug)/(space,path) is enforced: a DIFFERENT id claiming the same handle/path throws (I0c marker-scan must reckon with this)', async () => {
      const db = make()
      await db.projects.upsert(proj({ id: 'p1', space: 'team', slug: 'billing', path: 'billing' }))
      // Same id re-upsert (a confirming scan) is fine — it updates in place.
      await expect(
        db.projects.upsert(proj({ id: 'p1', space: 'team', slug: 'billing', path: 'finance' })),
      ).resolves.toBeUndefined()
      // A NEW id with the same (space, slug) violates idx_projects_space_slug.
      await expect(
        db.projects.upsert(proj({ id: 'p2', space: 'team', slug: 'billing', path: 'other' })),
      ).rejects.toThrow()
      // A NEW id with the same (space, path) violates idx_projects_space_path
      // (p1's path is now 'finance' after the in-place update above).
      await expect(
        db.projects.upsert(proj({ id: 'p3', space: 'team', slug: 'fresh', path: 'finance' })),
      ).rejects.toThrow()
    })

    it('bare-slug + list queries are membership-scoped (anti-enumeration #16) — a foreign space never leaks', async () => {
      const db = make()
      await db.projects.upsert(proj({ id: 'p1', space: 'team', slug: 'billing', path: 'billing' }))
      await db.projects.upsert(proj({ id: 'p2', space: 'ops', slug: 'billing', path: 'billing' }))
      await db.projects.upsert(proj({ id: 'p3', space: 'team', slug: 'roadmap', path: 'roadmap' }))
      // findBySlug only over reachable spaces: 'billing' is ambiguous across team+ops,
      // but a principal who only reaches 'team' sees exactly one (no foreign leak).
      expect((await db.projects.findBySlug('billing', ['team'])).map((p) => p.id)).toEqual(['p1'])
      expect(
        (await db.projects.findBySlug('billing', ['team', 'ops'])).map((p) => p.id).sort(),
      ).toEqual(['p1', 'p2'])
      expect(await db.projects.findBySlug('billing', [])).toEqual([]) // empty reach → nothing
      // listForSpaces likewise: only the reachable set.
      expect((await db.projects.listForSpaces(['team'])).map((p) => p.id)).toEqual(['p1', 'p3'])
      expect(await db.projects.listForSpaces([])).toEqual([])
      // listForSpace is one space's rows, path-ordered (note→project nearest-ancestor).
      expect((await db.projects.listForSpace('team')).map((p) => p.path)).toEqual([
        'billing',
        'roadmap',
      ])
    })

    it('renamePrefix re-prefixes the moved folder + its descendants, segment-boundary safe, scoped to the space (#13 I3)', async () => {
      const db = make()
      await db.projects.upsert(proj({ id: 'p1', space: 'team', slug: 'docs', path: 'docs' }))
      await db.projects.upsert(proj({ id: 'p2', space: 'team', slug: 'sub', path: 'docs/sub' })) // nested project
      await db.projects.upsert(proj({ id: 'p3', space: 'team', slug: 'docsx', path: 'docsx' })) // boundary trap
      await db.projects.upsert(proj({ id: 'p4', space: 'team', slug: 'other', path: 'other' }))
      await db.projects.upsert(proj({ id: 'p5', space: 'ops', slug: 'docs', path: 'docs' })) // another space
      // Move 'docs' → 'archive/docs' in team (the marker traveled with the folder).
      await db.projects.renamePrefix('team', 'docs', 'archive/docs')
      expect((await db.projects.getById('p1'))?.path).toBe('archive/docs') // the folder itself
      expect((await db.projects.getById('p2'))?.path).toBe('archive/docs/sub') // descendant follows
      expect((await db.projects.getById('p3'))?.path).toBe('docsx') // `docs` never catches `docsx`
      expect((await db.projects.getById('p4'))?.path).toBe('other') // untouched
      expect((await db.projects.getById('p5'))?.path).toBe('docs') // other space untouched
      // id + slug are immutable across the move.
      expect(await db.projects.getByHandle('team', 'docs')).toMatchObject({
        id: 'p1',
        path: 'archive/docs',
      })
      // No-op when source === destination.
      await db.projects.renamePrefix('team', 'archive/docs', 'archive/docs')
      expect((await db.projects.getById('p1'))?.path).toBe('archive/docs')
      // Astral/emoji folder name: the cut MUST be SQL length() (char count), not JS
      // .length (UTF-16 units) — else the descendant is left stale (1 astral char = 2
      // code units). '📁' is one codepoint but `'📁'.length === 2`.
      await db.projects.upsert(proj({ id: 'e1', space: 'team', slug: 'emoji', path: '📁x' }))
      await db.projects.upsert(proj({ id: 'e2', space: 'team', slug: 'emojisub', path: '📁x/sub' }))
      await db.projects.renamePrefix('team', '📁x', 'arch/📁x')
      expect((await db.projects.getById('e1'))?.path).toBe('arch/📁x')
      expect((await db.projects.getById('e2'))?.path).toBe('arch/📁x/sub') // descendant follows past the astral char
    })
  })

  describe('folder-identity facet (#100 phase 3, v13 — shared `folders` table)', () => {
    const folder = (over: Partial<FolderRecord> = {}): FolderRecord => ({
      id: 'fold-aaaa01',
      space: 'team',
      path: 'archive',
      pathAliases: [],
      lastSeen: '2026-06-22T00:00:00Z',
      createdAt: '2026-06-22T00:00:00Z',
      ...over,
    })
    const proj = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
      id: 'proj-aaaa01',
      space: 'team',
      path: 'billing',
      slug: 'billing',
      aliases: [],
      pathAliases: [],
      displayName: 'Billing',
      status: 'active',
      lastSeen: '2026-06-22T00:00:00Z',
      createdAt: '2026-06-22T00:00:00Z',
      ...over,
    })

    it('upsert → byPath/getById round-trips; a type=folder row is invisible to the projects facet', async () => {
      const db = make()
      await db.folders.upsert(folder({ id: 'f1', path: 'archive', pathAliases: ['old-notes'] }))
      expect(await db.folders.byPath('team', 'archive')).toMatchObject({
        id: 'f1',
        path: 'archive',
        pathAliases: ['old-notes'],
      })
      expect(await db.folders.getById('f1')).toMatchObject({ id: 'f1' })
      // The projects facet (type='project') must NEVER see it (#102 isolation).
      expect(await db.projects.getById('f1')).toBeNull()
      expect(await db.projects.listForSpace('team')).toHaveLength(0)
    })

    it('many folders with empty slug coexist (partial UNIQUE(space,slug) WHERE type=project)', async () => {
      const db = make()
      await db.folders.upsert(folder({ id: 'f1', path: 'a' }))
      await db.folders.upsert(folder({ id: 'f2', path: 'b' }))
      await db.folders.upsert(folder({ id: 'f3', path: 'c' }))
      expect(await db.folders.listForSpace('team')).toHaveLength(3) // slug='' for all → no slug collision
    })

    it('aliasesForSpace is CROSS-type: a moved project AND a plain folder both appear; never-moved excluded', async () => {
      const db = make()
      await db.projects.upsert(
        proj({ id: 'p1', path: 'docs', slug: 'docs', pathAliases: ['old-docs'] }),
      )
      await db.projects.upsert(proj({ id: 'p2', path: 'unmoved', slug: 'unmoved' })) // no path-history
      await db.folders.upsert(folder({ id: 'f1', path: 'arch', pathAliases: ['old-arch'] }))
      const aliases = await db.folders.aliasesForSpace('team')
      expect(aliases.map((a) => a.id).sort()).toEqual(['f1', 'p1']) // p2 (no history) excluded
    })

    it('the global UNIQUE(space,path) is cross-type: a folder cannot claim a project path', async () => {
      const db = make()
      await db.projects.upsert(proj({ id: 'p1', path: 'shared', slug: 'shared' }))
      await expect(db.folders.upsert(folder({ id: 'f1', path: 'shared' }))).rejects.toThrow(
        /UNIQUE/,
      )
    })

    it('delete drops only the folder row (type-scoped)', async () => {
      const db = make()
      await db.folders.upsert(folder({ id: 'f1', path: 'a' }))
      await db.folders.delete('f1')
      expect(await db.folders.getById('f1')).toBeNull()
    })
  })

  describe('favorites facet (#42, v18)', () => {
    const fav = (over: Partial<FavoriteRecord> = {}): FavoriteRecord => ({
      owner: 'user:al',
      space: 'team',
      kind: 'note',
      entityId: 'n1',
      createdAt: '2026-06-23T10:00:00.000Z',
      rank: null,
      ...over,
    })

    it('unfavorites through the id the client still holds after a settlement', async () => {
      // The route resolves the note before it calls, exactly as it does for `add` —
      // and a settlement can commit in between, taking the favourite with it onto the
      // successor id. Removing only the id the caller named leaves the row on screen
      // after an unfavorite that answered ok (#327).
      const db = make()
      const record = {
        id: 'old-id',
        legacyNameAliases: [],
        filePath: 'a.md',
        space: 'team',
        createdAt: null,
        materialized: true,
        deletedAt: null,
      }
      await db.identity.claimMany([record])
      await db.favorites.add(fav({ entityId: 'old-id' }))
      await db.identity.settleFileClaim({
        space: 'team',
        filePath: 'a.md',
        current: record,
        observedId: 'new-id',
        at: '2026-06-23T11:00:00.000Z',
      })

      // The settlement moved the reference with the identity …
      expect(await db.favorites.ids('user:al', 'team', 'note')).toEqual(['new-id'])

      // … and the client, holding the pre-settlement id, can still drop it.
      await db.favorites.removeByEntity('user:al', 'team', 'old-id')

      expect(await db.favorites.list('user:al', 'team')).toEqual([])
    })

    it('round-trips note/folder/project rows scoped by owner + space + kind', async () => {
      const db = make()
      await db.favorites.add(fav({ entityId: 'n1', createdAt: '2026-06-23T10:00:00.000Z' }))
      await db.favorites.add(
        fav({ kind: 'folder', entityId: 'f1', createdAt: '2026-06-23T11:00:00.000Z' }),
      )
      await db.favorites.add(
        fav({
          kind: 'project',
          entityId: 'p1',
          owner: 'user:bob',
          createdAt: '2026-06-23T12:00:00.000Z',
        }),
      )
      await db.favorites.add(
        fav({ entityId: 'n2', space: 'ops', createdAt: '2026-06-23T13:00:00.000Z' }),
      )

      expect((await db.favorites.list('user:al', 'team')).map((f) => [f.kind, f.entityId])).toEqual(
        [
          ['folder', 'f1'],
          ['note', 'n1'],
        ],
      )
      expect(await db.favorites.ids('user:al', 'team', 'note')).toEqual(['n1'])
      expect(await db.favorites.ids('user:al', 'team', 'folder')).toEqual(['f1'])
      expect(await db.favorites.has('user:al', 'team', 'folder', 'f1')).toBe(true)
      expect(await db.favorites.has('user:bob', 'team', 'project', 'p1')).toBe(true)
    })

    it('upserts a target, ranks first, replaces a kind flip, removes by entity id', async () => {
      const db = make()
      await db.favorites.add(fav({ entityId: 'n-unranked', createdAt: '2026-06-23T10:00:00.000Z' }))
      await db.favorites.add(
        fav({ entityId: 'n-rank2', createdAt: '2026-06-23T11:00:00.000Z', rank: 2 }),
      )
      await db.favorites.add(
        fav({ entityId: 'n-rank1', createdAt: '2026-06-23T12:00:00.000Z', rank: 1 }),
      )
      await db.favorites.add(
        fav({ entityId: 'n-unranked', createdAt: '2026-06-23T13:00:00.000Z', rank: 0 }),
      )

      expect(await db.favorites.ids('user:al', 'team', 'note')).toEqual([
        'n-unranked',
        'n-rank1',
        'n-rank2',
      ])

      // A favorited folder later surfaced as a project keeps ONE row: `add` clears the
      // entity's other kinds inside the transaction that knows its canonical id (#327).
      await db.favorites.add(fav({ kind: 'folder', entityId: 'shared-id' }))
      await db.favorites.add(fav({ kind: 'project', entityId: 'shared-id' }))
      expect(await db.favorites.has('user:al', 'team', 'folder', 'shared-id')).toBe(false)
      expect(await db.favorites.has('user:al', 'team', 'project', 'shared-id')).toBe(true)

      await db.favorites.removeByEntity('user:al', 'team', 'shared-id')
      expect(await db.favorites.has('user:al', 'team', 'project', 'shared-id')).toBe(false)
    })
  })

  describe('auth facet — personal domain (#21/#13, v7)', () => {
    // Test accounts key by their handle: the id IS the handle.
    const user = (over: Partial<UserRecord> = {}): UserRecord => ({
      id: over.username ?? 'alice',
      username: 'alice',
      email: null,
      displayName: 'Alice',
      passwordHash: null,
      admin: false,
      disabledAt: null,
      createdAt: '2026-06-14T00:00:00Z',
      personalSpace: null,
      ...over,
    })

    it('createFirstUser claims the empty table once: a second call is a no-op (#73 setup TOCTOU)', async () => {
      const db = make()
      // Empty table → the first claim wins.
      expect(await db.auth.createFirstUser(user({ username: 'owner', admin: true }))).toBe(true)
      expect(await db.auth.userCount()).toBe(1)
      // Any later claim (even a different username) loses — the WHERE NOT EXISTS
      // guard sees a non-empty table and inserts nothing.
      expect(await db.auth.createFirstUser(user({ username: 'mallory', admin: true }))).toBe(false)
      expect(await db.auth.userCount()).toBe(1)
      expect(await db.auth.getUser('mallory')).toBeNull()
      expect((await db.auth.getUser('owner'))?.admin).toBe(true)
    })

    it('users round-trip personalSpace; createUser carries it and updateUser sets it', async () => {
      const db = make()
      await db.auth.createUser(user())
      expect((await db.auth.getUser('alice'))?.personalSpace).toBeNull()

      await db.auth.updateUser('alice', { personalSpace: 'alice' })
      expect((await db.auth.getUser('alice'))?.personalSpace).toBe('alice')

      // The pointer can also be written at creation time.
      await db.auth.createUser(user({ username: 'bob', personalSpace: 'bob-space' }))
      expect((await db.auth.getUser('bob'))?.personalSpace).toBe('bob-space')

      // updateUser without the field leaves the pointer untouched.
      await db.auth.updateUser('bob', { displayName: 'Bobby' })
      expect((await db.auth.getUser('bob'))?.personalSpace).toBe('bob-space')
    })
  })

  describe('revision journal facet (#12)', () => {
    it('append assigns monotonically increasing ids and round-trips the revision shape', async () => {
      const db = make()
      const r1 = await db.revisions.append(revInput(), 'body one')
      const r2 = await db.revisions.append(
        revInput({ baseRevisionId: r1.id, contentHash: 'hash-2', tags: [] }),
        'body two',
      )
      expect(Number(r2.id)).toBeGreaterThan(Number(r1.id))
      expect(await db.revisions.get(REV_SPACE, r1.id)).toEqual({
        ...revInput(),
        id: r1.id,
        semanticFingerprint: null,
        restoreSafety: null,
      })
      expect(await db.revisions.get(REV_SPACE, '999999')).toBeNull()
      expect(await db.revisions.get(REV_SPACE, 'not-a-rowid')).toBeNull()
      expect(await db.revisions.latestFor(REV_SPACE, 'note-1')).toEqual(r2)
      expect(await db.revisions.latestFor(REV_SPACE, 'nobody')).toBeNull()
    })

    it('the custom slug column round-trips (#124), null is the default', async () => {
      const db = make()
      const custom = await db.revisions.append(revInput({ noteId: 's1', slug: 'my-custom' }), 'a')
      const plain = await db.revisions.append(revInput({ noteId: 's2', slug: null }), 'b')
      expect((await db.revisions.get(REV_SPACE, custom.id))?.slug).toBe('my-custom')
      expect((await db.revisions.get(REV_SPACE, plain.id))?.slug).toBeNull()
      // latestFor / listByNote serve the same column (one mapper for all reads).
      expect((await db.revisions.latestFor(REV_SPACE, 's1'))?.slug).toBe('my-custom')
    })

    it('blobs are content-addressed: one hash stores once, restore copies are free', async () => {
      const db = make()
      await db.revisions.append(revInput(), 'same body')
      await db.revisions.append(
        revInput({ kind: 'restore', contentHash: 'hash-1', sourceRevisionId: '1' }),
        'same body',
      )
      expect(await db.revisions.content('hash-1')).toBe('same body')
      // A marker revision (external gap) carries no blob.
      await db.revisions.append(revInput({ contentHash: null, kind: 'external' }), null)
      expect(await db.revisions.content('no-such-hash')).toBeNull()
    })

    it('listByNote windows newest-first with an honest total', async () => {
      const db = make()

      for (let i = 1; i <= 5; i++) {
        await db.revisions.append(revInput({ contentHash: `h${i}` }), `body ${i}`)
      }
      await db.revisions.append(revInput({ noteId: 'other' }), 'noise')

      const page = await db.revisions.listByNote(REV_SPACE, 'note-1', { offset: 1, limit: 2 })
      expect(page.total).toBe(5)
      expect(page.items.map((r) => r.contentHash)).toEqual(['h4', 'h3'])
    })

    it('listBySpaceSince collapses to one entry per note, newest-first, after a revision-id cursor (#21)', async () => {
      const db = make()
      // note-1: two revisions; note-2: one; a different space: ignored.
      const a1 = await db.revisions.append(revInput({ noteId: 'note-1', title: 'A1' }), 'a1')
      const b1 = await db.revisions.append(revInput({ noteId: 'note-2', title: 'B1' }), 'b1')
      const a2 = await db.revisions.append(
        revInput({ noteId: 'note-1', title: 'A2', baseRevisionId: a1.id }),
        'a2',
      )
      await db.revisions.append(revInput({ noteId: 'other', space: 'work', title: 'X' }), 'x')

      // From the start: both notes, collapsed to their newest revision, newest-first.
      const all = await db.revisions.listBySpaceSince('main', null, 10)
      expect(all.total).toBe(2)
      expect(all.maxRevId).toBe(a2.id)
      expect(all.items.map((r) => r.noteId)).toEqual(['note-1', 'note-2'])
      expect(all.items[0].title).toBe('A2') // the newest revision of note-1, not A1

      // After b1's cursor: only note-1's later revision (note-2 didn't change since).
      const since = await db.revisions.listBySpaceSince('main', b1.id, 10)
      expect(since.total).toBe(1)
      expect(since.items.map((r) => r.noteId)).toEqual(['note-1'])
      expect(since.maxRevId).toBe(a2.id)

      // After the high-water mark: nothing changed.
      const none = await db.revisions.listBySpaceSince('main', a2.id, 10)
      expect(none).toEqual({ items: [], total: 0, maxRevId: null })
    })

    it('listBySpaceSince honours the limit while reporting the full distinct total', async () => {
      const db = make()

      for (let i = 1; i <= 5; i++) {
        await db.revisions.append(revInput({ noteId: `n${i}`, title: `N${i}` }), `body ${i}`)
      }
      const page = await db.revisions.listBySpaceSince('main', null, 2)
      expect(page.total).toBe(5) // distinct notes changed
      expect(page.items).toHaveLength(2) // budgeted window
      expect(page.items.map((r) => r.noteId)).toEqual(['n5', 'n4']) // newest-first
    })

    it('listBySpaceSince class-scopes IN the query: total, window and maxRevId are all post-filter (#21/#78)', async () => {
      const db = make()
      await db.revisions.append(
        revInput({ noteId: 'doc-1', title: 'Doc', class: 'user-doc' }),
        'd1',
      )
      await db.revisions.append(
        revInput({ noteId: 'mem-1', title: 'Memory', class: 'agent-memory' }),
        'm1',
      )
      const mem2 = await db.revisions.append(
        revInput({ noteId: 'mem-2', title: 'Memory 2', class: 'agent-memory' }),
        'm2',
      )
      const doc2 = await db.revisions.append(
        revInput({ noteId: 'doc-2', title: 'Doc 2', class: 'user-doc' }),
        'd2',
      )

      // Excluding agent-memory: only the two user-docs, distinct total = 2, and the
      // max id is the newest VISIBLE revision (doc-2) — never the hidden mem-2 that
      // sits between them. So the hidden note neither shows nor skews the cursor.
      const scoped = await db.revisions.listBySpaceSince('main', null, 10, ['agent-memory'])
      expect(scoped.items.map((r) => r.noteId)).toEqual(['doc-2', 'doc-1'])
      expect(scoped.total).toBe(2)
      expect(scoped.maxRevId).toBe(doc2.id)
      // A null/unknown class is never excluded (legacy rows stay visible).
      await db.revisions.append(revInput({ noteId: 'legacy', title: 'Legacy', class: null }), 'lg')
      const withLegacy = await db.revisions.listBySpaceSince('main', null, 10, ['agent-memory'])
      expect(withLegacy.items.map((r) => r.noteId)).toContain('legacy')
      // Unfiltered still sees the hidden ones (the exclusion is opt-in).
      const unfiltered = await db.revisions.listBySpaceSince('main', null, 10)
      expect(unfiltered.items.map((r) => r.noteId)).toContain('mem-2')
      expect(Number(unfiltered.maxRevId)).toBeGreaterThanOrEqual(Number(mem2.id))
    })
  })

  describe('activity facet — activityByDay + activityEvents (#33)', () => {
    // Exercises the REAL SQLite aggregation (date() local-day bucketing, the
    // CASE classification, the synthetic-baseline + hidden-class exclusions) —
    // the production path the in-memory twin and the conformance suite mirror.
    const seed = (db: SqliteMetaDb, noteId: string, over: Partial<RevisionInput>) =>
      db.revisions.append(revInput({ noteId, ...over }), null)

    it('buckets by local day, classifies created/edited/deleted, excludes baselines', async () => {
      const db = make()
      await seed(db, 'a', {
        kind: 'write',
        baseRevisionId: null,
        createdAt: '2026-06-10T10:00:00.000Z',
        title: 'A',
      })
      await seed(db, 'a', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '1',
        createdAt: '2026-06-10T11:00:00.000Z',
        title: 'A',
      })
      await seed(db, 'b', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '2',
        createdAt: '2026-06-12T09:00:00.000Z',
        title: 'B',
      })
      await seed(db, 'c', {
        kind: 'delete',
        entryRole: 'change',
        baseRevisionId: '3',
        createdAt: '2026-06-12T12:00:00.000Z',
        title: 'C',
      })
      // A synthetic pre-edit baseline (external/no-parent) — must NOT count.
      await seed(db, 'd', {
        kind: 'external',
        entryRole: 'baseline',
        baseRevisionId: null,
        createdAt: '2026-06-12T08:00:00.000Z',
        title: 'D',
      })
      const days = await db.revisions.activityByDay('main', {
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-20T00:00:00.000Z',
        tzOffsetMinutes: 0,
      })
      const by = Object.fromEntries(days.map((d) => [d.date, d]))
      expect(by['2026-06-10']).toMatchObject({ created: 1, edited: 1, deleted: 0 })
      expect(by['2026-06-12']).toMatchObject({ created: 0, edited: 1, deleted: 1 }) // baseline excluded
    })

    it('tz shifts a late-UTC instant into the next local day', async () => {
      const db = make()
      await seed(db, 'a', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '1',
        createdAt: '2026-06-10T23:30:00.000Z',
      })
      const east = await db.revisions.activityByDay('main', {
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-20T00:00:00.000Z',
        tzOffsetMinutes: 60,
      })
      expect(east.map((d) => d.date)).toEqual(['2026-06-11'])
      const utc = await db.revisions.activityByDay('main', {
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-20T00:00:00.000Z',
        tzOffsetMinutes: 0,
      })
      expect(utc.map((d) => d.date)).toEqual(['2026-06-10'])
    })

    it('excludes a hidden class from the buckets (visibility #78)', async () => {
      const db = make()
      await seed(db, 'mem', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '1',
        class: 'agent-memory',
        createdAt: '2026-06-10T10:00:00.000Z',
      })
      await seed(db, 'doc', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '2',
        class: null,
        createdAt: '2026-06-10T11:00:00.000Z',
      })
      const days = await db.revisions.activityByDay('main', {
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-20T00:00:00.000Z',
        tzOffsetMinutes: 0,
        excludeClasses: ['agent-memory'],
      })
      expect(days).toEqual([
        { date: '2026-06-10', created: 0, edited: 1, deleted: 0, unavailable: 0 },
      ])
    })

    it('activityEvents: newest first, windowable, baseline excluded', async () => {
      const db = make()
      await seed(db, 'a', {
        kind: 'write',
        baseRevisionId: null,
        createdAt: '2026-06-10T10:00:00.000Z',
        title: 'A',
      })
      await seed(db, 'base', {
        kind: 'external',
        entryRole: 'baseline',
        baseRevisionId: null,
        createdAt: '2026-06-11T10:00:00.000Z',
        title: 'Base',
      })
      await seed(db, 'b', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '1',
        createdAt: '2026-06-12T10:00:00.000Z',
        title: 'B',
      })
      const all = await db.revisions.activityEvents('main', { offset: 0, limit: 50 })
      expect(all.total).toBe(2) // the baseline is excluded
      expect(all.items.map((r) => r.title)).toEqual(['B', 'A']) // newest first
      // Day-drill window: only 2026-06-10.
      const drill = await db.revisions.activityEvents('main', {
        from: '2026-06-10T00:00:00.000Z',
        to: '2026-06-11T00:00:00.000Z',
        offset: 0,
        limit: 50,
      })
      expect(drill.items.map((r) => r.title)).toEqual(['A'])
    })

    it('activityByNote: per-note counts + lastAt, baseline excluded', async () => {
      const db = make()
      await seed(db, 'a', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '1',
        createdAt: '2026-06-10T10:00:00.000Z',
      })
      await seed(db, 'a', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '2',
        createdAt: '2026-06-11T10:00:00.000Z',
      })
      await seed(db, 'b', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '1',
        createdAt: '2026-06-10T10:00:00.000Z',
      })
      await seed(db, 'base', {
        kind: 'external',
        entryRole: 'baseline',
        baseRevisionId: null,
        createdAt: '2026-06-10T10:00:00.000Z',
      })
      const rows = await db.revisions.activityByNote('main', {
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-20T00:00:00.000Z',
      })
      const by = Object.fromEntries(rows.map((r) => [r.noteId, r]))
      expect(by.a).toMatchObject({ count: 2, lastAt: '2026-06-11T10:00:00.000Z' })
      expect(by.b.count).toBe(1)
      expect(by.base).toBeUndefined() // synthetic baseline never counts
    })

    it('author filter scopes activityByDay to the viewer: user + any-id pat + ui, others dropped (#218)', async () => {
      const db = make()
      // Alice: a UI session write and an agent (pat) write. Bob: one write. A legacy
      // `ui` row (attributed to whoever looks). An external state (no principal).
      await seed(db, 'a', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '1',
        principal: 'user:alice',
        createdAt: '2026-06-10T10:00:00.000Z',
      })
      await seed(db, 'b', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '2',
        principal: 'pat:alice:KEY-9',
        createdAt: '2026-06-10T11:00:00.000Z',
      })
      await seed(db, 'c', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '3',
        principal: 'user:bob',
        createdAt: '2026-06-10T12:00:00.000Z',
      })
      await seed(db, 'd', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '4',
        principal: 'ui',
        createdAt: '2026-06-10T13:00:00.000Z',
      })
      await seed(db, 'e', {
        kind: 'external',
        entryRole: 'change',
        baseRevisionId: '5',
        principal: null,
        createdAt: '2026-06-10T14:00:00.000Z',
      })
      const window = {
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-20T00:00:00.000Z',
        tzOffsetMinutes: 0,
      }
      // Everyone: all five counted (external kept — it carries a chain parent).
      const all = await db.revisions.activityByDay('main', window)
      expect(all).toEqual([
        { date: '2026-06-10', created: 0, edited: 5, deleted: 0, unavailable: 0 },
      ])
      // Alice's lens: her user session + her pat (any key id) + the legacy `ui` — bob
      // and the authorless external drop.
      const mine = await db.revisions.activityByDay('main', {
        ...window,
        author: { exact: ['ui', 'user:alice'], prefixes: ['pat:alice:', 'oauth:alice:'] },
      })
      expect(mine).toEqual([
        { date: '2026-06-10', created: 0, edited: 3, deleted: 0, unavailable: 0 },
      ])
    })

    it('author filter scopes activityEvents + its total (#218)', async () => {
      const db = make()
      await seed(db, 'a', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '1',
        principal: 'user:alice',
        createdAt: '2026-06-10T10:00:00.000Z',
        title: 'A',
      })
      await seed(db, 'b', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '2',
        principal: 'pat:alice:KEY-9',
        createdAt: '2026-06-11T10:00:00.000Z',
        title: 'B',
      })
      await seed(db, 'c', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '3',
        principal: 'user:bob',
        createdAt: '2026-06-12T10:00:00.000Z',
        title: 'C',
      })
      const mine = await db.revisions.activityEvents('main', {
        offset: 0,
        limit: 50,
        author: { exact: ['ui', 'user:alice'], prefixes: ['pat:alice:', 'oauth:alice:'] },
      })
      expect(mine.total).toBe(2) // total is post-filter, not the space's 3
      expect(mine.items.map((r) => r.title)).toEqual(['B', 'A']) // bob's C excluded, newest first
    })

    it('an empty author filter matches no one (#218)', async () => {
      const db = make()
      await seed(db, 'a', {
        kind: 'write',
        entryRole: 'change',
        baseRevisionId: '1',
        principal: 'user:alice',
        createdAt: '2026-06-10T10:00:00.000Z',
      })
      const none = await db.revisions.activityByDay('main', {
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-20T00:00:00.000Z',
        tzOffsetMinutes: 0,
        author: { exact: [], prefixes: [] },
      })
      expect(none).toEqual([])
    })
  })

  describe('trash facet — listTrashed + purgeNotes (#79)', () => {
    const tomb = (noteId: string, over: Partial<RevisionInput> = {}) =>
      db.revisions.append(revInput({ noteId, kind: 'delete', ...over }), null)
    let db: SqliteMetaDb
    // a fresh db per test (the outer `make` pushes its own cleanup)
    const fresh = () => (db = make())

    it('listTrashed: shows a note whose NEWEST revision is a delete; a later write clears it', async () => {
      fresh()
      // note-a: write then delete → trashed
      await db.revisions.append(
        revInput({ noteId: 'a', title: 'Alpha', contentHash: 'ha' }),
        'a body',
      )
      await tomb('a', { title: 'Alpha', contentHash: 'ha' })
      // note-b: write, delete, write again → NOT trashed (newest is a write)
      await db.revisions.append(revInput({ noteId: 'b', title: 'Beta', contentHash: 'hb' }), 'b1')
      await tomb('b', { title: 'Beta', contentHash: 'hb' })
      await db.revisions.append(revInput({ noteId: 'b', title: 'Beta', contentHash: 'hb2' }), 'b2')

      const { items, total } = await db.revisions.listTrashed('main', { offset: 0, limit: 50 })
      expect(total).toBe(1)
      expect(items.map((r) => r.noteId)).toEqual(['a'])
      expect(items[0].kind).toBe('delete')
      // space-scoped: a delete in another space never shows here.
      await tomb('c', { space: 'work', title: 'Gamma', contentHash: 'hc' })
      expect((await db.revisions.listTrashed('main', { offset: 0, limit: 50 })).total).toBe(1)
      expect((await db.revisions.listTrashed('work', { offset: 0, limit: 50 })).total).toBe(1)
    })

    it('listTrashed: class-scope excludes hidden classes BEFORE the collapse (#78)', async () => {
      fresh()
      await tomb('doc', { class: 'user-doc', contentHash: 'hd' })
      await tomb('mem', { class: 'agent-memory', contentHash: 'hm' })
      const user = await db.revisions.listTrashed('main', { offset: 0, limit: 50 }, [
        'agent-memory',
      ])
      expect(user.total).toBe(1)
      expect(user.items[0].noteId).toBe('doc')
      expect((await db.revisions.listTrashed('main', { offset: 0, limit: 50 })).total).toBe(2) // unfiltered sees both
    })

    it('listTrashed: q searches title case-insensitively incl. CYRILLIC (lower_u), escapes LIKE wildcards', async () => {
      fresh()
      await tomb('ru', { title: 'Важная Заметка', contentHash: 'hr' })
      await tomb('en', { title: 'Carbon Notes', contentHash: 'he' })
      await tomb('pct', { title: '50% off', contentHash: 'hp' })
      // The fix this pins: ASCII LOWER() would miss a lowercase Cyrillic query.
      expect(
        (await db.revisions.listTrashed('main', { offset: 0, limit: 50, q: 'заметка' })).total,
      ).toBe(1)
      expect(
        (await db.revisions.listTrashed('main', { offset: 0, limit: 50, q: 'ЗАМЕТКА' })).items[0]
          .noteId,
      ).toBe('ru')
      expect(
        (await db.revisions.listTrashed('main', { offset: 0, limit: 50, q: 'carbon' })).total,
      ).toBe(1)
      // a literal % matches only the title that has one — not match-all.
      const pct = await db.revisions.listTrashed('main', { offset: 0, limit: 50, q: '%' })
      expect(pct.total).toBe(1)
      expect(pct.items[0].noteId).toBe('pct')
    })

    it('listTrashed: recovery availability filters the whole window and counts partial copies', async () => {
      fresh()
      await tomb('full', {
        title: 'Complete copy',
        contentHash: 'full-hash',
        stateFormat: 'markdown-v2',
        restoreSafety: 'safe',
      })
      await tomb('partial', {
        title: 'Older copy',
        contentHash: 'partial-hash',
        stateFormat: null,
        restoreSafety: null,
      })
      await tomb('blocked', {
        title: 'Protected source',
        contentHash: 'blocked-hash',
        stateFormat: 'markdown-v2',
        restoreSafety: 'blocked',
      })
      await tomb('opaque', {
        title: 'Source only',
        contentHash: 'opaque-hash',
        stateFormat: 'opaque-v1',
        restoreSafety: null,
      })
      await tomb('gap', { title: 'Deletion record', contentHash: null })

      const all = await db.revisions.listTrashed('main', { offset: 0, limit: 50 })
      expect(all).toMatchObject({ total: 5, restorableTotal: 2, partialTotal: 1 })

      const restorable = await db.revisions.listTrashed('main', {
        offset: 0,
        limit: 50,
        availability: 'restorable',
      })
      expect(restorable).toMatchObject({ total: 2, restorableTotal: 2, partialTotal: 1 })
      expect(new Set(restorable.items.map((item) => item.noteId))).toEqual(
        new Set(['full', 'partial']),
      )

      const unavailable = await db.revisions.listTrashed('main', {
        offset: 0,
        limit: 50,
        availability: 'unavailable',
      })
      expect(unavailable).toMatchObject({ total: 3, restorableTotal: 0, partialTotal: 0 })
      expect(new Set(unavailable.items.map((item) => item.noteId))).toEqual(
        new Set(['blocked', 'opaque', 'gap']),
      )
    })

    it('purgeNotes: drops a note’s rows + GCs orphan blobs, but keeps a blob a survivor still references', async () => {
      fresh()
      await db.revisions.append(revInput({ noteId: 'a', contentHash: 'shared' }), 'shared body')
      await db.revisions.append(revInput({ noteId: 'b', contentHash: 'shared' }), 'shared body')
      await db.revisions.append(revInput({ noteId: 'b', contentHash: 'solo' }), 'solo body')

      await db.revisions.purgeNotes(REV_SPACE, ['b'])
      expect(await db.revisions.listByNote(REV_SPACE, 'b', { offset: 0, limit: 10 })).toEqual({
        items: [],
        total: 0,
      })
      expect(await db.revisions.content('solo')).toBeNull() // orphan blob GC'd
      expect(await db.revisions.content('shared')).toBe('shared body') // shared blob kept (note-a refs it)
      expect(await db.revisions.latestFor(REV_SPACE, 'a')).toBeTruthy() // note-a intact
    })
  })

  describe('gateway state facet (#21, v8)', () => {
    it('dedup get/put windows by createdAt and prunes old rows', async () => {
      const db = make()
      const result = { noteId: 'n-1', versionToken: 'v-1' }
      await db.gateway.dedupPut('idem:pat:alice:1:edit_note', 'k1', result, '2026-06-14T12:00:00Z')

      // Inside the window (sinceIso older than the row) → hit.
      expect(
        await db.gateway.dedupGet('idem:pat:alice:1:edit_note', 'k1', '2026-06-14T11:00:00Z'),
      ).toEqual(result)
      // Outside the window (sinceIso newer than the row) → miss (honest re-do).
      expect(
        await db.gateway.dedupGet('idem:pat:alice:1:edit_note', 'k1', '2026-06-14T13:00:00Z'),
      ).toBeNull()
      // A different scope/key never collides.
      expect(
        await db.gateway.dedupGet('idem:pat:bob:1:edit_note', 'k1', '2026-06-14T00:00:00Z'),
      ).toBeNull()

      // Upsert: re-recording the same (scope,key) replaces the outcome + stamp.
      await db.gateway.dedupPut(
        'idem:pat:alice:1:edit_note',
        'k1',
        { noteId: 'n-2', versionToken: 'v-2' },
        '2026-06-14T14:00:00Z',
      )
      expect(
        await db.gateway.dedupGet('idem:pat:alice:1:edit_note', 'k1', '2026-06-14T13:30:00Z'),
      ).toEqual({
        noteId: 'n-2',
        versionToken: 'v-2',
      })

      // Prune drops rows older than the cutoff.
      await db.gateway.dedupPut('hash:pat:alice:1:team', 'old', result, '2026-06-01T00:00:00Z')
      await db.gateway.dedupPrune('2026-06-10T00:00:00Z')
      expect(
        await db.gateway.dedupGet('hash:pat:alice:1:team', 'old', '2026-05-01T00:00:00Z'),
      ).toBeNull()
      // The recent row survives the prune.
      expect(
        await db.gateway.dedupGet('idem:pat:alice:1:edit_note', 'k1', '2026-06-14T13:30:00Z'),
      ).not.toBeNull()
    })
  })

  describe('OAuth client lifecycle', () => {
    const client = (id: string, over: Partial<OAuthClientRecord> = {}): OAuthClientRecord => ({
      clientId: id,
      kind: 'dcr',
      redirectUris: [`https://client.example/${id}`],
      clientName: id,
      createdAt: '2026-07-22T00:00:00.000Z',
      lastSeen: '2026-07-22T00:00:00.000Z',
      activatedAt: null,
      ...over,
    })

    it('applies the pending quota atomically and activation frees capacity', async () => {
      const db = make()
      const cutoff = '2026-07-21T00:00:00.000Z'
      const results = await Promise.all([
        db.oauth.upsertPendingClient(client('one'), 1, cutoff),
        db.oauth.upsertPendingClient(client('two'), 1, cutoff),
      ])
      expect(results.filter(Boolean)).toHaveLength(1)
      const accepted = results[0] ? 'one' : 'two'
      const rejected = accepted === 'one' ? 'two' : 'one'

      expect(
        await db.oauth.activateClient(
          accepted,
          '2026-07-22T00:01:00.000Z',
          '2026-07-21T00:01:00.000Z',
        ),
      ).toBe(true)
      expect(await db.oauth.upsertPendingClient(client(rejected), 1, cutoff)).toBe(true)
      expect((await db.oauth.getClient(accepted))?.activatedAt).toBe('2026-07-22T00:01:00.000Z')
      // Activation must not postpone a CIMD metadata refresh: lastSeen is the
      // cache timestamp, not connection activity.
      expect((await db.oauth.getClient(accepted))?.lastSeen).toBe('2026-07-22T00:00:00.000Z')
    })

    it('garbage-collects stale pending clients but never activated integrations', async () => {
      const db = make()
      const old = '2026-07-20T00:00:00.000Z'
      await db.oauth.upsertPendingClient(
        client('abandoned', { createdAt: old, lastSeen: old }),
        10,
        '2026-07-19T00:00:00.000Z',
      )
      await db.oauth.upsertClient(
        client('connected', { createdAt: old, lastSeen: old, activatedAt: old }),
      )

      expect(
        await db.oauth.activateClient(
          'abandoned',
          '2026-07-22T00:00:00.000Z',
          '2026-07-21T00:00:00.000Z',
        ),
      ).toBe(false)

      expect(
        await db.oauth.upsertPendingClient(client('fresh'), 1, '2026-07-21T00:00:00.000Z'),
      ).toBe(true)
      expect(await db.oauth.getClient('abandoned')).toBeNull()
      expect((await db.oauth.getClient('connected'))?.activatedAt).toBe(old)
    })

    it('cannot demote an activated integration through a later metadata upsert', async () => {
      const db = make()
      const activatedAt = '2026-07-21T12:00:00.000Z'
      await db.oauth.upsertClient(client('stable', { activatedAt }))
      await db.oauth.upsertPendingClient(client('stable', { activatedAt: null }), 1, activatedAt)
      expect((await db.oauth.getClient('stable'))?.activatedAt).toBe(activatedAt)
    })
  })

  // ── durable job facet (#105 [JOBS][A]) ──────────────────────────────────────
  // The correctness-critical SQL of the queue: single-flight claim, the lease guard on
  // heartbeat/succeed/fail/release, cancel, reaper, and the artifact GC/prune ladder.
  describe('jobs facet (#105)', () => {
    const T = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString()
    const enqueue = (
      db: SqliteMetaDb,
      over: Partial<Parameters<SqliteMetaDb['jobs']['enqueue']>[0]> = {},
    ) =>
      db.jobs.enqueue({
        id: 'j1',
        space: 'S',
        kind: 'export',
        principal: 'user:a',
        createdAt: T(0),
        ...over,
      })

    it('enqueue seeds a pending row with the defaults (attempts 0, max 3, runAt=createdAt)', async () => {
      const db = make()
      const job = await enqueue(db, { params: { scope: 'user' }, progressTotal: 7 })
      expect(job.status).toBe('pending')
      expect(job.attempts).toBe(0)
      expect(job.maxAttempts).toBe(3)
      expect(job.runAt).toBe(T(0))
      expect(job.params).toEqual({ scope: 'user' })
      expect(job.progressTotal).toBe(7)
      expect(await db.jobs.get('j1')).toEqual(job)
    })

    it('claimNext is single-flight: one pending row goes to exactly one caller, the next gets null', async () => {
      const db = make()
      await enqueue(db)
      const a = await db.jobs.claimNext('lease-A', ['export'], T(1))
      const b = await db.jobs.claimNext('lease-B', ['export'], T(1))
      expect(a?.id).toBe('j1')
      expect(a?.status).toBe('running')
      expect(a?.lockedBy).toBe('lease-A')
      expect(a?.attempts).toBe(1) // bumped at claim
      expect(b).toBeNull() // already running — not claimable
    })

    it('claimNext skips a future runAt (backoff) and filters by kind', async () => {
      const db = make()
      await enqueue(db, { id: 'future', runAt: T(100) })
      await enqueue(db, { id: 'other', kind: 'import' })
      expect(await db.jobs.claimNext('L', ['export'], T(1))).toBeNull() // future not yet runnable
      expect(await db.jobs.claimNext('L', ['export'], T(1000))).toMatchObject({ id: 'future' })
      // 'future' is now running; only the 'import' row is left pending, and an
      // export-only worker never claims it.
      expect(await db.jobs.claimNext('L', ['export'], T(2000))).toBeNull()
      expect(await db.jobs.claimNext('L', ['import'], T(2000))).toMatchObject({ id: 'other' })
    })

    it('heartbeat is lease-guarded: only the holder keeps the lock alive, a stale token is rejected', async () => {
      const db = make()
      await enqueue(db)
      await db.jobs.claimNext('lease-A', ['export'], T(1))
      expect(await db.jobs.heartbeat('j1', 'lease-B', { done: 1, now: T(2) })).toBe(false)
      expect(
        await db.jobs.heartbeat('j1', 'lease-A', { done: 3, phase: 'archiving', now: T(2) }),
      ).toBe(true)
      const j = await db.jobs.get('j1')
      expect(j?.progressDone).toBe(3)
      expect(j?.phase).toBe('archiving')
      expect(j?.lockedAt).toBe(T(2))
    })

    it('succeed is lease-guarded and does NOT snap progress_done to progress_total', async () => {
      const db = make()
      await enqueue(db, { progressTotal: 1000 }) // whole-space estimate
      await db.jobs.claimNext('lease-A', ['export'], T(1))
      await db.jobs.heartbeat('j1', 'lease-A', { done: 5, now: T(2) }) // a folder export: 5 real files
      // A stale worker cannot record success over the holder.
      expect(await db.jobs.succeed('j1', 'stale', { artifactRef: 'x', now: T(3) })).toBe(false)
      expect(
        await db.jobs.succeed('j1', 'lease-A', {
          result: { count: 5 },
          artifactRef: 'S/j1.zip',
          artifactBytes: 42,
          artifactName: 'S-notes.zip',
          expiresAt: T(9999),
          now: T(4),
        }),
      ).toBe(true)
      const j = await db.jobs.get('j1')
      expect(j?.status).toBe('succeeded')
      expect(j?.progressDone).toBe(5) // real count, not snapped up to 1000
      expect(j?.artifactRef).toBe('S/j1.zip')
      expect(j?.artifactBytes).toBe(42)
      expect(j?.lockedBy).toBeNull()
    })

    it('fail retries with a future runAt, or fails terminally — both lease-guarded', async () => {
      const db = make()
      await enqueue(db)
      await db.jobs.claimNext('lease-A', ['export'], T(1))
      expect(await db.jobs.fail('j1', 'stale', { error: 'boom', now: T(2) })).toBe(false)
      expect(
        await db.jobs.fail('j1', 'lease-A', { error: 'boom', retryAt: T(30), now: T(2) }),
      ).toBe(true)
      let j = await db.jobs.get('j1')
      expect(j?.status).toBe('pending')
      expect(j?.runAt).toBe(T(30)) // backoff
      expect(j?.error).toBe('boom')
      // Re-claim and fail terminally.
      await db.jobs.claimNext('lease-B', ['export'], T(31))
      expect(await db.jobs.fail('j1', 'lease-B', { error: 'dead', now: T(32) })).toBe(true)
      j = await db.jobs.get('j1')
      expect(j?.status).toBe('failed')
      expect(j?.completedAt).toBe(T(32))
    })

    it('a TERMINAL failure may persist a bounded result; a retryable one never does', async () => {
      const db = make()
      await enqueue(db)
      await db.jobs.claimNext('lease-A', ['export'], T(1))
      // A retryable failure is an attempt, not an outcome — nothing to publish.
      await db.jobs.fail('j1', 'lease-A', {
        error: 'transient',
        retryAt: T(30),
        now: T(2),
        result: { imported: 7 },
      })
      expect((await db.jobs.get('j1'))?.result).toBeNull()
      // A terminal one carries what the run finished before it failed.
      await db.jobs.claimNext('lease-B', ['export'], T(31))
      await db.jobs.fail('j1', 'lease-B', {
        error: 'plan conflict',
        now: T(32),
        result: { imported: 7, skipped: 0, failed: 1 },
      })
      const failed = await db.jobs.get('j1')

      expect(failed?.status).toBe('failed')
      expect(failed?.error).toBe('plan conflict')
      expect(failed?.result).toEqual({ imported: 7, skipped: 0, failed: 1 })
    })

    it('release refunds the claim attempt and only the holder can release', async () => {
      const db = make()
      await enqueue(db)
      await db.jobs.claimNext('lease-A', ['export'], T(1)) // attempts → 1
      await db.jobs.release('j1', 'stale', T(2)) // not the holder: no-op
      expect((await db.jobs.get('j1'))?.status).toBe('running')
      await db.jobs.release('j1', 'lease-A', T(2))
      const j = await db.jobs.get('j1')
      expect(j?.status).toBe('pending')
      expect(j?.attempts).toBe(0) // refunded — a clean redeploy didn't burn the budget
      expect(j?.lockedBy).toBeNull()
    })

    it('cancel marks a pending or running job, but not a terminal one', async () => {
      const db = make()
      await enqueue(db, { id: 'p' })
      await enqueue(db, { id: 'r' })
      await db.jobs.claimNext('L', ['export'], T(1)) // claims 'p' (older)
      expect(await db.jobs.cancel('p', T(2))).toBe(true) // running → canceled
      expect(await db.jobs.cancel('r', T(2))).toBe(true) // pending → canceled
      expect(await db.jobs.cancel('p', T(3))).toBe(false) // already terminal
      expect((await db.jobs.get('p'))?.status).toBe('canceled')
    })

    it('reapStale reopens a stalled job with retries left and fails an exhausted one', async () => {
      const db = make()
      await enqueue(db, { id: 'live' })
      await enqueue(db, { id: 'dead', maxAttempts: 1 })
      await db.jobs.claimNext('L1', ['export'], T(1)) // 'dead' (older? both createdAt T0) — claim both
      await db.jobs.claimNext('L2', ['export'], T(1))
      // Both are running with a stale lock at T(1); reap with staleBefore=T(100).
      const reaped = await db.jobs.reapStale(T(100), T(200))
      const byId = Object.fromEntries(reaped.map((j) => [j.id, j.status]))
      // 'live' had attempts 1 < max 3 → reopened; 'dead' had attempts 1 >= max 1 → failed.
      expect(byId).toEqual({ live: 'pending', dead: 'failed' })
      expect((await db.jobs.get('live'))?.lockedBy).toBeNull()
      expect((await db.jobs.get('dead'))?.status).toBe('failed')
    })

    it('artifact GC ladder: findExpired → clearArtifact → prune (prune spares a live-artifact row)', async () => {
      const db = make()
      await enqueue(db)
      await db.jobs.claimNext('L', ['export'], T(1))
      await db.jobs.succeed('j1', 'L', { artifactRef: 'S/j1.zip', expiresAt: T(50), now: T(2) })
      // Not expired yet.
      expect(await db.jobs.findExpired(T(10))).toEqual([])
      const expired = await db.jobs.findExpired(T(100))
      expect(expired.map((j) => j.id)).toEqual(['j1'])
      // prune must NOT delete a terminal row that still carries an artifact ref.
      await db.jobs.prune(T(9999))
      expect(await db.jobs.get('j1')).not.toBeNull()
      // After the file is deleted, clear the pointer, THEN prune reclaims the row.
      await db.jobs.clearArtifact('j1', T(101))
      expect((await db.jobs.get('j1'))?.artifactRef).toBeNull()
      await db.jobs.prune(T(9999))
      expect(await db.jobs.get('j1')).toBeNull()
    })

    it('list filters by principal/kind/status and returns newest-first within a cap', async () => {
      const db = make()
      await enqueue(db, { id: 'a', principal: 'user:a', createdAt: T(1) })
      await enqueue(db, { id: 'b', principal: 'user:b', createdAt: T(2) })
      await enqueue(db, { id: 'c', principal: 'user:a', createdAt: T(3), kind: 'import' })
      const mineExports = await db.jobs.list('S', { principal: 'user:a', kind: 'export' })
      expect(mineExports.map((j) => j.id)).toEqual(['a'])
      const allNewestFirst = await db.jobs.list('S')
      expect(allNewestFirst.map((j) => j.id)).toEqual(['c', 'b', 'a'])
      const capped = await db.jobs.list('S', { limit: 2 })
      expect(capped.map((j) => j.id)).toEqual(['c', 'b'])
      await db.jobs.claimNext('L', ['export'], T(10))
      const running = await db.jobs.list('S', { statuses: ['running'] })
      expect(running.map((j) => j.id)).toEqual(['a']) // 'a' is oldest export → claimed
    })
  })

  // #198: the meta DB self-compacts like the engine index — born auto_vacuum=INCREMENTAL
  // (pragma set before journal_mode / the first table) and drained on the next init when
  // a bulk delete (a space purge, revision-journal churn) left a freelist behind.
  describe('index self-compaction (#198)', () => {
    const fileDb = () => {
      const dir = mkdtempSync(join(tmpdir(), 'notarium-meta-vac-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      return join(dir, 'meta.db')
    }

    it('a fresh meta DB is born auto_vacuum=INCREMENTAL', async () => {
      const path = fileDb()
      const db = make(path)
      await db.identity.init() // drives ensureInit → schema build on the untouched handle
      await db.close()
      const raw = new DatabaseSync(path)
      // 2 === INCREMENTAL; a wrong pragma order (after the first table) would read 0.
      expect((raw.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum).toBe(
        2,
      )
      raw.close()
    })

    it('reclaims a bloated meta freelist on the next init, above the threshold', async () => {
      const path = fileDb()
      const first = make(path)
      await first.identity.init()
      await first.close()

      // Bloat: a throwaway table filled then dropped leaves its pages on the freelist
      // (born INCREMENTAL, so reclaimable) — a stand-in for a large space purge.
      const raw = new DatabaseSync(path)
      raw.exec('CREATE TABLE junk(b TEXT)')
      raw.exec('BEGIN')
      const ins = raw.prepare('INSERT INTO junk(b) VALUES (?)')
      const big = 'x'.repeat(8000)

      for (let i = 0; i < 400; i++) {
        ins.run(big)
      }
      raw.exec('COMMIT')
      raw.exec('DROP TABLE junk')
      raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const freeBefore = (raw.prepare('PRAGMA freelist_count').get() as { freelist_count: number })
        .freelist_count
      raw.close()
      const sizeBefore = statSync(path).size
      expect(freeBefore).toBeGreaterThan(64) // above META_RECLAIM_MIN_FREE_PAGES → the pass runs

      const second = make(path) // reopen → ensureInit runs the gated incremental_vacuum
      await second.identity.init()
      await second.close()

      const raw2 = new DatabaseSync(path)
      const freeAfter = (raw2.prepare('PRAGMA freelist_count').get() as { freelist_count: number })
        .freelist_count
      raw2.close()
      expect(freeAfter).toBeLessThan(64) // freelist drained
      expect(statSync(path).size).toBeLessThan(sizeBefore / 2) // pages left the disk
    })

    it('a below-threshold freelist skips the reclaim pass (no phantom log)', async () => {
      const path = fileDb()
      const first = make(path)
      await first.identity.init() // born INCREMENTAL (auto_vacuum=2)
      await first.close()
      // A SMALL freelist — a handful of pages, below META_RECLAIM_MIN_FREE_PAGES.
      const raw = new DatabaseSync(path)
      raw.exec('CREATE TABLE tiny(b TEXT)')
      raw.exec('BEGIN')
      const ins = raw.prepare('INSERT INTO tiny(b) VALUES (?)')

      for (let i = 0; i < 100; i++) {
        ins.run('x'.repeat(1000))
      }
      raw.exec('COMMIT')
      raw.exec('DROP TABLE tiny')
      raw.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const free = (raw.prepare('PRAGMA freelist_count').get() as { freelist_count: number })
        .freelist_count
      raw.close()
      expect(free).toBeGreaterThan(0)
      expect(free).toBeLessThan(64) // below threshold → the pass must be skipped

      const logs: string[] = []
      const spy = vi
        .spyOn(console, 'log')
        .mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')))
      const second = make(path)
      await second.identity.init()
      await second.close()
      spy.mockRestore()
      expect(logs.some((l) => l.includes('meta index reclaim'))).toBe(false)
    })
  })

  describe('agent retrieval audit facet (#243)', () => {
    const ret = (over: Partial<RetrievalLogInput> = {}): RetrievalLogInput => ({
      owner: 'alice',
      principal: 'pat:alice:cli',
      agent: 'CLI',
      sessionId: null,
      sessionName: null,
      sessionAttach: null,
      tool: 'search',
      query: 'q',
      project: null,
      classFilter: null,
      resultCount: 1,
      topScore: 5,
      hits: [{ noteId: 'n1', title: 'Note 1', score: 5, class: 'agent-memory' }],
      createdAt: '2026-07-01T00:00:00.000Z',
      ...over,
    })

    it('append → history is owner-scoped, newest-first, with total (:memory:)', async () => {
      const db = make()
      await db.retrievalLog.append(ret({ query: 'first', createdAt: '2026-07-01T00:00:00.000Z' }))
      await db.retrievalLog.append(ret({ query: 'second', createdAt: '2026-07-02T00:00:00.000Z' }))
      await db.retrievalLog.append(ret({ owner: 'bob', query: 'other' }))
      const { items, total } = await db.retrievalLog.history({
        owner: 'alice',
        offset: 0,
        limit: 50,
      })
      expect(total).toBe(2) // bob's row is not alice's
      expect(items.map((i) => i.query)).toEqual(['second', 'first']) // newest-first
      expect(items[0].agent).toBe('CLI') // the friendly agent name round-trips
      expect(items[0].hits).toEqual([
        { noteId: 'n1', title: 'Note 1', score: 5, class: 'agent-memory' },
      ])
    })

    it('history filters by tool + missesOnly, and paginates', async () => {
      const db = make()
      await db.retrievalLog.append(ret({ tool: 'search', resultCount: 0, hits: [] })) // a miss
      await db.retrievalLog.append(ret({ tool: 'recall', resultCount: 2, topScore: null }))
      await db.retrievalLog.append(ret({ tool: 'get_note', resultCount: 1 }))
      expect(
        (await db.retrievalLog.history({ owner: 'alice', offset: 0, limit: 50, tool: 'search' }))
          .total,
      ).toBe(1)
      expect(
        (await db.retrievalLog.history({ owner: 'alice', offset: 0, limit: 50, missesOnly: true }))
          .total,
      ).toBe(1)
      const page = await db.retrievalLog.history({ owner: 'alice', offset: 1, limit: 1 })
      expect(page.items).toHaveLength(1)
      expect(page.total).toBe(3)
      expect(page.hasMore).toBe(true)
    })

    it('history supports keyset paging under live appends and same-timestamp ties', async () => {
      const db = make()
      await db.retrievalLog.append(ret({ query: 'oldest', createdAt: '2026-07-01T00:00:00.000Z' }))
      await db.retrievalLog.append(ret({ query: 'newer', createdAt: '2026-07-02T00:00:00.000Z' }))
      const first = await db.retrievalLog.history({ owner: 'alice', offset: 0, limit: 1 })
      expect(first.items.map((i) => i.query)).toEqual(['newer'])
      expect(first.hasMore).toBe(true)

      // A live retrieval lands ABOVE the already-rendered first page; cursor paging must
      // continue below `newer`, not duplicate/skip because an offset shifted.
      await db.retrievalLog.append(
        ret({ query: 'live-new', createdAt: '2026-07-03T00:00:00.000Z' }),
      )
      const second = await db.retrievalLog.history({
        owner: 'alice',
        offset: 0,
        limit: 1,
        before: { at: first.items[0].createdAt, id: first.items[0].id },
      })
      expect(second.total).toBe(3)
      expect(second.items.map((i) => i.query)).toEqual(['oldest'])
      expect(second.hasMore).toBe(false) // total includes live-new above; hasMore is cursor-window truth.

      const exhausted = await db.retrievalLog.history({
        owner: 'alice',
        offset: 0,
        limit: 1,
        before: { at: second.items[0].createdAt, id: second.items[0].id },
      })
      expect(exhausted.items).toEqual([])
      expect(exhausted.total).toBe(3)
      expect(exhausted.hasMore).toBe(false)

      const a = await db.retrievalLog.append(
        ret({ query: 'tie-a', createdAt: '2026-07-04T00:00:00.000Z' }),
      )
      expect(a).not.toBeNull()
      await db.retrievalLog.append(ret({ query: 'tie-b', createdAt: '2026-07-04T00:00:00.000Z' }))
      const tieNext = await db.retrievalLog.history({
        owner: 'alice',
        offset: 0,
        limit: 1,
        before: { at: '2026-07-04T00:00:00.000Z', id: String(Number(a!.id) + 1) },
      })
      expect(tieNext.items.map((i) => i.query)).toEqual(['tie-a'])
    })

    it('aggregates count only search/recall, flag zero-result misses, rank top + blind spots', async () => {
      const db = make()
      // "deploy" searched 3× — 2 empty (a recurring blind spot); "release" 2× — all hit.
      await db.retrievalLog.append(
        ret({ tool: 'search', query: 'deploy', resultCount: 0, hits: [] }),
      )
      await db.retrievalLog.append(
        ret({ tool: 'search', query: 'deploy', resultCount: 0, hits: [] }),
      )
      await db.retrievalLog.append(ret({ tool: 'search', query: 'deploy', resultCount: 3 }))
      await db.retrievalLog.append(ret({ tool: 'search', query: 'release', resultCount: 1 }))
      await db.retrievalLog.append(ret({ tool: 'search', query: 'release', resultCount: 1 }))
      // get_note is a follow-through, NOT a query — excluded from the aggregates.
      await db.retrievalLog.append(ret({ tool: 'get_note', query: 'n1', resultCount: 1 }))
      const agg = await db.retrievalLog.aggregates('alice')
      expect(agg.totalQueries).toBe(5) // 3 deploy + 2 release; get_note excluded
      expect(agg.missCount).toBe(2) // 2 empty deploys
      expect(agg.top[0]).toMatchObject({ query: 'deploy', count: 3, misses: 2 })
      expect(agg.top[1]).toMatchObject({ query: 'release', count: 2, misses: 0 })
      expect(agg.misses).toHaveLength(1) // only queries that ever came back empty
      expect(agg.misses[0]).toMatchObject({ query: 'deploy', misses: 2 })
    })

    it('a fresh owner has an honest empty audit', async () => {
      const db = make()
      const { items, total, hasMore } = await db.retrievalLog.history({
        owner: 'nobody',
        offset: 0,
        limit: 50,
      })
      expect(items).toEqual([])
      expect(total).toBe(0)
      expect(hasMore).toBe(false)
      expect(await db.retrievalLog.aggregates('nobody')).toEqual({
        totalQueries: 0,
        missCount: 0,
        top: [],
        misses: [],
      })
    })
  })

  describe('agent session audit read model (#321)', () => {
    const ret = (
      over: Partial<RetrievalLogInput> & Pick<RetrievalLogInput, 'createdAt'>,
    ): RetrievalLogInput => ({
      owner: 'alice',
      principal: 'pat:alice:cli',
      agent: 'CLI',
      sessionId: null,
      sessionName: null,
      sessionAttach: null,
      tool: 'search',
      query: 'q',
      project: null,
      classFilter: null,
      resultCount: 1,
      topScore: 0.9,
      hits: [],
      ...over,
    })

    it('folds retained + archived episodes and exposes unbound gaps owner-safely', async () => {
      const db = make()
      await db.sessions.insert({
        id: 'ses_live',
        owner: 'alice',
        name: 'Live review',
        named: true,
        parentId: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        lastSeenAt: '2026-07-03T00:00:00.000Z',
        calls: 7,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      })
      await db.retrievalLog.append(
        ret({
          sessionId: 'ses_live',
          sessionName: 'Live review',
          sessionAttach: 'declared',
          createdAt: '2026-07-02T00:00:00.000Z',
        }),
      )
      await db.revisions.append(
        revInput({
          contentHash: 'session-write',
          createdAt: '2026-07-03T00:00:00.000Z',
          agent: {
            owner: 'alice',
            agent: 'CLI',
            session: { id: 'ses_live', name: 'Live review', attach: 'inferred' },
          },
        }),
        'session write',
      )
      // No lifecycle row: this episode survives solely through the capture-time label.
      await db.retrievalLog.append(
        ret({
          sessionId: 'ses_archived',
          sessionName: 'Archived review',
          sessionAttach: 'declared',
          createdAt: '2026-06-01T00:00:00.000Z',
        }),
      )
      await db.retrievalLog.append(ret({ query: 'outside', createdAt: '2026-07-04T00:00:00.000Z' }))
      await db.revisions.append(
        revInput({
          noteId: 'outside-note',
          contentHash: 'outside-write',
          createdAt: '2026-07-04T01:00:00.000Z',
          agent: { owner: 'alice', agent: 'CLI' },
        }),
        'outside write',
      )
      await db.retrievalLog.append(
        ret({ owner: 'bob', query: 'private', createdAt: '2026-07-05T00:00:00.000Z' }),
      )

      const overview = await db.sessionAudit.overview({
        owner: 'alice',
        activeSince: '2026-07-02T12:00:00.000Z',
        limit: 10,
      })
      expect(overview.total).toBe(2)
      expect(overview.active).toBe(1)
      expect(overview.items.map((item) => item.id)).toEqual(['ses_live', 'ses_archived'])
      expect(overview.items[0]).toMatchObject({
        calls: 7,
        reads: 1,
        writes: 1,
        retained: true,
        active: true,
      })
      expect(overview.items[1]).toMatchObject({
        name: 'Archived review',
        calls: null,
        reads: 1,
        writes: 0,
        retained: false,
      })
      expect(overview.outside).toMatchObject({ reads: 1, writes: 1 })
      expect(
        await db.sessionAudit.find('alice', 'ses_archived', '2026-07-02T12:00:00.000Z'),
      ).toMatchObject({ retained: false, name: 'Archived review' })
      expect(await db.sessionAudit.find('bob', 'ses_live', '2026-07-02T12:00:00.000Z')).toBeNull()
    })

    it('merges reads+writes newest-first with stable cross-source cursors and filters', async () => {
      const db = make()
      await db.sessions.insert({
        id: 'ses_timeline',
        owner: 'alice',
        name: 'Timeline',
        named: true,
        parentId: null,
        createdAt: '2026-07-01T00:00:00.000Z',
        lastSeenAt: '2026-07-02T00:00:00.000Z',
        calls: 3,
        role: null,
        roleLocator: null,
        roleContextProjectId: null,
        projectId: null,
      })
      await db.retrievalLog.append(
        ret({
          sessionId: 'ses_timeline',
          sessionName: 'Timeline',
          sessionAttach: 'declared',
          query: 'older read',
          createdAt: '2026-07-01T00:00:00.000Z',
        }),
      )
      await db.revisions.append(
        revInput({
          contentHash: 'newer-write',
          createdAt: '2026-07-02T00:00:00.000Z',
          agent: {
            owner: 'alice',
            agent: 'CLI',
            session: { id: 'ses_timeline', name: 'Timeline', attach: 'inferred' },
          },
        }),
        'newer write',
      )
      const first = await db.sessionAudit.events({
        owner: 'alice',
        scope: { kind: 'session', id: 'ses_timeline' },
        limit: 1,
      })
      expect(first.total).toBe(2)
      expect(first.hasMore).toBe(true)
      expect(first.items[0].type).toBe('write')
      const write = first.items[0]
      expect(write.type).toBe('write')

      if (write.type !== 'write') {
        throw new Error('expected write')
      }
      const second = await db.sessionAudit.events({
        owner: 'alice',
        scope: { kind: 'session', id: 'ses_timeline' },
        limit: 1,
        before: { at: write.at, source: 'write', id: write.id },
      })
      expect(second.items[0].type).toBe('retrieval')
      expect(second.hasMore).toBe(false)
      expect(
        await db.sessionAudit.events({
          owner: 'alice',
          scope: { kind: 'session', id: 'ses_timeline' },
          type: 'write',
          limit: 10,
        }),
      ).toMatchObject({ total: 1, hasMore: false })
    })
  })
})
