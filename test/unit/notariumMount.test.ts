// NotariumStore mount routing & class integrity (#78) — engine-specific, beyond
// the shared port contract (the in-memory engine has no physical mounts). Pins:
// class is materialized from the mount; a write whose directory escapes into
// another mount's namespace is rejected (the engine's own belt against
// agent-memory poisoning, even if the host boundary were bypassed); legitimate
// agent/user writes land in the right class.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNotariumStore } from '@notarium/engine'

import type { NotariumStore } from '../../packages/engine/src/services/notariumStore/notariumStore'
import { defaultMounts } from '../../packages/server/src/apps/server/server'

let dir: string
let store: NotariumStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nt-mount-'))
  store = createNotariumStore({
    mounts: [
      { class: 'user-doc', dir, prefix: '' },
      { class: 'agent-memory', dir: join(dir, '.notarium/memory'), prefix: '.notarium/memory' },
      { class: 'profile', dir: join(dir, '.notarium/profile'), prefix: '.notarium/profile' },
    ],
  })
})
afterEach(async () => {
  await store.stop()
  rmSync(dir, { recursive: true, force: true })
})

const classOf = async (filePath: string) =>
  (await store.list()).find((n) => n.filePath === filePath)?.class

describe('NotariumStore mounts & class (#78)', () => {
  it('requires at least one physical mount', () => {
    expect(() => createNotariumStore({})).toThrow(/requires `mounts` or `notesDir`/)
  })

  it('materializes class from the target mount and places files on disk', async () => {
    const u = await store.write({ title: 'Doc', content: 'x', directory: 'notes' })
    const m = await store.write({ title: 'Pref', content: 'y', targetClass: 'agent-memory' })
    expect(u.filePath).toBe('notes/doc.md')
    expect(m.filePath).toBe('.notarium/memory/pref.md')
    expect(await classOf('notes/doc.md')).toBe('user-doc')
    expect(await classOf('.notarium/memory/pref.md')).toBe('agent-memory')
    // Physically disjoint; the notes-mount scan never double-indexes the memory.
    expect(existsSync(join(dir, '.notarium/memory/pref.md'))).toBe(true)
    expect((await store.list()).length).toBe(2)
  })

  it('rejects a user write whose directory escapes into the agent-mount namespace', async () => {
    await expect(
      store.write({ title: 'Injected', content: 'planted', directory: '.notarium/memory' }),
    ).rejects.toMatchObject({ isToolError: true })
    // Nothing was created.
    expect((await store.list()).length).toBe(0)
  })

  it('an edit with no directory keeps a prefixed-mount note in place — no double-prefix (#78 restore)', async () => {
    // The restore path edits with NO directory; the engine must keep the note in
    // its current folder, NOT move it to the mount root and NOT re-prepend the
    // mount prefix (else .notarium/memory/.notarium/memory/... — file corruption).
    const m = await store.write({ title: 'Pref', content: 'v1', targetClass: 'agent-memory' })
    expect(m.filePath).toBe('.notarium/memory/pref.md')
    const r = await store.write({ title: 'Pref', content: 'v2', originalId: m.filePath })
    expect(r.filePath).toBe('.notarium/memory/pref.md') // unchanged, not doubled
    expect((await store.list()).length).toBe(1)
    expect(await classOf('.notarium/memory/pref.md')).toBe('agent-memory')
    expect((await store.read('.notarium/memory/pref.md')).content).toContain('v2')
  })

  it('fail-closed: a targetClass with no mount throws, never falls back to user-doc', async () => {
    const single = createNotariumStore({ mounts: [{ class: 'user-doc', dir, prefix: '' }] })

    try {
      await expect(
        single.write({ title: 'Mem', content: 'x', targetClass: 'agent-memory' }),
      ).rejects.toMatchObject({ isToolError: true })
    } finally {
      await single.stop()
    }
  })

  it('rejects a non-dot sub-mount prefix at construction (double-index guard)', () => {
    expect(() =>
      createNotariumStore({
        mounts: [
          { class: 'user-doc', dir, prefix: '' },
          { class: 'agent-memory', dir: join(dir, 'memory'), prefix: 'memory' },
        ],
      }),
    ).toThrow(/dot-namespace/)
  })

  it('routes the profile class into its hidden mount; an edit keeps it there (#159)', async () => {
    // The reserved profile note (#159) lands in .notarium/profile, stamped
    // `profile` from the mount (the read-model then hides it from discovery). The
    // real engine is the ONLY place this routing is exercised — the in-memory fake
    // stamps class from targetClass without a mount.
    const p = await store.write({ title: 'Profile', content: 'about me', targetClass: 'profile' })
    expect(p.filePath).toBe('.notarium/profile/profile.md')
    expect(p.class).toBe('profile')
    expect(await classOf('.notarium/profile/profile.md')).toBe('profile')
    expect(existsSync(join(dir, '.notarium/profile/profile.md'))).toBe(true)
    // A re-save (edit, no directory/targetClass) must stay in the profile mount —
    // not duplicate, not fall back to the root user-doc mount.
    const r = await store.write({
      title: 'Profile',
      content: 'about me v2',
      originalId: p.filePath,
    })
    expect(r.filePath).toBe('.notarium/profile/profile.md')
    expect(await classOf('.notarium/profile/profile.md')).toBe('profile')
    expect((await store.list()).filter((n) => n.class === 'profile').length).toBe(1)
    expect((await store.read('.notarium/profile/profile.md')).content).toContain('v2')
  })

  it('defaultMounts wires the profile mount end-to-end (#159 — guards the server config)', async () => {
    // The fake-server suite uses InMemoryStore (no mounts), so dropping the profile
    // line from defaultMounts would leave it green while every real PUT /api/me/
    // profile throws (mountForClass is fail-closed). This pins the actual config.
    const d2 = mkdtempSync(join(tmpdir(), 'nt-defmounts-'))
    const s2 = createNotariumStore({ mounts: defaultMounts(d2) })

    try {
      const p = await s2.write({ title: 'Profile', content: 'x', targetClass: 'profile' })
      expect(p.filePath).toBe('.notarium/profile/profile.md')
      expect(p.class).toBe('profile')
    } finally {
      await s2.stop()
      rmSync(d2, { recursive: true, force: true })
    }
  })

  it('exports every skill resource as preserved bytes only in the all-files scope', async () => {
    const skillDir = join(dir, '.roles-library')
    const resource = Buffer.from([0, 255, 1])
    mkdirSync(join(skillDir, 'research', 'assets'), { recursive: true })
    writeFileSync(join(skillDir, 'research', 'SKILL.md'), '# Research')
    writeFileSync(join(skillDir, 'research', 'assets', 'model.bin'), resource)
    const exporting = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir, prefix: '' },
        { class: 'skill', dir: skillDir, prefix: '.roles-library' },
      ],
    })

    try {
      const userEntries = []

      for await (const entry of exporting.exportNotes!()) {
        userEntries.push(entry)
      }
      expect(userEntries).toEqual([])

      const allEntries = []

      for await (const entry of exporting.exportNotes!({ scope: 'all' })) {
        allEntries.push(entry)
      }
      expect(allEntries).toHaveLength(2)
      expect(allEntries).toEqual(
        expect.arrayContaining([
          {
            path: '.roles-library/research/SKILL.md',
            content: Buffer.from('# Research'),
            preserveBytes: true,
          },
          {
            path: '.roles-library/research/assets/model.bin',
            content: resource,
            preserveBytes: true,
          },
        ]),
      )
    } finally {
      await exporting.stop()
    }
  })

  it('an edit keeps the note in its own mount/class (no cross-mount drift)', async () => {
    const m = await store.write({ title: 'Pref', content: 'y', targetClass: 'agent-memory' })
    // Edit (bare engine: no CAS token needed). A contradictory targetClass hint
    // must NOT move it — an edit stays in the note's existing mount.
    await store.write({
      title: 'Pref',
      content: 'y2',
      originalId: m.filePath,
      targetClass: 'user-doc',
    })
    expect(await classOf('.notarium/memory/pref.md')).toBe('agent-memory')
    expect((await store.list()).length).toBe(1)
  })
})
