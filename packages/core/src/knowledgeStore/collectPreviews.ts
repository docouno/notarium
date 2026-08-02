// The shared `previews()` loop: resolve a batch one preview at a time, bailing
// between items once the caller's signal aborts. Sequential on purpose — the
// batch endpoint exists to cut request fan-out and to make cancellation
// meaningful, not to parallelise an engine that serializes reads anyway (an
// engine that doesn't can override previews() with its own fan-out).

import type { Preview, ReadOptions } from './knowledgeStore'

export const collectPreviews = async (
  ids: readonly string[],
  opts: ReadOptions | undefined,
  previewOf: (id: string, opts?: ReadOptions) => Promise<Preview>,
): Promise<Record<string, Preview>> => {
  const out: Record<string, Preview> = {}

  for (const id of ids) {
    if (opts?.signal?.aborted) {
      break
    }
    try {
      out[id] = await previewOf(id, opts)
    } catch {
      // One unresolvable id must not sink the rest of the batch — absence is
      // the contract's way of saying "couldn't".
    }
  }

  return out
}
