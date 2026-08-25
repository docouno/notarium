// Agent-memory writes: remember_about_user / remember_about_project.
// canon: docs/note-model.md#agent-memory

import type { ConflictNote, KnowledgeStore, NoteMeta, WriteResult } from '../../knowledgeStore'
import {
  memoryConvergenceExhausted,
  NOTE_CLASS,
  READ_SCOPE,
  STORE_ERROR_REASON,
  versionConflict,
} from '../../knowledgeStore'
import { pathHash, sha256Hex } from '../../libs/hash'
import { estimateTokens } from '../../libs/markdown'
import { MutationCoordinator } from '../../libs/mutationCoordinator'
import { CLIPPED_NAME_TAG_BYTES, clipToBytes, NOTE_BASENAME_MAX_BYTES } from '../../libs/path'
import { nameKey, slugify } from '../../libs/slug'
import { normTags } from '../../libs/tags'
import { makeSnippet } from '../../snippet'
import { applyEdit, EDIT_OPERATION } from '../editNote'
import {
  AGENT_MEMORY_MOUNT,
  CREATE_RACE_BUDGET,
  EXTERNAL_CONFLICT_BUDGET,
  NO_PROGRESS_BUDGET,
} from './consts'
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

/** A store instance owns one category-fence queue. */
const fences = new WeakMap<KnowledgeStore, MutationCoordinator>()

const fenceOf = (store: KnowledgeStore): MutationCoordinator => {
  const held = fences.get(store)

  if (held) {
    return held
  }
  const fresh = new MutationCoordinator()

  fences.set(store, fresh)
  return fresh
}

/** Run one category's full read-modify-write window under its partitioned name-key claim. */
export const withMemoryCategoryFence = <T>(
  store: KnowledgeStore,
  key: { subdir: string; category: string },
  task: () => Promise<T>,
): Promise<T> => fenceOf(store).run({ paths: [`${key.subdir}\0${nameKey(key.category)}`] }, task)

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

/** Return one coherent live snapshot after a refused CAS. */
const liveConflictAfter = async (
  store: KnowledgeStore,
  err: unknown,
  id: string,
): Promise<ConflictNote> => {
  const carried = (err as { current?: ConflictNote }).current

  if (carried) {
    return carried
  }
  const current = await store.read(id)

  return {
    ...current,
    id: current.id ?? id,
    versionToken: current.versionToken ?? '',
  }
}

/** Find-or-create the category note in `subdir`, then append by CAS under its fence. */
const appendObservation = async (
  store: KnowledgeStore,
  input: RememberInput & { subdir: string; mountPrefix: string },
): Promise<RememberResult> => {
  const { subdir, mountPrefix } = input
  const summaryUpdated = input.summary !== undefined
  let createRaces = 0
  let noProgress = 0
  let foreignCommits = 0

  for (;;) {
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
        if ((err as { reason?: string }).reason !== STORE_ERROR_REASON.noteAlreadyExists) {
          throw err
        }
        // Lost the create race → retry: the re-find now sees the winner and appends.
        // Its own budget, because the two rungs of the name formula can put two
        // DIFFERENT categories on one file, and that one never resolves (see consts).
        createRaces += 1

        if (createRaces > CREATE_RACE_BUDGET) {
          throw err
        }
        continue
      }
    }
    const note = await store.read(existing.id)
    const id = note.id ?? existing.id
    const token = note.versionToken ?? ''

    const hasCallerToken = input.versionToken !== undefined

    if (hasCallerToken && input.versionToken !== token) {
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
      // Caller-owned tokens and non-CAS failures are never retried here.
      if (hasCallerToken || !(err as { isConflict?: boolean }).isConflict) {
        throw err
      }
      const live = await liveConflictAfter(store, err, id)

      if (live.versionToken !== token) {
        // Token progress makes the retry productive: the next append derives from the live body.
        foreignCommits += 1

        if (foreignCommits > EXTERNAL_CONFLICT_BUDGET) {
          throw memoryConvergenceExhausted(input.category, foreignCommits, live)
        }
        continue
      }
      // Without token progress, repeating the same CAS cannot converge.
      noProgress += 1

      if (noProgress > NO_PROGRESS_BUDGET) {
        throw memoryConvergenceExhausted(input.category, foreignCommits, live)
      }
    }
  }
}

/** Fence caller-token checks together with the write they guard. */
const remember = (
  store: KnowledgeStore,
  input: RememberInput & { subdir: string; mountPrefix: string },
): Promise<RememberResult> =>
  withMemoryCategoryFence(store, { subdir: input.subdir, category: input.category }, () =>
    appendObservation(store, input),
  )

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
  const eligible = metas.filter(
    (meta) =>
      meta.class === NOTE_CLASS.agentMemory &&
      meta.id != null &&
      memoryDirOf(meta.filePath, mountPrefix) === subdir,
  )
  const facts = store.noteFacts ? await store.noteFacts(eligible.map((meta) => meta.id!)) : {}

  for (const m of eligible) {
    const fact = facts[m.id!]
    const note = fact ? null : await store.read(m.id!)
    const fmSummary = fact
      ? (fact.summary?.trim() ?? '')
      : typeof note!.frontmatter?.summary === 'string'
        ? note!.frontmatter.summary.trim()
        : ''
    const summary = fmSummary || (fact ? fact.snippet : makeSnippet(note!.content, 160))
    out.push({
      noteId: note?.id ?? m.id!,
      category: fact?.title ?? note?.title ?? m.title,
      summary,
      // The eager profile carries the summary, not the body, so token cost = summary weight.
      tokens: estimateTokens(summary),
      muted: fact?.muted ?? isMutedFlag(note!.frontmatter?.muted),
      createdAt: m.createdAt ?? null,
      modifiedAt: m.modifiedAt ?? null,
    })
  }

  return out
}
