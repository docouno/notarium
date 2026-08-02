// Domain constants for the agent-memory semantic ops.

/** The agent-mount's SPACE-relative location (convention; the server's
 *  defaultMounts mirrors this — AGENT_MOUNT_PREFIX aliases it so the engine's
 *  mount layout and the memory ops' subdir math can never drift apart). Memory
 *  notes live under it; the find/index ops strip it off NoteMeta.filePath to
 *  recover the mount-relative dir. */
export const AGENT_MEMORY_MOUNT = '.notarium/memory'
