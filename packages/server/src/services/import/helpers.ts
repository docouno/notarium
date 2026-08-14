// Small shared pieces of the import module — one spelling for each, so the
// planner and the writer can never disagree about where a note lands.

/** Join a destination root with a space-relative directory. Either side may be
 *  empty (the space root, or a note that sits directly in the root), and the
 *  result must never grow a trailing or leading separator: an `x/` directory is
 *  a different storage key from `x`. */
export const underRoot = (root: string, directory: string): string =>
  root && directory ? `${root}/${directory}` : root || directory
