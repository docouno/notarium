import { z } from 'zod'
import {
  AUTH_MODE,
  SPACE_ROLE,
  TOKEN_PURPOSE,
  USERNAME_MAX,
  USERNAME_PATTERN,
  USERNAME_RULE,
} from '../../consts/auth'
import { enumValues } from '../../libs/enumValues'
import { SpaceSlugSchema } from '../primitives'

/** How this host authenticates. 'none' = single-principal mode (desktop, dev,
 *  trusted intranet — an explicit operator opt-OUT of login); 'password' = local
 *  users, the default. */
export const AuthModeSchema = z.enum(enumValues(AUTH_MODE))

/** The login handle: lowercase alphanumeric, with `.`, `_` and `-` anywhere inside,
 *  alphanumeric at both ends, at most 32 characters. Unique but MUTABLE — a rename
 *  keeps every membership, token and journal row, because those key the account by
 *  its stable id (`me.id`), and the handle is only how routes address a person and how
 *  a person signs in. A superset of the earlier rule, so every existing handle stays
 *  valid. No longer a subset of SpaceSlug (dots): the one place a handle becomes a slug
 *  is the personal-space mint, which slugifies it. */
export const UsernameSchema = z
  .string()
  .min(1)
  .max(USERNAME_MAX)
  .regex(USERNAME_PATTERN, USERNAME_RULE)

/** An optional e-mail. Trimmed and lower-cased on the way in, so the value compared
 *  for uniqueness, stored and shown back is one and the same. Nothing requires it and
 *  nothing verifies it — there is no mail transport; it is how an admin reaches a
 *  person and a second identifier the login form accepts. */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254))

/** Space-level role: owner manages members; writer mutates notes; reader sees
 *  everything in the space (member-visibility model — "share a subset" = a
 *  separate space). Finer grants are a later ladder.
 *  canon: docs/architecture.md#p14 */
export const SpaceRoleSchema = z.enum(enumValues(SPACE_ROLE))

/** The authenticated caller, with their grants — what scopes the client's
 *  chrome (space list, members buttons, admin menu). */
export const MeSchema = z.object({
  /** The account's stable id — opaque, never part of a URL. The client's key for
   *  per-user local state (drafts, explorer positions), so a rename of the handle
   *  neither loses nor leaks it. canon: docs/auth.md#model */
  id: z.string().min(1),
  username: UsernameSchema,
  /** Visible only to the account itself (and to admins through UserSchema) — never in
   *  a member list, which any participant of a space can read. */
  email: z.string().nullable(),
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
   *  profile live in. null in three cases: not provisioned yet; a host whose
   *  engine can't mint spaces (P5); OR the requesting credential is a PAT/OAuth
   *  token narrowed away from this space (#395) — so the field is now
   *  PRINCIPAL-DEPENDENT: two credentials of the same owner on the same host can
   *  see different values, and a narrowed token also drops the space from
   *  `spaces` above. A cookie session carries no narrowing and always sees it.
   *  NOT one of `spaces` the UI lists as projects — the Personal section keys off
   *  it separately.
   *  canon: docs/architecture.md#p5 · docs/auth.md#model */
  personalSpace: SpaceSlugSchema.nullable(),
})

/** GET /api/auth/session — the boot endpoint, the only data route an anonymous
 *  client can hit: auth mode, whether first-run setup is still open (no users
 *  yet), and who the cookie says you are (null = show the login screen; mode
 *  'none' = a virtual all-access principal, no login UI). */
/** PATCH /api/me — who I am: the handle and the e-mail, session-only (a token cannot
 *  rename its owner). `displayName` and the profile note stay on PUT /api/me/profile
 *  (how I am seen). `email: null` clears the address; an absent field leaves it as it
 *  is. A taken handle or address answers 409 with `username_taken` / `email_taken`;
 *  the response carries the NEW handle — read it from here, not from the request. */
export const MePatchRequestSchema = z.object({
  username: UsernameSchema.optional(),
  email: EmailSchema.nullable().optional(),
})

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
  // A handle OR an e-mail; the service tells the two apart by shape and refuses
  // anything shaped as neither before it reads or hashes. Bounded by the RFC
  // maximum of an address. canon: docs/auth.md#credentials
  identifier: z.string().min(1).max(320),
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

export type MePatchRequest = z.infer<typeof MePatchRequestSchema>

export type AuthSession = z.infer<typeof AuthSessionResponseSchema>

export type LoginRequest = z.infer<typeof LoginRequestSchema>

export type SetupRequest = z.infer<typeof SetupRequestSchema>

export type InviteInfo = z.infer<typeof InviteInfoResponseSchema>

export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequestSchema>

export type PasswordChangeRequest = z.infer<typeof PasswordChangeRequestSchema>
