export const AGENT_SESSION_IDLE_MS = 2 * 60 * 60 * 1000

/** Default Compact episode window. Durable telemetry config owns pruning; this
 * bound keeps explicit resume aligned with the default before maintenance runs. */
export const AGENT_SESSION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

export const AGENT_SESSION_RECENT_LIMIT = 10
