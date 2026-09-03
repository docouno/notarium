import type { OwnedAbilityLocator } from '@notarium/contract'
import { serializeAbilityLocator } from '@notarium/core'

import {
  type AbilityPreferenceLocator,
  type AbilityPreferencesPersistence,
  type AbilityPreferenceTarget,
  abilitySpaceOfLocator,
  abilityTargetPurgedError,
  classifyOwnedRolePlacementMove,
  ownedRoleLocatorOfContextTarget,
  resolveLiveRoleContextTarget,
  type RoleContextTargetAddress,
  roleContextTargetOfLocator,
} from '../metaDb'

/** The row as the durable table keeps it: presence IS the disabled bit, and the two
 *  lifecycle keys beside it are what the Space purge and the exact note purge find it
 *  by. Everything else about the ability is already inside the locator that keys it. */
type PreferenceRow = { spaceId: string | null; registryNoteId: string | null; updatedAt: string }

/** The Space registry the durable `spaces` row stands for. The driver's fence begins
 *  with `SELECT 1 FROM spaces`, so a Space that never existed and a Space that was
 *  purged are one answer there; a Map has no such row, so a host that keeps one hands
 *  it over here. A host with no Space registry at all cannot be asked, and the twin
 *  degrades honestly (P5) — the same shape `AbilityAvailabilityRegistry` uses. */
export type AbilityPreferencesRegistry = {
  spaceExists(spaceId: string): Promise<boolean>
  /** …and the SECOND half of that fence, which the row alone cannot answer: has this
   *  Space entered a phase it never comes back from? `purge-intent` is the one such
   *  phase whose `spaces` row is still there — `spaceManager` writes it in its own
   *  transaction and then refuses to sweep while a restore has the Space pinned — so a
   *  twin that asks only `spaceExists` accepts an override the drivers refuse, for as
   *  long as that lasts.
   *
   *  REQUIRED, and that is the whole point: one fence, two halves. The optional
   *  spelling let a host hand over the first half and keep the second, which is exactly
   *  what the fake server did — it owned the journal and passed `spaceExists` alone, so
   *  the browser half stayed laxer than the server for a whole review round with the
   *  contract green. P5 degradation is expressed by handing over NO registry (a host
   *  that has neither), never by handing over half of one. `metaDb`'s
   *  `spaceLifecycleHasEnded` is the answer any host with a journal owes here. */
  spaceEnded(spaceId: string): Promise<boolean>
}

/** Non-durable adapter for tests and explicitly meta-DB-less hosts.
 *
 *  The purge fence is part of the behaviour, not a durability detail: an override
 *  whose registry note is gone for good must not be recreated, and a host that lets
 *  `setEnabled` succeed there can never exercise the refusal its callers handle. The
 *  journal belongs to the host, so the host announces the purge and this twin both
 *  forgets the overrides and closes the fence — the two halves the driver does in one
 *  transaction. */
export class InMemoryAbilityPreferences implements AbilityPreferencesPersistence {
  private readonly records = new Map<string, PreferenceRow>()
  private readonly purgedNotes = new Set<string>()
  private readonly purgedSpaces = new Set<string>()
  /** The durable `ability_placement_trail`, as a Map: which address a package
   *  moved AWAY from, and the one it stands at now. Both drivers keep the same table
   *  for the same reason — carrying the rows is only half of an address change, and
   *  the other half is that a caller whose address is one statement older writes its
   *  choice where the package IS. One hop deep, kept so by `moveLocator`. */
  private readonly moved = new Map<
    string,
    {
      to: string
      spaceId: string | null
      registryNoteId: string
      manifestNoteId: string
    }
  >()

  constructor(private readonly registry?: AbilityPreferencesRegistry) {}

  private key(owner: string, locator: AbilityPreferenceLocator): string {
    return `${owner}\0${this.live(serializeAbilityLocator(locator))}`
  }

  /** The address that locator stands at now. */
  private live(locator: string): string {
    return this.movedLocator(locator) ?? locator
  }

