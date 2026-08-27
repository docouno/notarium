import type { OwnedAbilityLocator } from '@notarium/contract'
import { defineClientFailure } from '../../../libs/clientFailure'

/** A placement move that COMMITTED — bytes, reach row and placement trail all at the
 *  new home — and then could not be CONFIRMED there, because the read-model barrier
 *  that crosses to the publication threw instead of answering.
 *
 *  Deliberately not `RoleInstallUnavailableError`: that answer states the operation
 *  was refused rather than half-done, and a caller who retries on it would race the
 *  very package this call published — the same reason the Add path does not name a
 *  failure after its own commit either. Nothing is rolled back for it, so the durable
 *  state remains the whole, coherent move.
 *
 *  Which leaves exactly one thing the caller must not lose: the ADDRESS. `locator`
 *  names where the package IS, never the placement it left, and every answer that
 *  carries a locator past a failed move step reads it from here — a client sent back
 *  to the old placement would be addressing a home this role no longer has. */
export class RolePlacementUnconfirmedError extends Error {
  constructor(
    message: string,
    readonly locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
    cause?: unknown,
  ) {
    super(message)
    this.cause = cause
    defineClientFailure(this, { kind: 'actionable', message })
  }
}
