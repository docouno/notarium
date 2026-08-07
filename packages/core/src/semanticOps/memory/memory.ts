// Agent-memory writes: remember_about_user / remember_about_project.
// canon: docs/note-model.md#agent-memory

import type { KnowledgeStore, NoteMeta, WriteResult } from '../../knowledgeStore'
import { NOTE_CLASS, READ_SCOPE, STORE_ERROR_REASON, versionConflict } from '../../knowledgeStore'
import { pathHash, sha256Hex } from '../../libs/hash'
import { estimateTokens } from '../../libs/markdown'
import { CLIPPED_NAME_TAG_BYTES, clipToBytes, NOTE_BASENAME_MAX_BYTES } from '../../libs/path'
import { nameKey, slugify } from '../../libs/slug'
import { normTags } from '../../libs/tags'
import { makeSnippet } from '../../snippet'
import { applyEdit, EDIT_OPERATION } from '../editNote'
import { AGENT_MEMORY_MOUNT } from './consts'
import type {
  MemoryIndexEntry,
  RememberAboutProjectInput,
  RememberAboutUserInput,
  RememberInput,
  RememberResult,
} from './types'

/** The mount-relative dir of a memory note ('' = about-user root, '<id>' = about-project).
 *  Strips the mount prefix, which the real engine prepends but the fake omits. */
export const memoryDirOf = (filePath: string, mountPrefix: string = AGENT_MEMORY_MOUNT): string => {
  let rel = filePath

  if (mountPrefix && (rel === mountPrefix || rel.startsWith(`${mountPrefix}/`))) {
    rel = rel.slice(mountPrefix.length).replace(/^\/+/, '')
  }
  const slash = rel.lastIndexOf('/')
  return slash >= 0 ? rel.slice(0, slash) : ''
}

const withEcho = async (
  r: WriteResult,
  body: string,
  outcome: 'created' | 'appended',
  summaryUpdated: boolean,
): Promise<RememberResult> => ({
  ...r,
  outcome,
  summaryUpdated,
  bodyBytes: Buffer.byteLength(body, 'utf8'),
  bodyHash: await sha256Hex(body),
})

/** YAML scalars read back as strings on the real engine (`muted: true` → 'true'),
 *  as booleans on the fake — treat both truthy forms as muted. */
export const isMutedFlag = (v: unknown): boolean => v === true || v === 'true'

/** The file a memory CATEGORY lives in — deterministic per category, because the
 *  find-or-append convergence needs two racing writers to aim at ONE path. The
 *  category's own slug where it has one (so every existing memory file keeps its
 *  name); a hash of its name key where it has none, since the name formula's id rung
 *  would otherwise hand each racer a file of its own (#296). */
const memoryFileName = (category: string): string => {
  const categoryKey = nameKey(category)
  const named = slugify(category) || `category-${pathHash(categoryKey)}`

  // The formula never byte-clips an explicit fileName — that length is the caller's to
  // own, and this is the caller. Owning it means clipping HERE: a long category in a
  // script the name axis now keeps is 3 bytes per letter, and an unclipped pin turns a
  // previously-writable category into a hard ENAMETOOLONG with no memory recorded at
  // all. The tag keeps two categories that share a clipped prefix apart, exactly as
  // the title rung does.
  const clipped = clipToBytes(named, NOTE_BASENAME_MAX_BYTES - CLIPPED_NAME_TAG_BYTES)
  return clipped === named ? named : `${clipped}-${pathHash(categoryKey)}`
}

/** Find the category note, scoped by class AND mount-dir so sibling projects'
 *  same-category notes never collide. A bare engine ignores `scope`, so these
 *  filters — not the list scope — are the real guard. */
const findMemoryNote = async (
  store: KnowledgeStore,
  category: string,
  subdir: string,
  mountPrefix: string,
): Promise<NoteMeta | undefined> => {
  // `nameKey`, the total name key (#296): a category is matched against a note TITLE,
  // and on the bare slug two categories with no sluggable characters shared the empty
  // key — the second one's observations were appended into the first one's note.
  const want = nameKey(category)
  const metas = await store.list({
    scope: READ_SCOPE.agentRecall,
    classes: [NOTE_CLASS.agentMemory],
  })
  return metas.find(
    (m) =>
      m.class === NOTE_CLASS.agentMemory &&
      m.id != null &&
      nameKey(m.title) === want &&
      memoryDirOf(m.filePath, mountPrefix) === subdir,
  )
}

/** Find-or-create the category note in `subdir`, then append (CAS, with an internal
 *  retry for a self-owned lost race). */
