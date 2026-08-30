// The auth service's live-SSE registry: named nudges/disconnects over the
// in-process socket set (sseHandles) built in AuthCtx.
// canon: docs/auth.md#sse-revoke-disconnect

import { type AuthCtx, type SseHandle } from './authService'

export const createSse = (ctx: AuthCtx) => ({
  disconnectAllSse: (): void => {
    ctx.dropSse(() => true)
  },

  registerSse: (handle: SseHandle): (() => void) => {
    ctx.sseHandles.add(handle)
    return () => ctx.sseHandles.delete(handle)
  },

  notifySpaceRenamed: (spaceId: string): void => {
    ctx.notifyRenameOf(spaceId)
  },

  /** Owner-global episode list changed through MCP; every tab for that owner
   *  refetches the REST projection, independent of its active Space. */
  notifyAgentSessionsChanged: (owner: string): void => {
    ctx.notifyAgentSessionsOf(owner)
  },

  /** Owner-scoped, not space-scoped: mirrors the REST ownership check so a job's
   *  status/error/artifact never leaks to other space members. */
  notifyJobChanged: (spaceId: string, ownerPrincipalId: string, payload: unknown): void => {
    ctx.notifyJobOf(spaceId, ownerPrincipalId, payload)
  },

  /** Call only on a real membership mint (space creation) — NOT inside grantOwner,
   *  which re-asserts the idempotent owner row on every login/accept/touch and would
   *  spam every tab.
   *  canon: docs/auth.md#loss-of-access-at-runtime-explicit-takeover-111 */
  notifyGrantsChanged: (username: string): void => {
    ctx.notifySse((h) => h.username === username)
  },

  /** Drop everyone viewing this space FIRST (their EventSource death is the takeover
   *  trigger), then nudge members' OTHER tabs (space !== spaceId — already dropped)
   *  to reloadSpaces. Call AFTER the registry marks it archived.
   */
  notifySpaceArchived: async (spaceId: string): Promise<void> => {
    const archivedSocket = (h: SseHandle) => h.space === spaceId || h.spaces?.has(spaceId) === true

    // Archive is already durable when this hook runs. Close delivery authority before
    // the member-list read used only to wake OTHER surviving tabs.
    ctx.notifySse(archivedSocket)
    ctx.dropSse(archivedSocket)
    const members = await ctx.db.membersOf(spaceId)

    for (const m of members) {
      ctx.notifySse(
        (h) => h.username === m.username && h.space !== spaceId && h.spaces?.has(spaceId) !== true,
      )
    }
  },

  notifySpaceRestored: async (spaceId: string): Promise<void> => {
    const members = await ctx.db.membersOf(spaceId)

    for (const m of members) {
      ctx.notifySse((h) => h.username === m.username)
    }
  },

  /** Revoke = disconnect: drop a principal's live sockets when its token is revoked.
   */
  disconnectPrincipal: (principalId: string): void => {
    ctx.dropSse((h) => h.principalId === principalId)
  },
})
