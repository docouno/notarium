import { ABILITY_AVAILABILITY_MODE } from '@notarium/contract'

import {
  type AbilityAvailability,
  type AbilityAvailabilityPersistence,
  type AbilityAvailabilityRecord,
  type AbilityAvailabilityRegistryNote,
  abilityTargetPurgedError,
} from '../metaDb'

/** The registry the durable schema's foreign keys point AT. `spaces`, `projects` and
 *  `folders` are meta-DB facets, so a host without a meta-DB has no project registry
 *  at all and the policy is simply stored as given; a host that keeps one in memory
 *  hands it over here and gets the answers the SQL cascades give. */
export type AbilityAvailabilityRegistry = {
  /** The Space a project belongs to, or null when no `type='project'` row holds that
   *  id — the row the binding foreign key follows. */
  projectHomeSpace(projectId: string): Promise<string | null>
  /** Whether the home Space row is still there. A purged Space takes the policy with
   *  it through `ON DELETE CASCADE`. */
  spaceExists(spaceId: string): Promise<boolean>
  /** Whether that Space has entered a phase it never comes back from. A second
   *  question because the row alone cannot answer it: `purge-intent` is the one ended
   *  phase whose `spaces` row is still there, and a fence of `SELECT 1 FROM spaces`
   *  alone — which is how availability shipped — calls such a Space live. Asked by
   *  WRITES only: the rows themselves are still in the table until the sweep runs, so a
   *  read that hid them would answer differently from both drivers.
   *
   *  REQUIRED for the same reason the preference twin's is: a registry is the WHOLE
   *  fence or it is absent. A host with no lifecycle journal hands over no registry at
   *  all (P5); one that hands over `spaceExists` alone is not degraded, it is wrong —
   *  and it was wrong in the fake server, which owns the journal, for a whole round. */
  spaceEnded(spaceId: string): Promise<boolean>
}

/** Non-durable adapter for tests and explicitly meta-DB-less hosts.
 *
 *  A Map has no triggers, so the cascades are reconciled at READ instead: a binding
 *  and a policy are observable only through `get`/`listForSpace`, which makes the
 *  read filter and the durable `ON DELETE CASCADE` the same answer. */
export class InMemoryAbilityAvailability implements AbilityAvailabilityPersistence {
  private readonly records = new Map<string, AbilityAvailabilityRecord>()
  /** The second key, beside the record and never inside it: the registry note whose
   *  permanent purge ends the policy. Kept apart because it is not part of what a
   *  reader asks for — the durable column is the same shape. */
  private readonly registryNotes = new Map<string, string>()
  /** The notes this host has announced as purged for good. Sweeping the record is only
   *  half of a lifecycle END — without the fence the next `set` puts it back, keyed by
   *  a package DIRECTORY the next package installed there inherits, and nothing sweeps
   *  it a second time. The preference twin next door keeps the same set for the same
   *  reason; both drivers read it out of `revision_purge_fences`. */
  private readonly purgedNotes = new Set<string>()

  constructor(private readonly registry?: AbilityAvailabilityRegistry) {}

  private key(homeSpace: string, packageId: string): string {
    return `${homeSpace}\0${packageId}`
  }

  private noteKey(homeSpace: string, registryNoteId: string): string {
    return `${homeSpace}\0${registryNoteId}`
  }

  private async assertProjects(homeSpace: string, projectIds: readonly string[]): Promise<void> {
    if (!this.registry) {
      return
    }
    for (const projectId of projectIds) {
      if ((await this.registry.projectHomeSpace(projectId)) !== homeSpace) {
        throw abilityTargetPurgedError(
          `project ${projectId} does not belong to ability home space ${homeSpace}`,
        )
      }
    }
  }

  /** The record as the cascades leave it: bindings whose project stopped being a
   *  project of this Space are gone, exactly as the trigger and the FK leave them. */
  private async live(record: AbilityAvailabilityRecord): Promise<AbilityAvailabilityRecord> {
    if (record.mode === ABILITY_AVAILABILITY_MODE.allProjects) {
      return { ...record }
    }
    if (!this.registry) {
      return { ...record, projectIds: [...record.projectIds] }
    }
    const homes = await Promise.all(
      record.projectIds.map((projectId) => this.registry!.projectHomeSpace(projectId)),
    )

    return {
      ...record,
      projectIds: record.projectIds.filter((_, index) => homes[index] === record.homeSpace),
    }
  }

  private async homeLives(homeSpace: string): Promise<boolean> {
    return this.registry ? this.registry.spaceExists(homeSpace) : true
  }

  async get(homeSpace: string, packageId: string): Promise<AbilityAvailabilityRecord | null> {
    const record = this.records.get(this.key(homeSpace, packageId))

    if (!record || !(await this.homeLives(homeSpace))) {
      return null
    }

    return this.live(record)
  }

  async listForSpace(homeSpace: string): Promise<AbilityAvailabilityRecord[]> {
    if (!(await this.homeLives(homeSpace))) {
      return []
    }

    return Promise.all(
      [...this.records.values()]
        .filter((record) => record.homeSpace === homeSpace)
        .map((record) => this.live(record)),
    )
  }

  async reserve(
    homeSpace: string,
    packageId: string,
    availability: AbilityAvailability,
  ): Promise<boolean> {
    const projectIds =
      availability.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
        ? [...new Set(availability.projectIds)].sort()
        : []

    await this.assertHome(homeSpace)
    await this.assertProjects(homeSpace, projectIds)
    const key = this.key(homeSpace, packageId)

    if (this.records.has(key)) {
      return false
    }
    this.records.set(
      key,
      availability.mode === ABILITY_AVAILABILITY_MODE.allProjects
        ? { homeSpace, packageId, mode: ABILITY_AVAILABILITY_MODE.allProjects }
        : {
            homeSpace,
            packageId,
            mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
            projectIds,
          },
    )
    return true
  }

