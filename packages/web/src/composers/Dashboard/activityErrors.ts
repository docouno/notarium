import { ApiError } from '../../services/api/client'

export const isActivityProjectionRebuilding = (error: unknown): boolean =>
  error instanceof ApiError && error.reason === 'activity_projection_rebuilding'

export const requiresActivitySnapshotRecovery = (error: unknown): boolean =>
  error instanceof ApiError &&
  (error.reason === 'activity_location_stale' ||
    error.reason === 'activity_projection_stale' ||
    error.reason === 'activity_projection_rebuilding')
