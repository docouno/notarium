// Container reorg tools: move_folder / rename_folder / rename_project.
// canon: docs/projects.md#lifecycle
import {
  type MoveFolderInput,
  type RenameFolderInput,
  type RenameProjectInput,
} from '@notarium/contract/tools'
import { READ_SCOPE } from '@notarium/core'

import { safeRelPath } from '../../../../libs/relPath'
import { can } from '../../../authz'
import { finalizeFolderMove, renameProjectSlug } from '../../../projects'
import { type Ctx, type Handler, type Rendered, ToolFailure } from '../../gateway'
import { wireSpace } from '../../helpers/dedup'
import { handleOf } from '../../helpers/projectAddressing'
import { sanitizeText } from '../../sanitize'

/** Shared folder move/rename orchestration for move_folder / rename_folder.
 *  `src`/`dest` are space-relative, already safeRelPath-normalised and non-root —
 *  the caller guarantees this; reorgFolder does not re-validate. */
const reorgFolder = async (
  ctx: Ctx,
  opts: { project?: string; src: string; dest: string },
): Promise<Rendered> => {
  // Denial — an unreachable handle OR a no-write membership — throws the SAME "no such
  // folder" (anti-enumeration, never a 403 that confirms existence).
  // canon: docs/mcp-gateway.md#security
  const personal = await ctx.personalSpace()
  const space =
    opts.project !== undefined ? (await ctx.resolveProject(opts.project)).space : personal

  if (!space) {
    throw new ToolFailure('no such folder, or you do not have access to it')
  }
  if (!can(ctx.principal, 'space:write', { space })) {
    throw new ToolFailure('no such folder, or you do not have access to it')
  }
  const wire = wireSpace(ctx, space, personal)
  const spaceStore = await ctx.spaces.store(space)

  // No-op (src === dest): skip the engine (its dir-move rejects dest === src as "into
  // itself"), but first CONFIRM the folder exists — else a ghost/typo'd path reads as a
  // false "already there" success (move_note 404s on a ghost note; a folder must too).
  // Exists = the dir channel lists it/a descendant, OR a note lives under it.
  if (opts.src === opts.dest) {
    const underSrc = (p: string | null | undefined): boolean =>
      p === opts.src || (p ?? '').startsWith(`${opts.src}/`)
    const dirs = (await spaceStore.listDirs?.()) ?? []
    const exists =
      dirs.some(underSrc) ||
      (await spaceStore.list({ scope: READ_SCOPE.all })).some((n) => underSrc(n.filePath))

    if (!exists) {
      throw new ToolFailure('no such folder, or you do not have access to it')
    }

    return {
      structured: { path: opts.dest, ...(wire ? { space: wire } : {}) },
      markdown: `Folder is already at \`${opts.dest}\`.`,
    }
  }
  await spaceStore.move(
    { id: opts.src, destinationPath: opts.dest, isDirectory: true },
    {
      finalize: () =>
        finalizeFolderMove(
          {
            projects: ctx.projects,
            folders: ctx.folders,
            markerStore: ctx.markerStore,
            now: ctx.now,
            onError: (stage, err) =>
              console.error(`[mcp] reorgFolder ${stage} ->`, (err as Error)?.message),
          },
          { space, oldPath: opts.src, newPath: opts.dest },
        ),
    },
  )

  return {
    structured: { path: opts.dest, ...(wire ? { space: wire } : {}) },
    markdown: `Folder moved to \`${opts.dest}\`.`,
  }
}

export const handleMoveFolder: Handler = async (ctx, rawArgs) => {
  const { folder, toFolder, project } = rawArgs as MoveFolderInput
  // Leading slash = "from the root" shorthand (list_notes paths carry none) — strip
  // before safeRelPath (which fails closed on traversal / the dot-namespace mount).
  // '' = the space root: not a movable folder (that would be a space rename, a human act).
  const src = safeRelPath(folder.replace(/^\/+/, ''))

  if (src === null) {
    throw new ToolFailure('bad folder')
  }
  if (src === '') {
    throw new ToolFailure(
      'the space root is not a movable folder — renaming a space is a human action.',
    )
  }
  const parent = safeRelPath(toFolder.replace(/^\/+/, ''))

  if (parent === null) {
    throw new ToolFailure('bad destination folder')
  }
  const base = src.includes('/') ? src.slice(src.lastIndexOf('/') + 1) : src
  const dest = parent ? `${parent}/${base}` : base
  return reorgFolder(ctx, { project, src, dest })
}

