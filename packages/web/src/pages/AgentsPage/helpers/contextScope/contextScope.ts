/** The Context surface's axis for a project, taken from the project's handle: the
 *  handle is `<space>/<project>` and the axis is the project part alone — the Space is
 *  already carried beside it (rememberContextScopeSpace), so repeating it in the axis
 *  would address a scope that does not exist. A handle without a Space IS the axis. */
export const projectContextScope = (handle: string): string =>
  handle.includes('/') ? handle.slice(handle.indexOf('/') + 1) : handle

/** The query parameter that addresses ONE exact owned role placement on the Context
 *  surface. Named once because five places spelled it by hand, and the fifth would have
 *  been the tab rule below — a rule about a parameter is the last place that should be
 *  guessing its name. */
export const CONTEXT_ROLE_PARAM = 'role'

/** The query a Context SCOPE tab may carry across (#309).
 *
 *  Everything except the role. A role locator addresses one exact placement, so it
 *  cannot mean anything in the scope a tab is switching TO: carried across, it becomes a
 *  selection the destination is unable to hold. That used to be discovered a round-trip
 *  later — the destination fetched, found no such role in its own preview, then undid
 *  the URL and apologised with a warning. Dropping it here means the tab addresses the
 *  destination's Base context directly and the apology has nothing to be about.
 *
 *  What this buys beyond one fewer round-trip: `?role=` keeps meaning exactly one thing
 *  wherever it survives — a deliberate address, to be honoured and explained, never a
 *  leftover to be second-guessed. Without that, a page cannot tell "the reader asked for
 *  this role" from "a tab dragged it along", and the two want opposite answers. */
export const contextScopeSearch = (search: string): string => {
  const params = new URLSearchParams(search)
  params.delete(CONTEXT_ROLE_PARAM)
  const rest = params.toString()

  return rest ? `?${rest}` : ''
}
