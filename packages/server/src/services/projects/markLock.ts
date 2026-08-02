// Single-flight per `${space}\0${path}`: serializes all mark-family writes so
// concurrent marks of one folder can't mint distinct ids and collide on
// UNIQUE(space,path) — the second call observes the first's row idempotently.
// Keep exactly ONE Map (a second = a second lock slot, the race reopens); per-process
// only, so the upsert catch-reread is the cross-process backstop.
// canon: docs/projects.md#lifecycle
const markTails = new Map<string, Promise<unknown>>()

export const withMarkLock = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = markTails.get(key) ?? Promise.resolve()
  const result = prev.then(fn, fn)
  const tail = result.then(
    () => {},
    () => {},
  )
  markTails.set(key, tail)
  void tail.then(() => {
    if (markTails.get(key) === tail) {
      markTails.delete(key)
    }
  })
  return result
}
