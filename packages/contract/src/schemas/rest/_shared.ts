import { z } from 'zod'

/** Generic success envelope: `{ ok: true }` — the response of every mutation whose
 *  only signal is "it worked" (~15 ops across auth/spaces/folders/pats/context).
 *  Mutations that add a field `.extend()` this rather than re-declaring `ok`. */
export const OkResponseSchema = z.object({ ok: z.literal(true) })

/** Error envelope. Every handler returns `{ error }` with a non-2xx status; the
 *  notable case is a move that the engine reports as guidance text — the server
 *  turns it into a real 400 with this shape (the "Move Failed" detection).
 *  A 503 additionally carries a machine-readable `reason` (engine_unreachable /
 *  engine_timeout) so the UI can tell "knowledge engine down" from a bug. */
export const ErrorResponseSchema = z.object({ error: z.string(), reason: z.string().optional() })

export type OkResponse = z.infer<typeof OkResponseSchema>
