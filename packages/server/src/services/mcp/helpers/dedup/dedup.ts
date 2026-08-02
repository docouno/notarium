// Write-retry idempotency layer + create/remember write-echo builder.
// canon: docs/contract.md#cas
import { type ToolName } from '@notarium/contract/tools'

import { type DedupResult } from '../../../metaDb'
import { type Ctx } from '../../gateway'
import { notePath } from '../projectAddressing'

/** Idempotency window: a day covers any realistic client retry. */
const DEDUP_IDEM_TTL_MS = 24 * 60 * 60 * 1000

// ── write-retry dedup ───────────────────────────────────────────

/** Run a write through the idempotency layer. Only a SUCCESSFUL write is recorded
 *  (validation/authz errors before this), so a dedup hit implies the original was
 *  authorized; without gatewayState it's a pass-through (honest degradation, P5).
 *  Deliberately NO content-hash fallback: a hash tight enough not to false-merge two
 *  distinct notes only ever matches what the path-upsert already collapses (inert);
 *  idempotencyKey is the non-redundant case — it collapses a retry the model RE-TITLED,
 *  which path-upsert can't. */
export const dedupedWrite = async <T extends DedupResult>(
  ctx: Ctx,
  keys: { toolName: ToolName; idempotencyKey?: string; scopeKey?: string },
  run: () => Promise<T>,
): Promise<{ result: T | DedupResult; wasHit: boolean }> => {
  const gs = ctx.gatewayState

  if (!gs || !keys.idempotencyKey) {
    return { result: await run(), wasHit: false }
  }
  const nowMs = ctx.now().getTime()
  // `scopeKey` namespaces dedup per target (e.g. project id): the same
  // idempotencyKey reused across two projects must NOT replay the first's note
  // (that would silently skip the second write).
  const scope = `idem:${ctx.principal.id}:${keys.toolName}${keys.scopeKey ? `:${keys.scopeKey}` : ''}`
  const hit = await gs.dedupGet(
    scope,
    keys.idempotencyKey,
    new Date(nowMs - DEDUP_IDEM_TTL_MS).toISOString(),
  )

  if (hit) {
    return { result: hit, wasHit: true }
  }
  const result = await run()
  await gs.dedupPut(
    scope,
    keys.idempotencyKey,
    { noteId: result.noteId, versionToken: result.versionToken },
    new Date(nowMs).toISOString(),
  )
  await gs.dedupPrune(new Date(nowMs - DEDUP_IDEM_TTL_MS).toISOString())
  return { result, wasHit: false }
}

/** In-process result of a write run(): dedup-stable identity + the transparency
 *  echo. Only {noteId, versionToken} survives replay; the echo rides the live path. */
export type WriteRun = DedupResult & {
  filePath?: string
  outcome?: 'created' | 'appended'
  bodyBytes?: number
  bodyHash?: string
  summaryUpdated?: boolean
}

/** Project a space id to its wire `space` label: the display slug, or undefined
 *  for the personal domain (suppressed). canon: docs/spaces.md#model */
export const wireSpace = (
  ctx: Ctx,
  spaceId: string | undefined,
  personal: string | null,
): string | undefined => {
  if (!spaceId || spaceId === personal) {
    return undefined
  }

  return ctx.spaces.slugOf(spaceId) ?? spaceId
}

/** Assemble a create/remember write-echo from a dedupedWrite outcome; `opts.space`
 *  is the pre-resolved wire slug (caller ran wireSpace). */
export const writeEcho = (
  result: DedupResult,
  wasHit: boolean,
  opts: { space?: string },
): Record<string, unknown> => {
  const echo = result as WriteRun
  const out: Record<string, unknown> = { noteId: result.noteId, versionToken: result.versionToken }
  const outcome = wasHit ? 'skipped' : echo.outcome

  if (outcome) {
    out.outcome = outcome
  }
  if (!wasHit) {
    const p = notePath(echo.filePath)

    if (p) {
      out.path = p
    }
    if (opts.space) {
      out.space = opts.space
    }
    if (echo.bodyBytes != null) {
      out.bodyBytes = echo.bodyBytes
    }
    if (echo.bodyHash != null) {
      out.bodyHash = echo.bodyHash
    }
    if (echo.summaryUpdated != null) {
      out.summaryUpdated = echo.summaryUpdated
    }
  }

  return out
}