export const handleRenameFolder: Handler = async (ctx, rawArgs) => {
  const { folder, name, project } = rawArgs as RenameFolderInput
  const src = safeRelPath(folder.replace(/^\/+/, ''))

  if (src === null) {
    throw new ToolFailure('bad folder')
  }
  if (src === '') {
    throw new ToolFailure(
      'the space root is not a renamable folder — renaming a space is a human action.',
    )
  }
  if (name.includes('/')) {
    throw new ToolFailure(
      "`name` is a folder name, not a path — use move_folder to change a folder's location.",
    )
  }
  const leaf = safeRelPath(name)

  if (!leaf) {
    throw new ToolFailure('bad folder name')
  }
  const parent = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''
  const dest = parent ? `${parent}/${leaf}` : leaf
  return reorgFolder(ctx, { project, src, dest })
}

export const handleRenameProject: Handler = async (ctx, rawArgs) => {
  const { project, slug, displayName } = rawArgs as RenameProjectInput

  // At least one axis to change. Validated in the handler (not the zod top-level —
  // transport reads `t.input.shape`, and a cross-field refine would erase `.shape`).
  if (slug === undefined && displayName === undefined) {
    throw new ToolFailure('pass a new `slug` (the handle) and/or a `displayName` to change.')
  }
  if (!ctx.projects) {
    throw new ToolFailure(`no such project: ${project}`)
  }
  // resolveProject = read-reachability only (a past-alias handle still resolves); the
  // write gate is separate, below — so every miss/denial → the SAME "no such project"
  // (anti-enumeration, never a 403).
  // canon: docs/projects.md#addressing
  const rec = await ctx.resolveProject(project)

  if (!can(ctx.principal, 'space:write', { space: rec.space })) {
    throw new ToolFailure(`no such project: ${project}`)
  }
  // A present-but-UNAVAILABLE marker store (space with no local notes dir) would throw
  // deep in writeMarkerFor as an opaque 'internal error' — guard early and 404 honestly.
  // Entirely-absent store (registry-only host) is fine: renameProjectSlug skips the write.
  if (ctx.markerStore && !ctx.markerStore.available(rec.space)) {
    throw new ToolFailure(`no such project: ${project}`)
  }
  // O(1) handle rename — the old slug retires into alias-history.
  const result = await renameProjectSlug(
    { projects: ctx.projects, markerStore: ctx.markerStore, now: ctx.now },
    { space: rec.space, id: rec.id, slug, displayName },
  )

  if (!result.ok) {
    if (result.code === 'not_found') {
      throw new ToolFailure(`no such project: ${project}`)
    }
    if (result.code === 'root') {
      throw new ToolFailure(
        "this project's handle is its space's name — to rename it, rename the space (a human action), not the project.",
      )
    }
    if (result.code === 'collision') {
      throw new ToolFailure(
        'a project with that handle already exists in this space — pick another slug.',
      )
    }
    throw new ToolFailure(
      'that slug is empty after normalising — pick a slug with at least one letter or digit.',
    )
  }
  const spaceSlug = ctx.spaces.slugOf(rec.space) ?? rec.space
  const handle = handleOf(result.record, spaceSlug)
  const structured: Record<string, unknown> = {
    id: result.record.id,
    handle,
    displayName: sanitizeText(result.record.displayName),
    ...(result.record.aliases.length ? { aliases: result.record.aliases } : {}),
  }
  const markdown =
    `Renamed project to **${structured.displayName}** (\`${handle}\`).` +
    (result.record.aliases.length ? ' The old handle still resolves as an alias.' : '')
  return { markdown, structured }
}
