import type { FileStore } from './types'

/** Which of these directory pathnames exist under EXACTLY the given spelling.
 *
 *  The bridge between a single-pathname PRIMITIVE and a multi-pathname QUESTION.
 *  A filesystem naturally answers one spelling at a time, so `dirExistsExact`
 *  stays singular on the adapter; the caller's real question is about every
 *  prefix of one path at once, so the batching — and the fallback for an adapter
 *  without the accelerator — lives here rather than as a branch at the call site.
 *
 *  The batch is also what keeps the fallback affordable: answering one prefix at
 *  a time without `dirExistsExact` would cost a recursive walk PER path
 *  component, so the slow path would get worse the deeper the destination. One
 *  walk answers the whole set.
 *
 *  canon: docs/core.md#cooperative */
export const exactDirSpellings = async (
  files: FileStore,
  prefixes: readonly string[],
): Promise<Set<string>> => {
  // An empty question costs nothing. The common write asks about no prefix at
  // all (every component portable), and the fallback below would otherwise walk
  // the whole mount to answer it.
  if (!prefixes.length) {
    return new Set()
  }
  const exact = files.dirExistsExact

  if (!exact) {
    const all = new Set(await files.listDirs())

    return new Set(prefixes.filter((prefix) => all.has(prefix)))
  }
  const present = new Set<string>()

  for (const prefix of prefixes) {
    if (await exact.call(files, prefix)) {
      present.add(prefix)
    }
  }

  return present
}
