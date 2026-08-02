import { z } from 'zod'
import { AUTH_MODE, SPACE_ROLE, TOKEN_PURPOSE } from '../../consts/auth'
import { enumValues } from '../../libs/enumValues'
import { SpaceSlugSchema } from '../primitives'

/** How this host authenticates. 'none' = single-principal mode (desktop, dev,
 *  trusted intranet — an explicit operator opt-OUT of login); 'password' = local
 *  users, the default. */
export const AuthModeSchema = z.enum(enumValues(AUTH_MODE))

/** Immutable login handle: lowercase alphanumeric with inner dashes. The wire's
 *  user key — memberships, journal attribution and management routes speak
 *  usernames. Deliberately NARROWER than SpaceSlug (no underscore): a username
 *  is never run through `slugify`/`idToSlug`, so it has no reason to admit `_`. */
export const UsernameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase alphanumeric and inner dashes')

/** Space-level role: owner manages members; writer mutates notes; reader sees
 *  everything in the space (member-visibility model — "share a subset" = a
 *  separate space). Finer grants are a later ladder.
 *  canon: docs/architecture.md#p14 */
export const SpaceRoleSchema = z.enum(enumValues(SPACE_ROLE))

/** The authenticated caller, with their grants — what scopes the client's
 *  chrome (space list, members buttons, admin menu). */
export const MeSchema = z.object({
  username: UsernameSchema,
  displayName: z.string().min(1),
  admin: z.boolean(),
  /** A grant: the space's CURRENT slug + role, plus its uniquely resolvable past slugs
   *  so the client's access classifier stays correct through a rename. Without
   *  `aliases`, a tab whose active slug lags a just-renamed space reads as a lost
   *  grant — a false `space-lost` takeover and a read-only chrome flash; a
   *  stale-but-aliased active slug still resolves to the held grant. Shadowed or
   *  ambiguous history is omitted because it does not resolve server-side. */
  spaces: z.array(
    z.object({
      slug: SpaceSlugSchema,
      role: SpaceRoleSchema,
      aliases: z.array(SpaceSlugSchema).optional(),
    }),
  ),
  /** The user's personal domain: the space their agent memory and
   *  profile live in. null until provisioned, or on hosts whose engine can't mint
   *  spaces (P5). NOT one of `spaces` the UI lists as projects — the Personal
   *  section keys off it separately.
   *  canon: docs/architecture.md#p5 */
  personalSpace: SpaceSlugSchema.nullable(),
})

/** GET /api/auth/session — the boot endpoint, the only data route an anonymous
 *  client can hit: auth mode, whether first-run setup is still open (no users
 *  yet), and who the cookie says you are (null = show the login screen; mode
 *  'none' = a virtual all-access principal, no login UI). */
export const AuthSessionResponseSchema = z.object({
  mode: AuthModeSchema,
  setup: z.boolean(),
  me: MeSchema.nullable(),
})

/** A new password. The upper bound is a DoS guard, not a policy: every password
 *  is run through scrypt (~128 MiB), so an unbounded body would be an
 *  amplification lever — 1024 is far above any real passphrase. The lower bound
 *  is the only strength rule imposed. */
export const NewPasswordSchema = z.string().min(8).max(1024)

export const LoginRequestSchema = z.object({
  username: UsernameSchema,
  // Login never rejects a long password on length — only the SET paths bound
  // it; here an over-long input simply fails to match and 401s like any wrong
  // one. The max still caps scrypt work on the login path.
  password: z.string().min(1).max(1024),
})

/** POST /api/auth/setup — first-run: mint the host owner (admin). Open only
 *  while the host has zero users; afterwards it answers 404 forever. */
export const SetupRequestSchema = z.object({
  username: UsernameSchema,
  displayName: z.string().min(1).optional(),
  password: NewPasswordSchema,
})

/** Invite/reset links: no SMTP on a self-host MVP, so credential bootstrap
 *  is a one-time link the admin hands over out-of-band. The token travels in the
 *  URL FRAGMENT (`/invite#<token>`) — fragments don't reach access logs — and is
 *  posted in a body, never a query string. Single-use, expiring; 'invite' sets
 *  the first password, 'reset' replaces a lost one. */
export const InviteInfoRequestSchema = z.object({ token: z.string().min(1) })

/** Credential-bootstrap link purpose: 'invite' sets the first password,
 *  'reset' replaces a lost one. */
export const TokenPurposeSchema = z.enum(enumValues(TOKEN_PURPOSE))

export const InviteInfoResponseSchema = z.object({
  username: UsernameSchema,
  displayName: z.string(),
  purpose: TokenPurposeSchema,
})

export const AcceptInviteRequestSchema = z.object({
  token: z.string().min(1),
  password: NewPasswordSchema,
})

export const PasswordChangeRequestSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: NewPasswordSchema,
})
export type Username = z.infer<typeof UsernameSchema>
export type Me = z.infer<typeof MeSchema>

export type AuthSession = z.infer<typeof AuthSessionResponseSchema>

export type LoginRequest = z.infer<typeof LoginRequestSchema>

export type SetupRequest = z.infer<typeof SetupRequestSchema>

export type InviteInfo = z.infer<typeof InviteInfoResponseSchema>

export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>

export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>
