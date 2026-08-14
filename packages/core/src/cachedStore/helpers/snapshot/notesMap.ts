import type { NoteMeta } from '../../../knowledgeStore'
import { VersionedMap } from './versionedMap'

const NO_IDS: readonly string[] = []

/** The snapshot's notes: metas by note-id, plus the two derived facts the write
 *  path would otherwise recompute by walking the whole map on EVERY write —
 *  "which note lives at this storage path" and "could the resolve table have gone
 *  stale in a way that makes it LIE".
 *
 *  Both live inside the Map for the reason its version counter does: a rule that
 *  says "remember to update the path index here" is a rule someone eventually
 *  forgets, and the forgotten one is only visible as a write landing on top of a
 *  note the snapshot still holds. */
export class NotesMap extends VersionedMap<string, NoteMeta> {
  /** Changes after which a batch table may name an id it cannot safely hand out: a
   *  delete, a clear, or (conservatively) any class change. The important direction
   *  is a note LEAVING the user graph — the stale answer would expose a hidden id —
   *  but rebuilding for the inverse/hidden-to-hidden cases keeps the counter local
   *  to this map instead of importing visibility policy into it. A first insert and
   *  a rename move neither counter; their stale LIVE answers are repaired once at
   *  the bracket's close. */
  retractions = 0

  private readonly idsByPath = new Map<string, string[]>()

  set(id: string, meta: NoteMeta): this {
    const prior = this.get(id)

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

    return super.set(id, meta)
  }

  delete(id: string): boolean {
    const prior = this.get(id)

    if (prior) {
      this.retractions++
      this.unbind(prior.filePath, id)
    }

    return super.delete(id)
  }

  clear(): void {
    if (this.size) {
      this.retractions++
    }
    this.idsByPath.clear()
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
}
