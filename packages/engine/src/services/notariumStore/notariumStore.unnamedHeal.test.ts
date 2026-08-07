import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { FileStore } from '../../libs/files'
import { createLocalFsFiles } from '../../libs/files'
import { createNodeSqliteDriver } from '../../libs/sql'
import { createNotariumStore } from './createNotariumStore'
import { NotariumStore } from './notariumStore'

// Boot heal for the notes #296 lost. Before the name formula had an id rung, a title
// in a script we could not romanise slugged to '' and the note was written to
// `<dir>/.md` — a dot-file the scan hid, so the next boot found no file for it, the
// reconcile called that an external delete, and the note became a tombstone standing
// over its own live bytes. These files exist on real installs; the heal renames them
// onto the current formula before the same pass reconciles, so the tombstone never
// happens and the note keeps its identity (P7 — id lives in the frontmatter).

const roots: string[] = []

const mkroot = async (): Promise<string> => {
  const root = await fs.mkdtemp(join(tmpdir(), 'notarium-unnamed-heal-'))
  roots.push(root)
  return root
}

/** A note file exactly as the old formula wrote it: `<dir>/.md`, id in frontmatter. */
const writeUnnamed = async (root: string, dir: string, id: string, title: string, body: string) => {
  await fs.mkdir(join(root, dir), { recursive: true })
  await fs.writeFile(
    join(root, dir, '.md'),
    `---\nnotarium-id: ${id}\ntitle: ${title}\n---\n\n# ${title}\n\n${body}`,
  )
}

const namesIn = async (root: string, dir: string): Promise<string[]> =>
  (await fs.readdir(join(root, dir))).sort()

/** The `notarium-id` the file still carries — identity is the frontmatter claim (P7),
 *  and a bare engine addresses by path, so this is where "the note survived" is read. */
const idClaimOf = async (root: string, path: string): Promise<string | undefined> =>
  /notarium-id:\s*(\S+)/.exec(await fs.readFile(join(root, path), 'utf8'))?.[1]

const createHealingTestStore = (root: string): NotariumStore =>
  createNotariumStore({ notesDir: root, integritySweepBatchSize: 0 })

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true })))
})

