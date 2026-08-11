// Domain constants for the agent-memory semantic ops.
// canon: docs/note-model.md#agent-memory

/** The agent-mount's SPACE-relative location (convention; the server's
 *  defaultMounts mirrors this — AGENT_MOUNT_PREFIX aliases it so the engine's
 *  mount layout and the memory ops' subdir math can never drift apart). Memory
 *  notes live under it; the find/index ops strip it off NoteMeta.filePath to
 *  recover the mount-relative dir. */
export const AGENT_MEMORY_MOUNT = '.notarium/memory'

/** Lost create races to retry before returning the original collision. */
export const CREATE_RACE_BUDGET = 2

/** Retry budget when a refused CAS reports no live-token progress. */
export const NO_PROGRESS_BUDGET = 2

/** Retry budget when each refused CAS reports a newer live token. */
export const EXTERNAL_CONFLICT_BUDGET = 8
