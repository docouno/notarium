import type { PatScope } from '@notarium/contract'
import { PAT_SCOPE } from '@notarium/contract/enums'
import type { ErrorReasonMap } from '../../libs/errors'

/** Expiry presets the create form offers — full ISO is the wire's business. */
export const EXPIRY_DAYS: Record<string, number | null> = { '30d': 30, '90d': 90, never: null }

// Friendly copy for this widget's known wire causes; errorText supplies the
// fallback (server message, or a generic line for anything illegible).
export const PASSWORD_REASONS: ErrorReasonMap = { bad_password: 'Current password is wrong.' }

export const IDENTITY_REASONS: ErrorReasonMap = {
  username_taken: 'This username is already taken.',
  email_taken: 'This email is already used by another account.',
  // The form refuses invalid input before sending, so this covers only what slipped
  // past it — the wire message is written for an API client, not for this screen.
  validation: 'That username or email is not valid.',
}

/** The read/write Segmented options, shared by the create + edit token forms. */
export const SCOPE_OPTIONS: { value: PatScope; label: string }[] = [
  { value: PAT_SCOPE.read, label: 'Read' },
  { value: PAT_SCOPE.write, label: 'Write' },
]
