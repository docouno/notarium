/** A Map that counts its own changes — the invalidation signal for state derived
 *  from the snapshot's note set. The resolve table is rebuilt only when that set
 *  really moved.
 *
 *  The alternative does not survive contact with a codebase: a hand-placed
 *  `invalidate()` at every site that mutates this map is a rule someone
 *  eventually forgets, and a forgotten one leaves a stale table that silently
 *  mis-resolves links. Counting inside the Map makes staleness structurally
 *  impossible instead of merely discouraged. */
export class VersionedMap<K, V> extends Map<K, V> {
  version = 0

  set(key: K, value: V): this {
    this.version++

    return super.set(key, value)
  }

  delete(key: K): boolean {
    this.version++

    return super.delete(key)
  }

  clear(): void {
    this.version++
    super.clear()
  }
}