  /** The read-side of the placement trail. Returning null for an unrecorded address
   *  is intentional: current inventory cannot prove that two equal package ids are
   *  the same package. */
  movedLocator(locator: string): string | null {
    return this.moved.get(locator)?.to ?? null
  }

  movedPlacement(locator: string): {
    toLocator: string
    registryNoteId: string
    manifestNoteId: string
  } | null {
    const hop = this.moved.get(locator)

    return hop
      ? {
          toLocator: hop.to,
          registryNoteId: hop.registryNoteId,
          manifestNoteId: hop.manifestNoteId,
        }
      : null
  }

  liveRoleTarget(target: RoleContextTargetAddress): RoleContextTargetAddress {
    const locator = ownedRoleLocatorOfContextTarget(target)

    if (!locator) {
      throw new Error('invalid Owned Role context target projection')
    }

    return resolveLiveRoleContextTarget(
      target,
      this.movedPlacement(serializeAbilityLocator(locator)),
    ).target
  }

  liveRoleLocator(
    locator: Extract<OwnedAbilityLocator, { kind: 'role' }>,
  ): Extract<OwnedAbilityLocator, { kind: 'role' }> {
    const target = roleContextTargetOfLocator(locator)

    return resolveLiveRoleContextTarget(
      target,
      this.movedPlacement(serializeAbilityLocator(locator)),
    ).locator
  }

  private noteKey(spaceId: string, registryNoteId: string): string {
    return `${spaceId}\0${registryNoteId}`
  }

  async isEnabled(owner: string, locator: AbilityPreferenceLocator): Promise<boolean> {
    return !this.records.has(this.key(owner, locator))
  }

  async disabled(
    owner: string,
    locators: readonly AbilityPreferenceLocator[],
  ): Promise<Set<string>> {
    // Answered in the CALLER's spelling, like both drivers: it asked about the
    // addresses it holds, and a set keyed by anything else is one it cannot look
    // anything up in.
    return new Set(
      locators
        .map(serializeAbilityLocator)
        .filter((locator) => this.records.has(`${owner}\0${this.live(locator)}`)),
    )
  }

  async setEnabled(
    owner: string,
    target: AbilityPreferenceTarget,
    enabled: boolean,
    updatedAt: string,
  ): Promise<void> {
    const spaceId = target.locator.source === 'owned' ? target.locator.location.spaceId : null
    const registryNoteId =
      target.locator.source === 'owned' && 'registryNoteId' in target ? target.registryNoteId : null

    // The whole fence is asked FIRST on purpose: the drivers decide and write in one
    // transaction, so nothing may suspend between the fence and the row. A purge that
    // lands during these awaits is still refused below — the host announces it into
    // `purgedSpaces`, which is read on the synchronous side.
    const homeLives = spaceId == null || (await this.homeLives(spaceId))

    // The fence is asked BEFORE the branch, exactly where the drivers ask it — they
    // check the lifecycle once and then choose DELETE or UPSERT. Answering "done" to
    // a re-enable of an ability that is gone for good tells the caller the ability is
    // back; there is nothing to turn on, and the route needs the refusal to answer
    // 404 rather than 200.
    if (
      spaceId != null &&
      (!homeLives ||
        this.purgedSpaces.has(spaceId) ||
        (registryNoteId != null && this.purgedNotes.has(this.noteKey(spaceId, registryNoteId))))
    ) {
      throw abilityTargetPurgedError('ability preference target was permanently purged')
    }
    // The address is resolved HERE and not above the awaits, which is where the
    // drivers resolve it: inside the transaction, under the lock. A placement move
    // that commits while this call is suspended is exactly the case the trail exists
    // for, and a key computed before the fence would still name the address the
    // package has left — the choice would land where nothing reads it.
    const key = this.key(owner, target.locator)

    if (enabled) {
      this.records.delete(key)
      return
    }
    this.records.set(key, { spaceId, registryNoteId, updatedAt })
  }

