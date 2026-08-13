// The two markers a closed atomic-no-replace gate prints, shared by every suite
// that sits behind one. `test/skipSummary.ts` folds skips by the exact text, so
// one reworded copy splits a single environment into two groups in the summary
// and reads as two independent broken preconditions.
// canon: docs/dev-environment.md#invariants

/** A permanent property of the machine: no command makes this kernel grow the
 *  syscall. */
export const ATOMIC_NO_REPLACE_PLATFORM_GATE =
  '[gate: atomic no-replace (no renameat2 on this platform)]'

/** A property of THIS environment — no interpreter, or a filesystem or kernel
 *  that refuses the call. Installing `perl-base` can change it. */
export const ATOMIC_NO_REPLACE_RUNTIME_GATE =
  '[gate: atomic no-replace (primitive unavailable on this runtime)]'
