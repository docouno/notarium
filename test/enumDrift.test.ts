/**
 * Enum drift gate (P8).
 *
 * WHY: architecture P8 keeps `@notarium/core` and `@notarium/contract`
 * DECOUPLED — neither package imports the other. A domain enum that both layers
 * need (a scan phase, a revision kind, a note class, ...) therefore lives as TWO
 * independent const-object copies, one per package, each its own single source
 * of truth for its side. Nothing at compile time forces those two copies to stay
 * identical, so they can silently DRIFT (a value added to core's write path but
 * not to the wire schema, a renamed key, a dropped member) and only blow up far
 * downstream where a raw string crosses the seam. These tests are that missing
 * link: for every enum present in BOTH packages as the "same enum", they assert
 * the two decoupled copies are structurally equal (identical key set + identical
 * values), turning drift into a red test in this repo instead of a runtime bug.
 *
 * Exceptions (documented, not drift):
 *  - RESOLVED_VIA: core carries an extra `current` axis; contract deliberately
 *    omits it because `current` never crosses the graph-health wire. Not an
 *    identical copy — guarded as a subset relationship below, not by toEqual.
 *  - IF_EXISTS: contract omits core's `overwrite` on purpose — see the subset
 *    gate below; that omission is the poka-yoke, not drift.
 *  - STORE_ERROR_REASON: exists only in core; contract has no matching const
 *    source (only an inline `z.literal('version_conflict')`), so there is no
 *    cross-package pair to gate. Skipped here.
 */
import { describe, expect, it } from 'vitest'

import {
  AGENT_SESSION_ATTACH as ContractAgentSessionAttach,
  BUCKET_GRAN as ContractBucketGran,
  DATE_FIELD as ContractDateField,
  DEPTH as ContractDepth,
  IF_EXISTS as ContractIfExists,
  NOTE_CLASS as ContractNoteClass,
  NOTE_SORT as ContractNoteSort,
  RESOLVED_VIA as ContractResolvedVia,
  REVISION_KIND as ContractRevisionKind,
  REVISION_UNAVAILABLE_REASON as ContractRevisionUnavailableReason,
  SCAN_PHASE as ContractScanPhase,
  SORT_DIR as ContractSortDir,
} from '@notarium/contract'
// EDIT_OPERATION lives on contract's `./tools` subpath (the MCP tool surface),
// not the `/api/*` wire barrel, so it resolves from a different entry point.
import { EDIT_OPERATION as ContractEditOperation } from '@notarium/contract/tools'
import {
  AGENT_SESSION_ATTACH as CoreAgentSessionAttach,
  BUCKET_GRAN as CoreBucketGran,
  DATE_FIELD as CoreDateField,
  DEPTH as CoreDepth,
  EDIT_OPERATION as CoreEditOperation,
  IF_EXISTS as CoreIfExists,
  NOTE_CLASS as CoreNoteClass,
  NOTE_SORT as CoreNoteSort,
  RESOLVED_VIA as CoreResolvedVia,
  REVISION_KIND as CoreRevisionKind,
  REVISION_UNAVAILABLE_REASON as CoreRevisionUnavailableReason,
  SCAN_PHASE as CoreScanPhase,
  SORT_DIR as CoreSortDir,
} from '@notarium/core'

/** Enums that MUST be byte-for-byte identical copies across the P8 seam. */
const identicalPairs: ReadonlyArray<
  [name: string, core: Record<string, string>, contract: Record<string, string>]
> = [
  ['AGENT_SESSION_ATTACH', CoreAgentSessionAttach, ContractAgentSessionAttach],
  ['SCAN_PHASE', CoreScanPhase, ContractScanPhase],
  ['REVISION_KIND', CoreRevisionKind, ContractRevisionKind],
  ['REVISION_UNAVAILABLE_REASON', CoreRevisionUnavailableReason, ContractRevisionUnavailableReason],
  ['NOTE_SORT', CoreNoteSort, ContractNoteSort],
  ['SORT_DIR', CoreSortDir, ContractSortDir],
  ['BUCKET_GRAN', CoreBucketGran, ContractBucketGran],
  ['DATE_FIELD', CoreDateField, ContractDateField],
  ['DEPTH', CoreDepth, ContractDepth],
  ['EDIT_OPERATION', CoreEditOperation, ContractEditOperation],
  ['NOTE_CLASS', CoreNoteClass, ContractNoteClass],
]

describe('enum drift across the P8 core/contract seam', () => {
  describe.each(identicalPairs)('%s', (_name, core, contract) => {
    it('has the same key set in both packages', () => {
      expect(Object.keys(core).sort()).toEqual(Object.keys(contract).sort())
    })

    it('maps every key to the same value in both packages', () => {
      expect(core).toEqual(contract)
    })
  })

  // RESOLVED_VIA is NOT an identical copy: contract is a strict subset of core
  // (core adds `current`, which never crosses the graph-health wire). The gate
  // here is the intended relationship — contract ⊂ core, and every shared key
  // agrees on its value — so a drift on the SHARED axes still fails loudly while
  // the deliberate off-wire `current` divergence stays allowed.
  describe('RESOLVED_VIA (contract is a deliberate subset of core)', () => {
    it('exposes only keys that also exist in core', () => {
      for (const key of Object.keys(ContractResolvedVia)) {
        expect(CoreResolvedVia).toHaveProperty(key)
      }
    })

    it('agrees on the value of every shared key', () => {
      for (const [key, value] of Object.entries(ContractResolvedVia)) {
        expect(CoreResolvedVia[key as keyof typeof CoreResolvedVia]).toBe(value)
      }
    })

    it('keeps core-only `current` off the contract wire', () => {
      expect(CoreResolvedVia).toHaveProperty('current')
      expect(ContractResolvedVia).not.toHaveProperty('current')
    })
  })

  // IF_EXISTS is the same shape of deliberate subset, and here the omission is a
  // SECURITY property rather than tidiness: `overwrite` is the one policy that lets a
  // create replace another note's bytes, so it must stay unreachable from any client.
  // canon: docs/note-model.md#create-collisions
  describe('IF_EXISTS (contract is a deliberate subset of core)', () => {
    it('agrees on the value of every key it does expose', () => {
      for (const [key, value] of Object.entries(ContractIfExists)) {
        expect(CoreIfExists[key as keyof typeof CoreIfExists]).toBe(value)
      }
    })

    it('keeps `overwrite` off the wire — host-internal only', () => {
      expect(CoreIfExists).toHaveProperty('overwrite')
      expect(ContractIfExists).not.toHaveProperty('overwrite')
    })
  })
})
