// A minimal identity+CAS+class store for the agent-memory ops' unit tests
// (remember_about_user / _project, buildMemoryIndex). Enough list/read/write to
// drive a realistic find-or-create, and — unlike a bare stub — it MODELS the
// directory→filePath mapping the real engine does (mount-relative `directory`
// becomes a folder in filePath), WITHOUT the agent-mount prefix — exactly like the
// e2e fake's InMemoryStore. That lets a test exercise the directory-scoped find
// : a project's memory lands in `<project-id>/<cat>.md`, the user's at the
// root `<cat>.md`. The version token hashes the live body; `writes` records
// what hit write(); `onWrite` injects a transient CAS conflict to test the retry.

import {
  IF_EXISTS,
  type KnowledgeStore,
  type ListOptions,
  NOTE_CLASS,
  noteAlreadyExists,
  type NoteClass,
  type NoteContent,
  type NoteMeta,
  type WriteInput,
  type WriteResult,
} from '../../knowledgeStore'
import { slugify } from '../../libs/slug'
import { computeVersionToken } from '../../libs/versionToken'

export type MemRow = {
  id: string
  title: string
  class: NoteClass
  content: string
  summary?: string
  /** The human-set memory opt-out: served back in frontmatter.muted as the
   *  YAML-true STRING 'true' (mirroring the real engine's non-coercing parser). */
  muted?: boolean
  tags?: string[]
  /** Space-relative path. Defaults to the root `<id>.md`; seed an explicit one
   *  (e.g. `proj-a/general.md` or `.notarium/memory/proj-a/general.md`) to place a
   *  note in a mount subdirectory for the directory-scoped find tests. */
  filePath?: string
}

export type MemStore = KnowledgeStore & {
  rows: MemRow[]
  writes: WriteInput[]
  listCalls: Array<ListOptions | undefined>
  readIds: string[]
}

const norm = (d: string | undefined): string => (!d || d === '/' ? '' : d.replace(/^\/+|\/+$/g, ''))

export const memStore = (
  seed: MemRow[] = [],
  onWrite?: (input: WriteInput, attempt: number) => void,
): MemStore => {
  const rows = seed.map((r) => ({ ...r }))
  const writes: WriteInput[] = []
  const listCalls: Array<ListOptions | undefined> = []
  const readIds: string[] = []
  let writeCount = 0

  const fmOf = (r: MemRow): Record<string, unknown> => {
    const fm: Record<string, unknown> = {}

    if (r.tags?.length) {
      fm.tags = r.tags
    }
    if (r.summary !== undefined) {
      fm.summary = r.summary
    }
    if (r.muted) {
      fm.muted = 'true'
    } // engine-faithful: scalars read back as strings

    return fm
  }
  const pathOf = (r: MemRow): string => r.filePath ?? `${r.id}.md`

  const conflict = (): Error => {
    const e = new Error('conflict') as Error & { isConflict: boolean }
    e.isConflict = true
    return e
  }
  const store = {
    rows,
    writes,
    listCalls,
    readIds,
    capabilities: {
      fts: true,
      vector: false,
      hybrid: false,
      graphExpand: false,
      identity: true,
      cas: true,
      revisions: false,
      trash: false,
      visibility: false,
      watch: false,
    },
    list: async (opts?: ListOptions): Promise<NoteMeta[]> => {
      listCalls.push(opts)
      const classes = opts?.classes == null ? null : new Set(opts.classes)
      return rows
        .filter((r) => classes == null || classes.has(r.class))
        .map((r) => ({
          id: r.id,
          title: r.title,
          class: r.class,
          filePath: pathOf(r),
          modifiedAt: null,
          createdAt: null,
        }))
    },
    read: async (id: string): Promise<NoteContent> => {
      readIds.push(id)
      const r = rows.find((x) => x.id === id)

      if (!r) {
        throw new Error(`no such note: ${id}`)
      }

      return {
        id: r.id,
        title: r.title,
        class: r.class,
        content: r.content,
        frontmatter: fmOf(r),
        versionToken: computeVersionToken(r.content),
      }
    },
    write: async (input: WriteInput): Promise<WriteResult> => {
      onWrite?.(input, writeCount++)
      if (input.originalId) {
        const r = rows.find((x) => x.id === input.originalId)

        if (!r) {
          throw new Error('not found')
        }
        if (input.versionToken !== computeVersionToken(r.content)) {
          throw conflict()
        }
        r.content = input.content ?? ''
        r.title = input.title
        if (input.summary !== undefined) {
          r.summary = input.summary
        }
        if (input.muted !== undefined) {
          r.muted = input.muted || undefined
        }
        if (input.tags !== undefined) {
          r.tags = Array.isArray(input.tags) ? input.tags : [input.tags]
        }
        writes.push(input)
        return { id: r.id, versionToken: computeVersionToken(r.content) }
      }
      const dir = norm(input.directory)
      const filePath = (dir ? `${dir}/` : '') + `${slugify(input.title)}.md`

      // Faithful to the real engines: a create refuses an occupied path unless it
      // explicitly asked to clobber — so the concurrent-first-touch retry path is
      // exercisable. canon: docs/note-model.md#create-collisions
      if (input.ifExists !== IF_EXISTS.overwrite && rows.some((r) => r.filePath === filePath)) {
        throw noteAlreadyExists(input.title)
      }
      // Id stable per (dir, title) — a root and a subdir note of the same title are
      // distinct (mirrors the real engine deriving id from the full path).
      const id = `mem-${slugify([dir, input.title].filter(Boolean).join(' '))}`
      rows.push({
        id,
        title: input.title,
        class: input.targetClass ?? NOTE_CLASS.userDoc,
        content: input.content ?? '',
        summary: input.summary,
        muted: input.muted || undefined,
        tags: Array.isArray(input.tags) ? input.tags : input.tags ? [input.tags] : undefined,
        filePath,
      })
      writes.push(input)
      return { id, versionToken: computeVersionToken(input.content ?? '') }
    },
  }
  return store as unknown as MemStore
}
