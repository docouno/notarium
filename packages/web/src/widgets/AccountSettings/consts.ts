import type { PatScope } from '@notarium/contract'
import { PAT_SCOPE } from '@notarium/contract/enums'
import type { ErrorReasonMap } from '../../libs/errors'

/** Expiry presets the create form offers — full ISO is the wire's business. */
export const EXPIRY_DAYS: Record<string, number | null> = { '30d': 30, '90d': 90, never: null }

// Friendly copy for this widget's known wire causes; errorText supplies the
// fallback (server message, or a generic line for anything illegible).
export const PASSWORD_REASONS: ErrorReasonMap = { bad_password: 'Current password is wrong.' }

/** The read/write Segmented options, shared by the create + edit token forms. */
export const SCOPE_OPTIONS: { value: PatScope; label: string }[] = [
  { value: PAT_SCOPE.read, label: 'Read' },
  { value: PAT_SCOPE.write, label: 'Write' },
]
