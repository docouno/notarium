export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  PARTIAL_CONTENT: 206,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RANGE_NOT_SATISFIABLE: 416,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const

export type HttpStatus = (typeof HTTP_STATUS)[keyof typeof HTTP_STATUS]

/** Server-observed request interval used by the production-shaped liveness proof.
 * It begins in `onRequest`, before body parsing and pre-handler authorization, and
 * ends in `onSend` after response serialization. Values share the server process's
 * monotonic performance time origin. */
export const REQUEST_TIMING_HEADER = {
  STARTED_AT: 'x-notarium-handler-started-at',
  ENDED_AT: 'x-notarium-handler-ended-at',
} as const
