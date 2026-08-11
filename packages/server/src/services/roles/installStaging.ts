import { isAtomicInstallTempPath } from '@notarium/core'

/** Is this entry a staging directory the role library may reclaim? `path` is
 *  mount-relative — the base used by export and backup, and the only one that
 *  reaches the `_projects/<encoded-id>` branch of the positional predicate. */
export const isReclaimableInstallStaging = (path: string, directory: boolean): boolean =>
  directory && isAtomicInstallTempPath(path)
