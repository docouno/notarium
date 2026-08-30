// The SPA's URL wire-format (#51, #16). Notes are addressed by identity,
// everything space-scoped carries its space slug — two separate namespaces:
//   /n/<id>/<slug>           → a note (slug is decorative; resolution by id only,
//                              space-free — the registry knows the note's space)
//   /m/<id>/<slug>           → an agent-memory note; same identity model as /n,
//                              but a distinct UI surface (Agents / Memory)
//   /s/<space>               → a space's home (all notes)
//   /s/<space>/feed|graph    → the space's system scopes
//   /s/<space>/files/<path>  → a folder (the Files browse surface)
//   /                        → redirect to the last-active/default space
// `/s/` and `/n/` keep system scopes from ever colliding with a real folder.

/** First path segment of each system scope. */
export const SEGMENTS = {
  space: 's',
  feed: 'feed',
  graph: 'graph',
  files: 'files',
  note: 'n',
  memory: 'm',
  folder: 'folder',
  settings: 'settings',
  management: 'management',
  agents: 'agents',
  trash: 'trash',
  // The dashboard's deep surfaces (#216): `/s/<space>/dashboard/<view>`. The
  // default surface (Activity) IS the space home (`/s/<space>`) — only the
  // non-default views (projects / health) carry this segment.
  dashboard: 'dashboard',
} as const

export const HOME_ROUTE = '/'

/** Prefix of every space URL. */
export const SPACE_PREFIX = `/${SEGMENTS.space}` as const

/** Prefix of every note URL. */
export const NOTE_PREFIX = `/${SEGMENTS.note}` as const

/** Prefix of every agent-memory note URL. */
export const MEMORY_NOTE_PREFIX = `/${SEGMENTS.memory}` as const

/** Prefix of a folder PAGE URL (#212): the durable `/folder/<id>` — space-free,
 *  the registry resolves it (like `/n/<id>`). Survives a folder rename/move; the
 *  resolver redirects to the folder's current `/files/<path>`. */
export const FOLDER_PREFIX = `/${SEGMENTS.folder}` as const

/** Prefix of the settings surface. Space-free — user preferences aren't scoped
 *  to a space (#28). */
export const SETTINGS_PREFIX = `/${SEGMENTS.settings}` as const

/** The settings tab shown when none is named (`/settings` → `/settings/appearance`). */
export const DEFAULT_SETTINGS_TAB = 'appearance'

/** Workspace (per-space) settings live under the space: `/s/<space>/management`
 *  (#28). Its own segment — distinct word from the user's `/settings` so the two
 *  surfaces never read alike, in the URL as in the UI. Defaults to General (#123):
 *  a manager lands on the space's own identity; a non-manager / personal domain is
 *  bounced on from there by GeneralTab's self-guard to a tab they can see. */
export const DEFAULT_WORKSPACE_SETTINGS_TAB = 'general'

/** Prefix of the Agents surface (#13): the user's personal layer — what agents
 *  remember about them, and later their roles/tokens. Space-free — the personal
 *  domain's slug never crosses into the URL (it is not one of the spaces the UI
 *  lists), so this carries no slug, like /settings. */
export const AGENTS_PREFIX = `/${SEGMENTS.agents}` as const

/** The role-first Abilities library is the Agents entry surface. */
export const DEFAULT_AGENTS_TAB = 'abilities'

/** The Context constructor's default axis (`/agents/context` → personal). */
export const DEFAULT_AGENT_CONTEXT_SCOPE = 'personal'

/** The feed's bookmarkable filter query-keys — the browser/react-router URL contract
 *  (a shared/bookmarked link must keep working). Written by the feed's filter controls
 *  and the tag/search deep-links, read back by FeedProvider. Deliberately DISTINCT from
 *  the wire query-keys the API layer sends: e.g. the URL carries `tag` (singular,
 *  repeated) while the wire sends `tags` (plural) — the two contracts may legitimately
 *  diverge, so they never share a symbol. */
export const FEED_URL_PARAMS = {
  sort: 'sort',
  q: 'q',
  /** Singular + repeated (`?tag=a&tag=b`); the wire's plural `tags` is a separate key. */
  tag: 'tag',
  field: 'field',
  fieldDay: 'fieldDay',
  fieldAny: 'fieldAny',
  fieldBad: 'fieldBad',
  from: 'from',
  to: 'to',
  favorite: 'favorite',
} as const

/** The Agents → Activity view's bookmarkable state. These are SPA keys, not the
 *  `/api/me/agent-sessions*` wire contract (whose filtering key is `filter`). */
export const AGENT_ACTIVITY_URL_PARAMS = {
  group: 'group',
  show: 'show',
  agent: 'agent',
  tool: 'tool',
  q: 'q',
} as const

/** The shared Abilities library's bookmarkable state. Cursor pagination is
 *  intentionally local: only user-chosen discovery filters survive navigation. */
export const AGENT_PACKAGE_LIBRARY_URL_PARAMS = {
  q: 'q',
  source: 'source',
  home: 'home',
  availability: 'availability',
  project: 'project',
} as const

/** The trash view's bookmarkable query-keys. */
export const TRASH_URL_PARAMS = {
  /** Which sub-view (all / notes / spaces); absent = 'all'. */
  tab: 'tab',
  /** Recovery outcome filter; absent = every deleted item. */
  availability: 'availability',
} as const
