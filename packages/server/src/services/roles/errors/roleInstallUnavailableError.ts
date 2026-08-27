import { defineClientFailure } from '../../../libs/clientFailure'

/** This deployment could not give the caller the target it named, and the operation
 *  was refused rather than half-done.
 *
 *  Raised only where that premise is proven, never guessed: composition could not
 *  hand out a writer for the placement at all; the storage commit itself refused
 *  this pathname before it landed; or a publication that DID land was refused
 *  afterwards and undone as a whole — same protocol back, then the reach row and
 *  the placement trail. An undo can itself be refused, and then the package really
 *  is at the new home; the caller still gets this answer and the operator log is
 *  where that difference is recorded — the same shape `moveFrom`'s own
 *  committed-and-unrollbackable outcome already takes.
 *
 *  What stays outside: a raw errno caught around a whole service call, or a proof
 *  failure that was never followed by an undo attempt. Either would answer
 *  "unavailable" about a package nobody looked for. */
export class RoleInstallUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    defineClientFailure(this, { kind: 'actionable', message })
  }
}
