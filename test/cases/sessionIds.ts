import { createHash } from 'node:crypto'

/** Stable URL-safe session id shared by the real and fake seed projections. */
export const agentSessionId = (ref: string): string =>
  `ses_${createHash('sha256').update(ref).digest('base64url').slice(0, 12)}`

/** Stable transport-neutral call id shared by both seed projections. */
export const agentCallId = (ref: string): string =>
  `call_${createHash('sha256').update(ref).digest('base64url').slice(0, 12)}`