describe('boot heal for unnamed note files (#296)', () => {
  it('heals the legacy file through LocalFS without losing its identity or body', async () => {
    const root = await mkroot()
    await writeUnnamed(root, 'journal', 'LOCALSAFE001', '第三季度规划', 'Still live.')
    const store = createNotariumStore({ notesDir: root, integritySweepBatchSize: 0 })

    try {
      const [note] = await store.list()
      expect(note.filePath).toBe('journal/第三季度规划.md')
      expect((await store.read('journal/第三季度规划.md')).content).toBe('Still live.')
      expect(await namesIn(root, 'journal')).toEqual(['第三季度规划.md'])

      // A content save has no move intent and remains on the healed basename.
      await store.write({
        originalId: 'LOCALSAFE001',
        title: '第三季度规划',
        directory: 'journal',
        content: 'Saved safely.',
      })
      expect((await store.read('journal/第三季度规划.md')).content).toBe('Saved safely.')
      expect(await namesIn(root, 'journal')).toEqual(['第三季度规划.md'])
    } finally {
      await store.stop()
    }
  })

  it('completes an interrupted same-inode heal publication without suffixing a duplicate', async () => {
    const root = await mkroot()
    await writeUnnamed(root, 'journal', 'CRASHHEAL001', '第三季度规划', 'One identity.')
    // renameIfAbsent publishes a hardlink before detaching the old pathname. A
    // process stop in that window leaves this exact recoverable pair.
    await fs.link(join(root, 'journal', '.md'), join(root, 'journal', '第三季度规划.md'))
    const store = createHealingTestStore(root)

    try {
      const notes = await store.list()

      expect(notes).toHaveLength(1)
      expect(notes[0].filePath).toBe('journal/第三季度规划.md')
      expect(await namesIn(root, 'journal')).toEqual(['第三季度规划.md'])
      expect((await store.read('journal/第三季度规划.md')).content).toBe('One identity.')
    } finally {
      await store.stop()
    }
  })

  it('renames a legacy `.md` onto the title it can now slug, keeping the note whole', async () => {
    const root = await mkroot()
    await writeUnnamed(root, 'journal', 'T5YQakUx0Z-7', '第三季度规划', 'Q3 roadmap body.')
    const store = createHealingTestStore(root)

    try {
      const listed = await store.list()
      const note = listed.find((n) => n.title === '第三季度规划')

      // The note is LIVE, not a tombstone — and its file is a real, visible name.
      expect(note).toBeTruthy()
      expect(note!.filePath).toBe('journal/第三季度规划.md')
      expect((await store.read('journal/第三季度规划.md')).content).toBe('Q3 roadmap body.')
      // The heal is a RENAME: the body and the id claim ride along untouched (P7), so
      // the read-model above re-binds the note to its old id rather than minting one.
      expect(await idClaimOf(root, 'journal/第三季度规划.md')).toBe('T5YQakUx0Z-7')
      expect(await namesIn(root, 'journal')).toEqual(['第三季度规划.md'])
    } finally {
      await store.stop()
    }
  })

  it('names a legacy `.md` after the note when the title has no letters at all', async () => {
    const root = await mkroot()
    await writeUnnamed(root, 'journal', 'V3Y6suj3bsgi', '🎉🎉', 'Party body.')
    const store = createHealingTestStore(root)

    try {
      const note = (await store.list()).find((n) => n.title === '🎉🎉')
      expect(note!.filePath).toBe('journal/v3y6suj3bsgi.md')
      expect((await store.read('journal/v3y6suj3bsgi.md')).content).toBe('Party body.')
      expect(await idClaimOf(root, 'journal/v3y6suj3bsgi.md')).toBe('V3Y6suj3bsgi')
    } finally {
      await store.stop()
    }
  })

  it('does not clobber a note already sitting on the healed name — it suffixes', async () => {
    const root = await mkroot()
    await fs.mkdir(join(root, 'journal'), { recursive: true })
    await fs.writeFile(
      join(root, 'journal', '第三季度规划.md'),
      '---\nnotarium-id: AAAAAAAAAAAA\ntitle: 第三季度规划\n---\n\n# 第三季度规划\n\nThe occupant.',
    )
    await writeUnnamed(root, 'journal', 'BBBBBBBBBBBB', '第三季度规划', 'The healed one.')
    const store = createHealingTestStore(root)

    try {
      // Both notes live, neither body lost — the heal must never be a silent
      // overwrite (P3), so the newcomer takes the next free name. `list()` first:
      // the heal runs on the store's first scan, so reading the directory before
      // touching the store would look at a vault nothing has opened yet.
      expect((await store.list()).map((n) => n.title)).toEqual(['第三季度规划', '第三季度规划'])
      expect(await namesIn(root, 'journal')).toEqual(['第三季度规划-2.md', '第三季度规划.md'])
      expect((await store.read('journal/第三季度规划.md')).content).toBe('The occupant.')
      expect((await store.read('journal/第三季度规划-2.md')).content).toBe('The healed one.')
      expect(await idClaimOf(root, 'journal/第三季度规划.md')).toBe('AAAAAAAAAAAA')
      expect(await idClaimOf(root, 'journal/第三季度规划-2.md')).toBe('BBBBBBBBBBBB')

      // A normal content edit has no rename intent. The recovered collision member
      // remains writable instead of trying to move onto the occupant's first name.
      await expect(
        store.write({
          originalId: 'BBBBBBBBBBBB',
          title: '第三季度规划',
          content: 'Edited healed body.',
          // UI-shaped save: the editor always echoes the current directory.
          directory: 'journal',
        }),
      ).resolves.toBeTruthy()
      expect((await store.read('journal/第三季度规划-2.md')).content).toBe('Edited healed body.')
      expect(await namesIn(root, 'journal')).toEqual(['第三季度规划-2.md', '第三季度规划.md'])
    } finally {
      await store.stop()
    }
  })

  it('leaves an idless `.md` hidden and untouched — it is not proven ours', async () => {
    // `parseNoteFile` falls back to the FILE NAME for a note with neither `title:` nor
    // an `# H1` — and this file's name is empty, so that fallback hands back the path
    // itself. Naming the healed file after it would stamp `journal-md.md` on a note
    // whose "title" is not a title at all.
    const root = await mkroot()
    await fs.mkdir(join(root, 'journal'), { recursive: true })
    await fs.writeFile(join(root, 'journal', '.md'), 'plain body, no title at all')
    await fs.writeFile(join(root, '.md'), 'root body, no title either')
    const store = createHealingTestStore(root)

    try {
      expect(await store.list()).toHaveLength(0)
      expect(await namesIn(root, 'journal')).toEqual(['.md'])
      expect(await namesIn(root, '')).toContain('.md')
      expect(await fs.readFile(join(root, 'journal', '.md'), 'utf8')).toContain('plain body')
    } finally {
      await store.stop()
    }
  })

  it('leaves every other dot-file hidden — the heal is exactly `.md`, not `.anything.md`', async () => {
    const root = await mkroot()
    await fs.mkdir(join(root, '.obsidian'), { recursive: true })
    await fs.writeFile(join(root, '.obsidian', 'workspace.md'), '# editor state\n')
    await fs.writeFile(join(root, '.a1b2c3.tmp'), 'half a write')
    await fs.writeFile(join(root, '.draft.md'), '# a dot-named note of somebody else\n')
    const store = createNotariumStore({ notesDir: root, integritySweepBatchSize: 0 })

    try {
      expect(await store.list()).toHaveLength(0)
      // Untouched on disk: the heal renames nothing it was not written to fix.
      expect(await fs.readFile(join(root, '.draft.md'), 'utf8')).toContain('somebody else')
      expect(await fs.readFile(join(root, '.a1b2c3.tmp'), 'utf8')).toBe('half a write')
    } finally {
      await store.stop()
    }
  })

  it('never clobbers a destination that appeared on disk after the scan', async () => {
    const root = await mkroot()
    await writeUnnamed(root, 'journal', 'DDDDDDDDDDDD', '第三季度规划', 'The healed one.')
    // Land the destination BETWEEN the scan and the rename — the window an external
    // writer (an Obsidian save, a sync client) really has, and the only one the
    // `taken` set built from that scan cannot know about. `fs.rename` would overwrite
    // it without a word, so disk truth has to be re-checked (P3).
    const base = createLocalFsFiles(root)
    const files: FileStore = {
      ...base,
      scan: async () => {
        const entries = await base.scan()
        await fs.writeFile(
          join(root, 'journal', '第三季度规划.md'),
          '---\nnotarium-id: EEEEEEEEEEEE\ntitle: 第三季度规划\n---\n\n# 第三季度规划\n\nSomebody else bytes.',
        )
        return entries
      },
    }
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc' as const, prefix: '', files }],
      sql: createNodeSqliteDriver(':memory:'),
      integritySweepBatchSize: 0,
    })

    try {
      await store.list()
      // Nobody's bytes are gone: the interloper is intact and the atomic collision
      // makes the heal continue immediately onto the next free candidate.
      expect(await fs.readFile(join(root, 'journal', '第三季度规划.md'), 'utf8')).toContain(
        'Somebody else bytes',
      )
      expect(await namesIn(root, 'journal')).toEqual(['第三季度规划-2.md', '第三季度规划.md'])
      expect(await fs.readFile(join(root, 'journal', '第三季度规划-2.md'), 'utf8')).toContain(
        'The healed one',
      )
    } finally {
      await store.stop()
    }
  })

  it('reconciles the new path in the same pass when post-move stat is transiently null', async () => {
    const root = await mkroot()
    await writeUnnamed(root, 'journal', 'FFFFFFFFFFFF', '第三季度规划', 'Healed now.')
    const base = createLocalFsFiles(root)
    let missed = false
    const files: FileStore = {
      ...base,
      stat: async (path) => {
        if (!missed && path === 'journal/第三季度规划.md') {
          missed = true

          return null
        }

        return base.stat(path)
      },
    }
    const store = new NotariumStore({
      mounts: [{ class: 'user-doc' as const, prefix: '', files }],
      sql: createNodeSqliteDriver(':memory:'),
      integritySweepBatchSize: 0,
    })

    try {
      const listed = await store.list()
      expect(missed).toBe(true)
      expect(listed.map((note) => note.filePath)).toContain('journal/第三季度规划.md')
      expect((await store.read('journal/第三季度规划.md')).content).toBe('Healed now.')
    } finally {
      await store.stop()
    }
  })

  it('keeps a healed collision editable when the canonical name is a directory entry', async () => {
    const root = await mkroot()
    await writeUnnamed(root, 'journal', 'DIRBLOCK00001', 'blocked', 'Healed body.')
    await fs.mkdir(join(root, 'journal', 'blocked.md'))
    const store = createHealingTestStore(root)

    try {
      const [note] = await store.list()
      expect(note.filePath).toBe('journal/blocked-2.md')
      await store.write({
        originalId: 'DIRBLOCK00001',
        title: 'blocked',
        directory: 'journal',
        content: 'Edited in place.',
      })
      expect((await store.read('journal/blocked-2.md')).content).toBe('Edited in place.')
      expect((await fs.stat(join(root, 'journal', 'blocked.md'))).isDirectory()).toBe(true)
    } finally {
      await store.stop()
    }
  })

  it('heals a root-level `.md` too, not only one inside a folder', async () => {
    const root = await mkroot()
    await fs.writeFile(
      join(root, '.md'),
      '---\nnotarium-id: CCCCCCCCCCCC\ntitle: תוכניות לרבעון\n---\n\n# תוכניות לרבעון\n\nHebrew body.',
    )
    const store = createHealingTestStore(root)

    try {
      const note = (await store.list()).find((n) => n.title === 'תוכניות לרבעון')
      expect(note!.filePath).toBe('תוכניות-לרבעון.md')
      expect((await store.read('תוכניות-לרבעון.md')).content).toBe('Hebrew body.')
      expect(await idClaimOf(root, 'תוכניות-לרבעון.md')).toBe('CCCCCCCCCCCC')
    } finally {
      await store.stop()
    }
  })
})
