// Agent-memory writes: remember_about_user / remember_about_project.
// canon: docs/note-model.md#agent-memory

import type { KnowledgeStore, NoteMeta, WriteResult } from '../../knowledgeStore'
import { NOTE_CLASS, READ_SCOPE, STORE_ERROR_REASON, versionConflict } from '../../knowledgeStore'
import { sha256Hex } from '../../libs/hash'
import { estimateTokens } from '../../libs/markdown'
import { slugify } from '../../libs/slug'
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

/** Find the category note, scoped by class AND mount-dir so sibling projects'
 *  same-category notes never collide. A bare engine ignores `scope`, so these
 *  filters — not the list scope — are the real guard. */
const findMemoryNote = async (
  store: KnowledgeStore,
  category: string,
  subdir: string,
  mountPrefix: string,
): Promise<NoteMeta | undefined> => {
  const want = slugify(category)
  const metas = await store.list({ scope: READ_SCOPE.agentRecall })
  return metas.find(
    (m) =>
      m.class === NOTE_CLASS.agentMemory &&
      m.id != null &&
      slugify(m.title) === want &&
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
          summary: input.summary,
          principal: input.principal,
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
        versionToken: token,
        summary: nextSummary,
        tags: normTags(note.frontmatter?.tags),
        noteType: typeof note.frontmatter?.type === 'string' ? note.frontmatter.type : undefined,
        principal: input.principal,
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
  const metas = await store.list({ scope: READ_SCOPE.agentRecall })
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
      noteId: m.id,
      category: note.title ?? m.title,
      summary,
      // The eager profile carries the summary, not the body, so token cost = summary weight.
      tokens: estimateTokens(summary),
      muted: isMutedFlag(note.frontmatter?.muted),
    })
  }

  return out
}