  /** Both clauses the drivers' one statement asks about the Space: the row is there
   *  AND the lifecycle has not ended. Split across two questions here only because a
   *  Map is not a join. */
  private async homeLives(spaceId: string): Promise<boolean> {
    if (!this.registry) {
      return true
    }

    return (await this.registry.spaceExists(spaceId)) && !(await this.registry.spaceEnded(spaceId))
  }

  /** Follow a package that changed placement, for every owner at once — the drivers
   *  rewrite the COLUMN, not one caller's row, and the move carries no owner, so no
   *  caller-facing method can express it. The lifecycle keys are untouched: a
   *  promotion stays inside one Space and keeps the same registry note. The
   *  destination is cleared first for the same reason the drivers clear it — it
   *  belongs to the package being moved either way. */
  moveLocator(
    fromLocator: string,
    toLocator: string,
    registryNoteId: string,
    manifestNoteId: string,
    trail: 'record' | 'cancel',
  ): 'applied' | 'replayed' {
    const classification = classifyOwnedRolePlacementMove({
      fromLocator,
      toLocator,
      registryNoteId,
      manifestNoteId,
      trail,
      fromTrail: this.movedPlacement(fromLocator),
      toTrail: this.movedPlacement(toLocator),
    })

    if (classification === 'replay') {
      return 'replayed'
    }
    const carried: Array<[string, PreferenceRow]> = []

    for (const [key, row] of [...this.records]) {
      const separator = key.indexOf('\0')
      const owner = key.slice(0, separator)
      const locator = key.slice(separator + 1)

      if (locator === toLocator || locator === fromLocator) {
        this.records.delete(key)
      }
      if (locator === fromLocator) {
        carried.push([`${owner}\0${toLocator}`, row])
      }
    }
    for (const [key, row] of carried) {
      this.records.set(key, row)
    }
    // …and the hop itself, in the three steps both drivers take in this order: the
    // destination stops forwarding (it is occupied now, and what pointed out of it
    // belongs to the placement this package just undid), whatever pointed AT the
    // source now points at the destination (so the trail stays one hop deep), and the
    // source starts forwarding. Without it, an owner who switches this role off
    // holding the pre-move address writes at an address nothing reads.
    //
    // A `cancel` takes the first two steps and not the third, for the reason spelled
    // out on `OwnedRolePlacementMove.trail`: it is walking the package back along a hop
    // its caller recorded, so the destination delete removes that hop and both
    // spellings end up forwarding nowhere. A counter-hop would need a later step to
    // clear it, and a trail row tombstones its own address whether or not the
    // destination holds anything.
    this.moved.delete(toLocator)
    for (const [from, hop] of this.moved) {
      if (hop.to === fromLocator) {
        this.moved.set(from, { ...hop, to: toLocator, registryNoteId, manifestNoteId })
      }
    }
    if (trail === 'record') {
      this.moved.set(fromLocator, {
        to: toLocator,
        spaceId: abilitySpaceOfLocator(fromLocator),
        registryNoteId,
        manifestNoteId,
      })
    }

    return 'applied'
  }

  /** One or more registry notes are gone for good in this Space. */
  notePurged(spaceId: string, registryNoteIds: readonly string[]): void {
    for (const registryNoteId of registryNoteIds) {
      this.purgedNotes.add(this.noteKey(spaceId, registryNoteId))
      for (const [key, row] of this.records) {
        if (row.spaceId === spaceId && row.registryNoteId === registryNoteId) {
          this.records.delete(key)
        }
      }
    }
  }

  /** The whole Space is gone for good, overrides of every package in it included. */
  spacePurged(spaceId: string): void {
    this.purgedSpaces.add(spaceId)
    for (const [key, row] of this.records) {
      if (row.spaceId === spaceId) {
        this.records.delete(key)
      }
    }
    // The forwarding rows of this Space go with the overrides they forward — the
    // `DELETE FROM ability_placement_trail WHERE space_id = ?` both drivers run.
    for (const [from, hop] of this.moved) {
      if (hop.spaceId === spaceId) {
        this.moved.delete(from)
      }
    }
  }

  clear(): void {
    this.records.clear()
    this.purgedNotes.clear()
    this.purgedSpaces.clear()
    this.moved.clear()
  }
}
