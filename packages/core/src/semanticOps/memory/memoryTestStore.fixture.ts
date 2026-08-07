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
import { shortHash } from '../../libs/hash'
import { directoryOf, noteFilePath } from '../../libs/path'
import { asciiSlug, slugify } from '../../libs/slug'
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

  /** What both engines throw when a rename would land on an occupied path — a tool
   *  error with no `reason`, NOT `note_already_exists`. The distinction matters: the
   *  memory op retries a create on `note_already_exists`, so borrowing that reason here
   *  would make the fixture drive a retry production never triggers. */
  const moveFailed = (): Error => {
    const e = new Error('# Move Failed: a note already lives at the destination') as Error & {
      isToolError: boolean
    }
    e.isToolError = true
    return e
  }

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
        // Both real engines RE-DERIVE the basename on an edit, so a write that stops
        // pinning a name moves the file. Modelling the path as create-time-permanent
        // is what let a pin that lasted exactly one write look correct here.
        const moved = noteFilePath(input.title, directoryOf(r.filePath ?? ''), input.fileName, r.id)

        // A rename onto an OCCUPIED path is refused, exactly as both engines refuse it
        // — and refused BEFORE anything is written, because they refuse before touching
        // the file too. Committing the body first would model a half-applied write no
        // engine can produce, which is the same class of lie the re-derivation removes.
        if (moved !== r.filePath && rows.some((x) => x.id !== r.id && pathOf(x) === moved)) {
          throw moveFailed()
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
        r.filePath = moved
        writes.push(input)
        return { id: r.id, versionToken: computeVersionToken(r.content) }
      }
      const dir = norm(input.directory)
      // Id stable per (dir, title). ASCII like a real `notarium-id` — the id rung of the
      // name formula runs it through `idToSlug`, which strips non-ASCII, so a raw key
      // here would collapse two letterless categories back onto one file. When the
      // ASCII form loses information, a short hash restores distinctness; a name that
      // romanises fully keeps exactly the id it always had.
      const idBase = [dir, input.title].filter(Boolean).join(' ')
      const idAscii = asciiSlug(idBase)
      // "Lossless" needs the ASCII form to be non-empty AND equal: when BOTH forms are
      // empty they are trivially equal, and taking that branch is what collapsed two
      // letterless categories onto one id again.
      const idLossless = Boolean(idAscii) && idAscii === slugify(idBase)
      const id = `mem-${idLossless ? idAscii : `${idAscii ? `${idAscii}-` : ''}${shortHash(idBase)}`}`
      // The shared name formula, not a copy of it (#296): a category in a script we
      // cannot romanise must land on its own file here too, and one with no letters at
      // all takes the formula's id rung — exactly as the real engines do, or this
      // fixture would accept a collision they refuse.
      const filePath = noteFilePath(input.title, dir, input.fileName, id)

      // Faithful to the real engines: a create refuses an occupied path unless it
      // explicitly asked to clobber — so the concurrent-first-touch retry path is
      // exercisable. canon: docs/note-model.md#create-collisions
      if (input.ifExists !== IF_EXISTS.overwrite && rows.some((r) => r.filePath === filePath)) {
        throw noteAlreadyExists(input.title)
      }
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