  async finalize(homeSpace: string, packageId: string, actualNoteId: string): Promise<boolean> {
    const key = this.key(homeSpace, packageId)

    if (!this.records.has(key) || this.registryNotes.has(key)) {
      return false
    }
    this.assertRegistryNote(homeSpace, actualNoteId)
    this.registryNotes.set(key, actualNoteId)
    return true
  }

  async cancel(homeSpace: string, packageId: string): Promise<boolean> {
    const key = this.key(homeSpace, packageId)

    if (!this.records.has(key) || this.registryNotes.has(key)) {
      return false
    }
    this.records.delete(key)
    return true
  }

  /** The durable `home_space` FOREIGN KEY, asked where a Map has no key to enforce.
   *  A policy whose home Space is gone (or was never there) cannot be stored: the
   *  drivers refuse it, and a twin that saves it lets a caller believe a purged Space
   *  still has abilities.
   *
   *  The lifecycle phase is asked HERE and not in `homeLives`, because the two are not
   *  the same question. `homeLives` answers the reads, which see whatever the sweep has
   *  not removed yet; this answers the writes, which are the drivers' one fenced
   *  statement — and a Space in `purge-intent` still has every row it ever had. */
  private async assertHome(homeSpace: string): Promise<void> {
    if (!(await this.homeLives(homeSpace)) || (await this.registry?.spaceEnded(homeSpace))) {
      throw abilityTargetPurgedError(`ability home space ${homeSpace} no longer exists`)
    }
  }

  /** The other end of the lifecycle, asked of the key that OWNS it. A caller with no
   *  registry note cannot be fenced by one — the same asymmetry the sweep makes. */
  private assertRegistryNote(
    homeSpace: string,
    registryNoteId?: AbilityAvailabilityRegistryNote,
  ): void {
    if (registryNoteId != null && this.purgedNotes.has(this.noteKey(homeSpace, registryNoteId))) {
      throw abilityTargetPurgedError(
        `ability target ${registryNoteId} in space ${homeSpace} is gone for good`,
      )
    }
  }

  async set(
    homeSpace: string,
    packageId: string,
    availability: AbilityAvailability,
    registryNoteId?: AbilityAvailabilityRegistryNote,
  ): Promise<void> {
    const projectIds =
      availability.mode === ABILITY_AVAILABILITY_MODE.selectedProjects
        ? [...new Set(availability.projectIds)].sort()
        : []

    await this.assertHome(homeSpace)
    this.assertRegistryNote(homeSpace, registryNoteId)
    await this.assertProjects(homeSpace, projectIds)
    // Learned, never forgotten — the same `COALESCE` the drivers upsert with.
    if (registryNoteId != null) {
      this.registryNotes.set(this.key(homeSpace, packageId), registryNoteId)
    }
    this.records.set(this.key(homeSpace, packageId), {
      homeSpace,
      packageId,
      ...(availability.mode === ABILITY_AVAILABILITY_MODE.allProjects
        ? { mode: ABILITY_AVAILABILITY_MODE.allProjects }
        : { mode: ABILITY_AVAILABILITY_MODE.selectedProjects, projectIds }),
    })
  }

  async grantProject(
    homeSpace: string,
    packageId: string,
    projectId: string,
    registryNoteId?: AbilityAvailabilityRegistryNote,
  ): Promise<void> {
    await this.assertHome(homeSpace)
    this.assertRegistryNote(homeSpace, registryNoteId)
    await this.assertProjects(homeSpace, [projectId])
    const current = await this.get(homeSpace, packageId)

    if (current?.mode === ABILITY_AVAILABILITY_MODE.allProjects) {
      return
    }
    await this.set(
      homeSpace,
      packageId,
      {
        mode: ABILITY_AVAILABILITY_MODE.selectedProjects,
        projectIds: [...(current?.projectIds ?? []), projectId],
      },
      registryNoteId,
    )
  }

  async clear(homeSpace: string, packageId: string): Promise<void> {
    this.records.delete(this.key(homeSpace, packageId))
    this.registryNotes.delete(this.key(homeSpace, packageId))
  }

  /** The permanent purge of a package's registry note, announced by the host that
   *  owns the revision journal. The policy is keyed by the package DIRECTORY, so the
   *  note is a SECOND key: the directory is named by the id its manifest declared, and
   *  claim arbitration can leave the note carrying a different one. A row that never
   *  learned its note id keeps the pre-arbitration answer — and only such a row, or a
   *  live policy would be forgotten because some unrelated purged note happens to be
   *  named like its directory. Exactly what the durable sweep writes. */
  notePurged(homeSpace: string, registryNoteIds: readonly string[]): void {
    const purged = new Set(registryNoteIds)

    for (const registryNoteId of registryNoteIds) {
      this.purgedNotes.add(this.noteKey(homeSpace, registryNoteId))
    }
    for (const [key, record] of [...this.records]) {
      if (record.homeSpace !== homeSpace) {
        continue
      }
      const registryNoteId = this.registryNotes.get(key)

      if (registryNoteId == null ? purged.has(record.packageId) : purged.has(registryNoteId)) {
        this.records.delete(key)
        this.registryNotes.delete(key)
      }
    }
  }

  clearAll(): void {
    this.records.clear()
    this.registryNotes.clear()
    this.purgedNotes.clear()
  }
}
