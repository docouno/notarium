import { defineClientFailure } from '../../../libs/clientFailure'

/** The addressed ability is not one this principal can reach: no such placement, no
 * such package, or no grant. Distinct from an internal failure so a route can answer
 * "not found" for the first and stay loud about the second.
 *
 * The three causes share ONE wire message on purpose — telling them apart is the
 * enumeration the anti-enumeration 404 refuses (canon: docs/auth.md#model) — while the
 * specific one stays in `cause` for the server log. The host error handler answers the
 * class itself, so a route that forgets to catch it cannot turn it into a 500 — the
 * answer stops depending on every call site remembering to wire it. */
export class AbilityUnavailableError extends Error {
  constructor(cause: string) {
    super('not found')
    this.cause = cause
    defineClientFailure(this, { kind: 'not-found' })
  }
}
