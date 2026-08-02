// Turning a thrown error into a line for the UI, in one place (#28). Widgets used
// to each do `reasons[e.reason] || e.message` — which leaks whatever the server
// put in `message`, including a raw zod-issue dump on a validation 400. This
// resolves, in order: a caller's reason→copy dictionary, then the server's own
// human message — but never a machine dump (a JSON-looking or empty message
// falls back to a generic line), so nothing illegible can reach the user.

export type ErrorReasonMap = Record<string, string>

const GENERIC = 'Something went wrong. Please try again.'

export const errorText = (e: unknown, reasons: ErrorReasonMap = {}): string => {
  const reason = (e as { reason?: string })?.reason

  if (reason && reasons[reason]) {
    return reasons[reason]
  }

  const message = (e as { message?: unknown })?.message

  if (typeof message !== 'string') {
    return GENERIC
  }
  const trimmed = message.trim()

  // Empty, or a serialized payload that escaped mapping (e.g. zod issues JSON) —
  // not something to show a person.
  if (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return GENERIC
  }

  return trimmed
}