const remember = async (
  store: KnowledgeStore,
  input: RememberInput & { subdir: string; mountPrefix: string },
): Promise<RememberResult> => {
  const { subdir, mountPrefix } = input
  const summaryUpdated = input.summary !== undefined

  for (let attempt = 0; ; attempt++) {
    const existing = await findMemoryNote(store, input.category, subdir, mountPrefix)

    if (!existing?.id) {
      // Mint the note. `directory` is mount-relative (the engine prepends the prefix
      // once). A concurrent same-category first-touch collides honestly and is caught
      // below rather than clobbering the winner.
      try {
        const created = await store.write({
          title: input.category,
          content: input.observation,
          targetClass: NOTE_CLASS.agentMemory,
          directory: subdir || undefined,
          // PINNED to the category, never left to the name formula: the convergence
          // this retry provides rests on a concurrent first-touch hitting the SAME
          // path and being refused. With a letterless category the formula falls to
          // its id rung, every racer mints a different id, nobody collides, and one
          // category ends up with two notes (#296).
          fileName: memoryFileName(input.category),
          summary: input.summary,
          principal: input.principal,
          agent: input.agent,
        })
        return await withEcho(created, input.observation, 'created', summaryUpdated)
      } catch (err) {
        // Lost the create race → retry: the re-find now sees the winner and appends.
        if (
          (err as { reason?: string }).reason === STORE_ERROR_REASON.noteAlreadyExists &&
          attempt < 2
        ) {
          continue
        }
        throw err
      }
    }
    const note = await store.read(existing.id)
    const id = note.id ?? existing.id
    const token = note.versionToken ?? ''

    if (input.versionToken && input.versionToken !== token) {
      throw versionConflict({ ...note, id, versionToken: token })
    }
    const next = applyEdit(note.content, {
      noteId: id,
      operation: EDIT_OPERATION.append,
      content: input.observation,
    })
    // Carry summary/tags/type forward — a write that omits them clears them.
    const nextSummary =
      input.summary ??
      (typeof note.frontmatter?.summary === 'string' ? note.frontmatter.summary : undefined)

    try {
      // No `directory` → the engine leaves the note in its current folder.
      const appended = await store.write({
        title: note.title ?? input.category,
        content: next,
        originalId: id,
        // The pin has to be RE-STATED on every write, not only on the create: an edit
        // that omits it re-derives the basename from the title, and a letterless
        // category lands back on the id rung — renaming the note off the pinned path
        // and freeing it for a racer to create a second note of the same category.
        fileName: memoryFileName(note.title ?? input.category),
        versionToken: token,
        summary: nextSummary,
        tags: normTags(note.frontmatter?.tags),
        noteType: typeof note.frontmatter?.type === 'string' ? note.frontmatter.type : undefined,
        principal: input.principal,
        agent: input.agent,
      })
      return await withEcho(appended, next, 'appended', summaryUpdated)
    } catch (err) {
      // We own the token → a lost CAS race is ours to retry.
      if (!input.versionToken && (err as { isConflict?: boolean }).isConflict && attempt < 2) {
        continue
      }
      throw err
    }
  }
}

export const rememberAboutUser = (
  store: KnowledgeStore,
  input: RememberAboutUserInput,
): Promise<RememberResult> =>
  remember(store, { ...input, subdir: '', mountPrefix: AGENT_MEMORY_MOUNT })

/** Lands in the project's `.notarium/memory/<id>/` partition; the gateway has already
 *  resolved the handle to an id and checked authz. */
export const rememberAboutProject = (
  store: KnowledgeStore,
  input: RememberAboutProjectInput,
): Promise<RememberResult> =>
  remember(store, { ...input, subdir: input.projectId, mountPrefix: AGENT_MEMORY_MOUNT })

/** Rebuild the derived memory index for one subdir ('' = about-user, '<id>' =
 *  about-project): one entry per category, keyed off `summary` frontmatter, falling
 *  back to a content snippet. Reads live notes, so it reflects the latest state. */
export const buildMemoryIndex = async (
  store: KnowledgeStore,
  opts: { subdir?: string; mountPrefix?: string } = {},
): Promise<MemoryIndexEntry[]> => {
  const subdir = opts.subdir ?? ''
  const mountPrefix = opts.mountPrefix ?? AGENT_MEMORY_MOUNT
  const metas = await store.list({
    scope: READ_SCOPE.agentRecall,
    classes: [NOTE_CLASS.agentMemory],
  })
  const out: MemoryIndexEntry[] = []

  for (const m of metas) {
    if (m.class !== NOTE_CLASS.agentMemory || m.id == null) {
      continue
    }
    if (memoryDirOf(m.filePath, mountPrefix) !== subdir) {
      continue
    }
    const note = await store.read(m.id)
    const fmSummary =
      typeof note.frontmatter?.summary === 'string' ? note.frontmatter.summary.trim() : ''
    const summary = fmSummary || makeSnippet(note.content, 160)
    out.push({
      noteId: note.id ?? m.id,
      category: note.title ?? m.title,
      summary,
      // The eager profile carries the summary, not the body, so token cost = summary weight.
      tokens: estimateTokens(summary),
      muted: isMutedFlag(note.frontmatter?.muted),
      modifiedAt: m.modifiedAt ?? null,
    })
  }

  return out
}
