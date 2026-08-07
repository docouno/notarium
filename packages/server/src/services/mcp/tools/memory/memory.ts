// Agent-memory write handlers: remember_about_user + remember_about_project.
// canon: docs/note-model.md#agent-memory · docs/projects.md#memory-two-axes
import {
  type RememberAboutProjectInput,
  type RememberAboutUserInput,
} from '@notarium/contract/tools'
import { rememberAboutProject, rememberAboutUser } from '@notarium/core'

import { can } from '../../../authz'
import { type Handler, ToolFailure } from '../../gateway'
import { dedupedWrite, wireSpace, writeEcho, type WriteRun } from '../../helpers/dedup'
import { handleOf } from '../../helpers/projectAddressing'
import { writeAttributionOf } from '../../helpers/writeAttribution'
import { sanitizeText } from '../../sanitize'

export const handleRememberUser: Handler = async (ctx, rawArgs) => {
  const { observation, category, summary, versionToken, idempotencyKey } =
    rawArgs as RememberAboutUserInput

  // z.string().min(1) still admits whitespace; category chars would break the note's
  // title heading. Guards run BEFORE dedup, so a malformed call always errors.
  if (observation.trim() === '') {
    throw new ToolFailure('`observation` must be a non-empty fact to remember.')
  }
  if (category.trim() === '' || /[[\]|#\r\n]/.test(category)) {
    throw new ToolFailure(
      '`category` must be a simple label (e.g. "preferences") without brackets or newlines.',
    )
  }
  // APPEND, not create: no content-hash dedup window — a retry without idempotencyKey
  // duplicates the observation (honest `idempotentHint:false`).
  let mintedSpace: string | null = null
  const { result, wasHit } = await dedupedWrite<WriteRun>(
    ctx,
    { toolName: 'remember_about_user', idempotencyKey },
    async () => {
      // ensurePersonalDomain MINTS on first touch (side-effect); personalSpace() only peeks.
      const space = await ctx.ensurePersonalDomain()
      mintedSpace = space
      // SECURITY: read-by-id is NOT visibility-scoped, so private memory must land only in a
      // genuinely private domain. If the minted space differs from the recorded personalSpace(),
      // this is the shared-default degradation (co-members could read it by id) — refuse.
      if ((await ctx.personalSpace()) !== space) {
        throw new ToolFailure(
          'this host cannot provision a private memory domain for you — personal memory is unavailable here.',
        )
      }
      // No can() check here, deliberately: a space minted this request isn't yet in the
      // auth-time grant snapshot, so can() would wrongly 404 a fresh user's first memory.
      // The PAT's optional space narrowing still binds (checked next).
      if (ctx.principal.spaces && !ctx.principal.spaces.has(space)) {
        throw new ToolFailure('your token is not scoped to your personal memory domain.')
      }
      const spaceStore = await ctx.spaces.store(space)
      const r = await rememberAboutUser(spaceStore, {
        observation,
        category,
        summary,
        versionToken,
        ...writeAttributionOf(ctx),
      })
      return {
        noteId: r.id ?? '',
        versionToken: r.versionToken ?? '',
        filePath: r.filePath,
        outcome: r.outcome,
        bodyBytes: r.bodyBytes,
        bodyHash: r.bodyHash,
        summaryUpdated: r.summaryUpdated,
      }
    },
  )
  // wireSpace suppresses `space` (→ undefined) when the minted space IS the personal domain.
  const structured = writeEcho(result, wasHit, {
    space: wireSpace(ctx, mintedSpace ?? undefined, await ctx.personalSpace()),
  })
  const markdown =
    `Remembered under **${sanitizeText(category)}** in your personal memory. ` +
    `Note id \`${structured.noteId}\`.`
  return { markdown, structured }
}

export const handleRememberProject: Handler = async (ctx, rawArgs) => {
  const { project, observation, category, summary, versionToken, idempotencyKey } =
    rawArgs as RememberAboutProjectInput

  // Same blank guards as handleRememberUser: min(1) admits whitespace; category chars
  // break the title heading. Guards run before dedup.
  if (observation.trim() === '') {
    throw new ToolFailure('`observation` must be a non-empty fact to remember.')
  }
  if (category.trim() === '' || /[[\]|#\r\n]/.test(category)) {
    throw new ToolFailure(
      '`category` must be a simple label (e.g. "decisions") without brackets or newlines.',
    )
  }
  // resolveProject collapses existence + reachability into one 404-semantic error.
  const rec = await ctx.resolveProject(project)

  // can(space:write) is the real barrier; no-write reads as "no such project"
  // (404-semantics, missing + unauthorised alike — anti-enumeration). A
  // `rec.space === personalSpace()` belt-guard is deliberately ABSENT: a personal domain
  // legitimately holds projects (in none-mode it IS the default space), so the belt would
  // kill the feature; privacy holds via the single-member personal domain.
  if (!can(ctx.principal, 'space:write', { space: rec.space })) {
    throw new ToolFailure(`no such project: ${project}`)
  }
  const { result, wasHit } = await dedupedWrite<WriteRun>(
    ctx,
    // scopeKey = project id, so the same idempotencyKey reused across two projects
    // doesn't return the first project's note.
    { toolName: 'remember_about_project', idempotencyKey, scopeKey: rec.id },
    async () => {
      const spaceStore = await ctx.spaces.store(rec.space)
      const r = await rememberAboutProject(spaceStore, {
        projectId: rec.id,
        observation,
        category,
        summary,
        versionToken,
        ...writeAttributionOf(ctx),
      })
      return {
        noteId: r.id ?? '',
        versionToken: r.versionToken ?? '',
        filePath: r.filePath,
        outcome: r.outcome,
        bodyBytes: r.bodyBytes,
        bodyHash: r.bodyHash,
        summaryUpdated: r.summaryUpdated,
      }
    },
  )
  const structured = writeEcho(result, wasHit, {
    space: wireSpace(ctx, rec.space, await ctx.personalSpace()),
  })
  const markdown =
    `Remembered about project \`${handleOf(rec, ctx.spaces.slugOf(rec.space) ?? rec.space)}\` under **${sanitizeText(category)}**. ` +
    `Note id \`${structured.noteId}\`.`
  return { markdown, structured }
}
