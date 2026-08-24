import { defineClientFailure } from '../../../libs/clientFailure'

/** This deployment cannot publish a package at the target the caller named, and
 *  nothing was published there.
 *
 *  Raised in exactly two places, and neither is a guess: composition could not
 *  hand out a writer for the placement at all, or the storage commit itself
 *  refused this pathname before it landed. Anything wider — a raw errno caught
 *  around a whole service call, a proof failure after a successful rename —
 *  would answer "unavailable" for a package that may well be on disk. */
export class RoleInstallUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    defineClientFailure(this, { kind: 'actionable', message })
  }
}
