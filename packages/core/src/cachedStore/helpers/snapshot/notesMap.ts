import type { NoteMeta } from '../../../knowledgeStore'
import { VersionedMap } from './versionedMap'

const NO_IDS: readonly string[] = []

const sameStrings = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean => {
  const leftLength = left?.length ?? 0
  const rightLength = right?.length ?? 0

  return (
    leftLength === rightLength &&
    (leftLength === 0 || left!.every((value, index) => value === right![index]))
  )
}

/** Fields consumed by `buildLinkIndex`. Everything else (timestamps, tags,
 *  source locator) may change without changing a single resolve answer. */
const sameResolveInput = (left: NoteMeta, right: NoteMeta): boolean =>
  left.id === right.id &&
  left.title === right.title &&
  left.class === right.class &&
  left.filePath === right.filePath &&
  left.slug === right.slug &&
  sameStrings(left.aliases, right.aliases) &&
  sameStrings(left.legacyNameAliases, right.legacyNameAliases)

/** The snapshot's notes: metas by note-id, plus the derived facts the write
 *  path would otherwise recompute by walking the whole map on EVERY write —
 *  "which note lives at this storage path", "which notes claim an import source",
 *  and "could the resolve table have gone stale in a way that makes it LIE".
 *
 *  Both live inside the Map for the reason its version counter does: a rule that
 *  says "remember to update the path index here" is a rule someone eventually
 *  forgets, and the forgotten one is only visible as a write landing on top of a
 *  note the snapshot still holds. */
export class NotesMap extends VersionedMap<string, NoteMeta> {
  /** Exact invalidation signal for the wikilink resolve table. `version` is total
   *  over every snapshot write; this narrower counter moves only when an input to
   *  `buildLinkIndex` moves, so a body/timestamp write followed by a note read does
   *  not pay an O(corpus) rebuild. */
  resolveVersion = 0
  /** Changes after which a batch table may name an id it cannot safely hand out: a
   *  delete, a clear, or (conservatively) any class change. The important direction
   *  is a note LEAVING the user graph — the stale answer would expose a hidden id —
   *  but rebuilding for the inverse/hidden-to-hidden cases keeps the counter local
   *  to this map instead of importing visibility policy into it. A first insert and
   *  a rename move neither counter; their stale LIVE answers are repaired once at
   *  the bracket's close. */
  retractions = 0
  /** Current Activity membership changes only when a note appears, disappears,
   * changes class, or moves. Body/timestamp writes leave this cut stable. */
  locationVersion = 0

  private readonly idsByPath = new Map<string, string[]>()
  private readonly idsBySourceLocator = new Map<string, string[]>()

  set(id: string, meta: NoteMeta): this {
    const prior = this.get(id)

    if (!prior || prior.filePath !== meta.filePath || prior.class !== meta.class) {
      this.locationVersion++
    }

    if (!prior || !sameResolveInput(prior, meta)) {
      this.resolveVersion++
    }
    if (prior && prior.class !== meta.class) {
      this.retractions++
    }
    if (prior?.filePath !== meta.filePath) {
      if (prior) {
        this.unbind(prior.filePath, id)
      }
      const bucket = this.idsByPath.get(meta.filePath)

      if (bucket) {
        bucket.push(id)
      } else {
        this.idsByPath.set(meta.filePath, [id])
      }
    }
    if (prior?.sourceLocator !== meta.sourceLocator) {
      if (prior?.sourceLocator) {
        this.unbindSourceLocator(prior.sourceLocator, id)
      }
      if (meta.sourceLocator) {
        const bucket = this.idsBySourceLocator.get(meta.sourceLocator)

        if (bucket) {
          bucket.push(id)
        } else {
          this.idsBySourceLocator.set(meta.sourceLocator, [id])
        }
      }
    }

    return super.set(id, meta)
  }

  delete(id: string): boolean {
    const prior = this.get(id)

    if (prior) {
      this.locationVersion++
      this.resolveVersion++
      this.retractions++
      this.unbind(prior.filePath, id)
      if (prior.sourceLocator) {
        this.unbindSourceLocator(prior.sourceLocator, id)
      }
    }

    return super.delete(id)
  }

  clear(): void {
    if (this.size) {
      this.locationVersion++
      this.resolveVersion++
      this.retractions++
    }
    this.idsByPath.clear()
    this.idsBySourceLocator.clear()
    super.clear()
  }

  /** The ids the snapshot holds at a storage path, in the order they BOUND to it
   *  (a re-bind after a move goes to the back, since that is when it arrived here).
   *  Normally none or one: two ids share a path only while a delta or a displacing
   *  write is mid-flight. Deliberately NOT the map's own iteration order — an id
   *  that moved onto this path keeps its original slot in the map while taking the
   *  last slot here — so callers that need "who is standing here" ask this, and
   *  callers that need map order walk the map. */
  idsAt(filePath: string): readonly string[] {
    return this.idsByPath.get(filePath) ?? NO_IDS
  }

  /** The ids carrying one canonical source locator. Normally none or one;
   * multiple ids are the ambiguous-owner state the importer refuses. */
  idsWithSourceLocator(locator: string): readonly string[] {
    return this.idsBySourceLocator.get(locator) ?? NO_IDS
  }

  private unbind(filePath: string, id: string): void {
    const bucket = this.idsByPath.get(filePath)

    if (!bucket) {
      return
    }
    const at = bucket.indexOf(id)

    if (at !== -1) {
      bucket.splice(at, 1)
    }
    if (!bucket.length) {
      this.idsByPath.delete(filePath)
    }
  }

  private unbindSourceLocator(locator: string, id: string): void {
    const bucket = this.idsBySourceLocator.get(locator)

    if (!bucket) {
      return
    }
    const at = bucket.indexOf(id)

    if (at !== -1) {
      bucket.splice(at, 1)
    }
    if (!bucket.length) {
      this.idsBySourceLocator.delete(locator)
    }
  }
}
