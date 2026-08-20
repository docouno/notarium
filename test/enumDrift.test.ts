/**
 * Enum drift gate (P8).
 *
 * WHY: architecture P8 keeps `@notarium/core` and `@notarium/contract`
 * DECOUPLED — neither package takes a RUNTIME dependency on the other (the one
 * sanctioned edge is type-only, fenced in eslint.config.js: types erase, so core
 * still ships without contract). A domain enum that both layers
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

import { AbilityLocatorSchema, AuthoredAttachmentSchema } from '@notarium/contract'
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
import { isAbilityLocator, isSkillName, MAX_SKILL_TOKEN, parseSkillLinks } from '@notarium/core'
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

/**
 * The same P8 seam, one level up from a const object: the ability locator is a
 * SHAPE both layers must agree on. `core` carries a hand-written structural
 * predicate because the SPA imports core at runtime and the wire schema would drag
 * zod into the bundle (the `no-restricted-imports` rule on `@notarium/contract`
 * states that boundary). Two independent readers of one shape is exactly the drift
 * P8 accepts — and exactly what this gate is here to make loud.
 */
describe('ability locator drift (P8)', () => {
  const spaceId = 'AbCdefGhij_1'
  const packageId = 'PkGdefGhij_2'
  const projectId = 'PrJdefGhij_3'

  const candidates: unknown[] = [
    { source: 'system', kind: 'role', packageId },
    { source: 'catalog', kind: 'skill', packageId },
    { source: 'owned', kind: 'role', packageId, location: { scope: 'personal', spaceId } },
    { source: 'owned', kind: 'skill', packageId, location: { scope: 'space', spaceId } },
    {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'project', spaceId, projectId },
    },
    // A skill has no project placement — the one asymmetry both readers encode.
    {
      source: 'owned',
      kind: 'skill',
      packageId,
      location: { scope: 'project', spaceId, projectId },
    },
    // Closed world on both levels: an unknown key is not a locator.
    { source: 'system', kind: 'role', packageId, extra: 1 },
    {
      source: 'owned',
      kind: 'role',
      packageId,
      location: { scope: 'personal', spaceId, extra: 1 },
    },
    // A project placement without its project, and a space placement carrying one.
    { source: 'owned', kind: 'role', packageId, location: { scope: 'project', spaceId } },
    { source: 'owned', kind: 'role', packageId, location: { scope: 'space', spaceId, projectId } },
    { source: 'owned', kind: 'role', packageId },
    { source: 'nowhere', kind: 'role', packageId },
    { source: 'system', kind: 'ability', packageId },
    { source: 'system', kind: 'role', packageId: '' },
    { source: 'system', kind: 'role', packageId: 'a'.repeat(129) },
    { source: 'system', kind: 'role', packageId: 'has space' },
    { source: 'owned', kind: 'role', packageId, location: { scope: 'personal', spaceId: '' } },
    { source: 'system', kind: 'role' },
    null,
    'system:role',
    [],
  ]

  it.each(candidates.map((value, index) => [index, value] as const))(
    'answers the same for candidate %i',
    (_index, value) => {
      expect(isAbilityLocator(value)).toBe(AbilityLocatorSchema.safeParse(value).success)
    },
  )
})

/**
 * The same P8 seam, for the two bounds an ATTACHMENT is carried under. Core reads a
 * hand-edited `SKILL.md` and the wire carries what it read, so a value core accepts
 * and the wire refuses is not a validation difference — it is a 500 on the detail door
 * for a package the host called valid. That is exactly what happened: the label inside
 * an attachment token was matched by charset alone, with no length, while the wire caps
 * a skill name at 64; and a token measured at 1024 characters produced a 1028-character
 * `raw`, four over the cap the wire carries an unrecognised token back under.
 */
describe('skill attachment bounds drift (P8)', () => {
  const names: string[] = [
    'research-evidence',
    'a',
    '1',
    'a'.repeat(64),
    'a'.repeat(65),
    'a'.repeat(200),
    '',
    '-leading',
    'trailing-',
    'double--dash',
    'Upper',
    'has space',
    'dot.name',
  ]

  it.each(names.map((value, index) => [index, value] as const))(
    'answers the same for name %i',
    (_index, value) => {
      // Asked of the wire the detail door actually validates against, not of the
      // field schema in isolation: `label` is where a package's name crosses.
      const carried = AuthoredAttachmentSchema.safeParse({
        kind: 'exact',
        locator: { source: 'system', kind: 'skill', packageId: 'PkGdefGhij_2' },
        label: value,
      }).success

      expect(isSkillName(value)).toBe(carried)
    },
  )

  /** Both axes of "what the parser can produce", because the first pass fixed one and
   *  the docblock then claimed both. A token the parser reads and the wire refuses is a
   *  500 on the detail door for a package the host called valid — and narrowing the
   *  parser to match instead deletes the author's token on the next rebuild. */
  const carried = (raw: string): boolean =>
    AuthoredAttachmentSchema.safeParse({ kind: 'invalid', raw, reason: 'invalid-locator' }).success

  it('carries every token core recognises, at the longest core will recognise', () => {
    const longest = `[[${'a'.repeat(MAX_SKILL_TOKEN - 4)}]]`

    expect(longest).toHaveLength(MAX_SKILL_TOKEN)
    expect(carried(longest)).toBe(true)
  })

  it('measures that length in the unit core measures it in', () => {
    // Core's quantifier is a `/u` regex, so it counts CODE POINTS. Counted in UTF-16
    // units instead, this token is 2 052 long and the wire refused it while the parser
    // went on reading it.
    const emoji = `[[${'\u{1F600}'.repeat(MAX_SKILL_TOKEN - 4)}]]`

    expect([...emoji]).toHaveLength(MAX_SKILL_TOKEN)
    expect(emoji.length).toBeGreaterThan(MAX_SKILL_TOKEN)
    expect(parseSkillLinks(emoji)).toHaveLength(1)
    expect(carried(emoji)).toBe(true)
  })

  it('carries the characters the parser does not stop at', () => {
    // The parser stops at `]`, CR and LF and at nothing else; the durable-scalar family
    // bans C0/C1, U+0085, U+2028 and U+2029. Everything in that gap is a token read from
    // a hand-edited file and then refused on the way out.
    for (const gap of ['\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\u2028', '\u2029']) {
      const raw = `[[notarium-id:system:_55UeQqGnMrH|ev${gap}idence]]`

      expect(parseSkillLinks(raw), `parser reads ${JSON.stringify(gap)}`).toEqual([
        { kind: 'invalid', raw, reason: 'invalid-locator' },
      ])
      expect(carried(raw), `wire carries ${JSON.stringify(gap)}`).toBe(true)
    }
  })

  it('still refuses what the parser cannot produce', () => {
    expect(carried('not a token')).toBe(false)
    expect(carried(`[[${'a'.repeat(MAX_SKILL_TOKEN - 3)}]]`)).toBe(false)
    expect(carried('[[]]')).toBe(false)
  })
})
