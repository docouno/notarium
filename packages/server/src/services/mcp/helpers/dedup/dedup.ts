// Write-retry idempotency layer + create/remember write-echo builder.
// canon: docs/contract.md#cas
import { type ToolName } from '@notarium/contract/tools'

import { type DedupResult } from '../../../metaDb'
import { type Ctx } from '../../gateway'
import { notePath } from '../projectAddressing'

/** Idempotency window: a day covers any realistic client retry. */
const DEDUP_IDEM_TTL_MS = 24 * 60 * 60 * 1000

// ── write-retry dedup ───────────────────────────────────────────

/** Collapse simultaneous and durable replays of one successful write.
 *  Without gateway state, only the simultaneous in-process branch remains.
 *  @see docs/mcp-gateway.md#limits */
export const dedupedWrite = async <T extends DedupResult>(
  ctx: Ctx,
  keys: { toolName: ToolName; idempotencyKey?: string; scopeKey?: string },
  run: () => Promise<T>,
): Promise<{ result: T | DedupResult; wasHit: boolean }> => {
  const gs = ctx.gatewayState
  const idempotencyKey = keys.idempotencyKey

  if (!idempotencyKey) {
    return { result: await run(), wasHit: false }
  }
  // `scopeKey` namespaces dedup per target (e.g. project id): the same
  // idempotencyKey reused across two projects must NOT replay the first's note
  // (that would silently skip the second write).
  const scope = `idem:${ctx.principal.id}:${keys.toolName}${keys.scopeKey ? `:${keys.scopeKey}` : ''}`
  const inFlight = ctx.idempotencyInFlight
  const flightKey = `${scope}\0${idempotencyKey}`
  const running = inFlight?.get(flightKey)

  if (running) {
    // Its outcome IS ours. `wasHit` is forced true: whatever the runner was, we
    // performed no write — the same shape a sequential replay answers with.
    return { result: (await running).result, wasHit: true }
  }
  const attempt = (async (): Promise<{ result: DedupResult; wasHit: boolean }> => {
    const nowMs = ctx.now().getTime()
    const hit = gs
      ? await gs.dedupGet(scope, idempotencyKey, new Date(nowMs - DEDUP_IDEM_TTL_MS).toISOString())
      : null

    if (hit) {
      return { result: hit, wasHit: true }
    }
    const result = await run()

    if (gs) {
      await gs.dedupPut(
        scope,
        idempotencyKey,
        { noteId: result.noteId, versionToken: result.versionToken },
        new Date(nowMs).toISOString(),
      )
      await gs.dedupPrune(new Date(nowMs - DEDUP_IDEM_TTL_MS).toISOString())
    }

    return { result, wasHit: false }
  })()

  // Registered with NO await between the lookup above and this line — an await there
  // is exactly the window being closed.
  inFlight?.set(flightKey, attempt)
  try {
    // `wasHit` comes out of the attempt, never a constant: a SEQUENTIAL replay lands
    // here too (the key is off the map by then) and is a hit through the table, which
    // is what makes its answer `outcome: 'skipped'`.
    return await attempt
  } finally {
    if (inFlight?.get(flightKey) === attempt) {
      inFlight.delete(flightKey)
    }
  }
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
