// URL paths of the SPA (#51, #16):
//   /                          → redirect to the last-active/default space
//   /s/<space>                 → the space's home (all notes splash)
//   /s/<space>/feed            → the documents feed
//   /s/<space>/graph           → knowledge graph
//   /s/<space>/files/<path>    → a folder of the Files surface (storage view).
//                                Notes have no URL in the files namespace.
//   /n/<id>/<slug>             → a note. The id is THE address (survives
//                                rename/move AND carries no space — the registry
//                                resolves). The trailing <slug> (#100 phase 1) is a
//                                CANONICAL but non-authoritative SEO tail: a
//                                stale/absent/wrong slug still resolves by id, and
//                                NotePage replaces the URL with the current slug.
//   /m/<id>/<slug>             → an agent-memory note. Same identity resolver,
//                                separate UI surface so the chrome can stay in
//                                Agents/Memory before the note detail loads.
//
// Each segment is percent-escaped, so spaces / unicode round-trip safely.
// Route *matching* is react-router's job (the router is a replaceable edge);
// only path building/classification lives here.

import { NOTE_CLASS } from '@notarium/contract/enums'
import {
  AGENTS_PREFIX,
  DEFAULT_AGENT_CONTEXT_SCOPE,
  DEFAULT_AGENTS_TAB,
  DEFAULT_SETTINGS_TAB,
  DEFAULT_WORKSPACE_SETTINGS_TAB,
  FEED_URL_PARAMS,
  FOLDER_PREFIX,
  HOME_ROUTE,
  MEMORY_NOTE_PREFIX,
  NOTE_PREFIX,
  SEGMENTS,
  SETTINGS_PREFIX,
  SPACE_PREFIX,
} from './consts'

/** The dashboard's surfaces (#216). Activity is the DEFAULT — it lives at the
 *  bare space home (`/s/<space>`), so only the deep surfaces (projects / health)
 *  carry a `/dashboard/<view>` path. */
export type DashboardView = 'activity' | 'projects' | 'health'

/** A parsed app location: which scope a pathname addresses. Space-scoped kinds
 *  carry their slug; 'note' is space-free by design; 'root' is `/` (and any
 *  unknown path) — the redirect target picks the active space. */
export type AppPath =
  | { kind: 'root' }
  | { kind: 'graph'; space: string }
  | { kind: 'feed'; space: string }
  | { kind: 'all'; space: string }
  // A dashboard DEEP surface (#216). The default (Activity) parses as 'all' — it
  // IS the home — so this only carries the non-default views.
  | { kind: 'dashboard'; space: string; view: 'projects' | 'health' }
  | { kind: 'note'; id: string; slug?: string }
  | { kind: 'memoryNote'; id: string; slug?: string }
  | { kind: 'folder'; id: string }
  | { kind: 'files'; space: string; path: string }
  | { kind: 'settings'; tab: string }
  | { kind: 'agents'; tab: string }
  | { kind: 'trash'; space: string }
  | { kind: 'workspaceSettings'; space: string; tab: string }

/** Classify a pathname into an app scope. Unknown paths fall back to 'root'. */
export const parseAppPath = (pathname: string): AppPath => {
  const segs = (pathname || HOME_ROUTE).split('/').filter(Boolean).map(decodeURIComponent)

  if (segs[0] === SEGMENTS.note && segs[1]) {
    return { kind: 'note', id: segs[1], slug: segs[2] }
  }
  if (segs[0] === SEGMENTS.memory && segs[1]) {
    return { kind: 'memoryNote', id: segs[1], slug: segs[2] }
  }
  if (segs[0] === SEGMENTS.folder && segs[1]) {
    return { kind: 'folder', id: segs[1] }
  }
  if (segs[0] === SEGMENTS.settings) {
    return { kind: 'settings', tab: segs[1] ?? DEFAULT_SETTINGS_TAB }
  }
  if (segs[0] === SEGMENTS.agents) {
    return { kind: 'agents', tab: segs[1] ?? DEFAULT_AGENTS_TAB }
  }
  if (segs[0] === SEGMENTS.space && segs[1]) {
    const space = segs[1]

    if (segs[2] === SEGMENTS.graph) {
      return { kind: 'graph', space }
    }
    if (segs[2] === SEGMENTS.feed) {
      return { kind: 'feed', space }
    }
    if (segs[2] === SEGMENTS.trash) {
      return { kind: 'trash', space }
    }
    if (segs[2] === SEGMENTS.management) {
      return { kind: 'workspaceSettings', space, tab: segs[3] ?? DEFAULT_WORKSPACE_SETTINGS_TAB }
    }
    if (segs[2] === SEGMENTS.files) {
      return { kind: 'files', space, path: segs.slice(3).join('/') }
    }
    if (segs[2] === SEGMENTS.dashboard) {
      // A deep dashboard surface (#216). Only projects/health are real surfaces.
      // This CLASSIFIER folds bare `/dashboard`, `/dashboard/activity` and any
      // unknown view into the home scope ('all'). The ROUTER is narrower: it
      // redirects only `/dashboard` and `/dashboard/activity` to `/s/<space>`
      // (DashboardHomeRedirect); an unknown view matches no route and gets the
      // honest 404 (App.tsx), it is NOT redirected.
      const view = segs[3]

      if (view === 'projects' || view === 'health') {
        return { kind: 'dashboard', space, view }
      }

      return { kind: 'all', space }
    }
    if (!segs[2]) {
      return { kind: 'all', space }
    }
  }

  return { kind: 'root' }
}

const encodePath = (p: string): string =>
  p.split('/').filter(Boolean).map(encodeURIComponent).join('/')

/** A space's home — the "all notes" scope. */
export const spaceRoute = (space: string): string => `${SPACE_PREFIX}/${encodeURIComponent(space)}`

export const feedRoute = (space: string): string => `${spaceRoute(space)}/${SEGMENTS.feed}`

/** The feed pre-filtered to one folded tag (#109) — a tag-chip deep-link. */
export const feedTagRoute = (space: string, tag: string): string =>
  `${feedRoute(space)}?${FEED_URL_PARAMS.tag}=${encodeURIComponent(tag)}`

/** The feed pre-filled with a search query (#31) — Spotlight's "see all results". */
export const feedQueryRoute = (space: string, q: string): string =>
  `${feedRoute(space)}?${FEED_URL_PARAMS.q}=${encodeURIComponent(q)}`

export const graphRoute = (space: string): string => `${spaceRoute(space)}/${SEGMENTS.graph}`

/** A dashboard surface (#216). The default (Activity) IS the space home, so it
 *  returns the bare `/s/<space>`; the deep surfaces get `/dashboard/<view>`. So
 *  the Activity pill and the home logo point at the same canonical URL. */
export const dashboardRoute = (space: string, view: DashboardView = 'activity'): string =>
  view === 'activity' ? spaceRoute(space) : `${spaceRoute(space)}/${SEGMENTS.dashboard}/${view}`

/** The space's trash (#79): deleted notes, restorable from the journal. */
export const trashRoute = (space: string): string => `${spaceRoute(space)}/${SEGMENTS.trash}`

/** Build the SPA route for a folder tree path ('' = root → the space home). */
export const folderRoute = (space: string, folder: string): string =>
  folder ? `${spaceRoute(space)}/${SEGMENTS.files}/${encodePath(folder)}` : spaceRoute(space)

/** The Files surface root (`/s/<space>/files`) — the storage tree from the top.
 *  Distinct from `folderRoute(space, '')`, which is the space home. */
export const filesRoute = (space: string): string => `${spaceRoute(space)}/${SEGMENTS.files}`

/** The durable PAGE address of a folder (#212): `/folder/<id>` — space-free, the
 *  registry resolves it (like `/n/<id>`). It survives a folder rename/move, so it's
 *  the permalink to link a section by; the resolver redirects to the folder's
 *  current `/files/<path>`. Only an IDENTIFIED folder has an id (page-bearing or
 *  moved); a plain folder is addressed by its path (`folderRoute`). */
export const folderPageRoute = (id: string): string => `${FOLDER_PREFIX}/${encodeURIComponent(id)}`

/** The page href of a folder — the ONE rule every folder→page link shares
 *  (breadcrumb segments and the tree's go-to-page #214, the children summary #213):
 *  an IDENTIFIED folder links by its durable `/folder/<id>` (a move-proof permalink),
 *  a plain never-identified one by its `/files/<path>`. Both resolve to the same
 *  surface (page body or virtual page), so this only decides whether the copied
 *  link survives a rename/move — it never mints identity (no marker spam, #212). */
export const folderPageHref = (space: string, folder: { id?: string; path: string }): string =>
  folder.id ? folderPageRoute(folder.id) : folderRoute(space, folder.path)

/** The user settings surface; `tab` selects the section (#28). Space-free —
 *  user preferences aren't scoped to a space, so this carries no slug. */
export const settingsRoute = (tab: string = DEFAULT_SETTINGS_TAB): string =>
  `${SETTINGS_PREFIX}/${tab}`

/** The Agents surface; `tab` selects the section (#13). Space-free — the
 *  personal layer is the user's, not a project's, so this carries no slug. */
export const agentsRoute = (tab: string = DEFAULT_AGENTS_TAB): string => `${AGENTS_PREFIX}/${tab}`

/** The Agents → Context constructor axis: personal by default, or a project slug. */
export const agentContextRoute = (scope: string = DEFAULT_AGENT_CONTEXT_SCOPE): string =>
  `${agentsRoute('context')}/${encodeURIComponent(scope)}`

/** The Agents → Audit section (#243): the agent-retrieval audit surface. */
export const agentAuditRoute = (): string => agentsRoute('audit')

/** The owned role library and discovery-only built-in catalog. */
export const agentRolesRoute = (): string => agentsRoute('roles')

/** The workspace (per-space) settings surface: `/s/<space>/management/<tab>` (#28).
 *  Members today; grows with the space's own settings. */
export const workspaceSettingsRoute = (
  space: string,
  tab: string = DEFAULT_WORKSPACE_SETTINGS_TAB,
): string => `${spaceRoute(space)}/${SEGMENTS.management}/${tab}`

/** A new-note draft as a real URL (#65): the create-intent rides the query on the
 *  current scope URL, so back/forward/reload restore the form instead of dropping
 *  it (an ephemeral draft owned no URL). `title`/`dir` prefill the fields; `links`
 *  become `[[backlink]]`s (create-from-ghost closes the link it was opened from). */
export const newDraftQuery = (
  p: { title?: string; dir?: string; links?: string[] } = {},
): string => {
  const q = new URLSearchParams()
  q.set('new', '1')
  if (p.title) {
    q.set('title', p.title)
  }
  if (p.dir) {
    q.set('dir', p.dir)
  }
  for (const l of p.links ?? []) {
    if (l) {
      q.append('link', l)
    }
  }

  return `?${q.toString()}`
}

/** Read a new-draft intent back off a URL's search string, or null if absent. */
export const parseNewDraft = (
  search: string,
): { title: string; dir: string; links: string[] } | null => {
  const q = new URLSearchParams(search)

  if (q.get('new') == null) {
    return null
  }

  return { title: q.get('title') ?? '', dir: q.get('dir') ?? '', links: q.getAll('link') }
}

/** Build the SPA route for a note: /n/<id> (space-free), with the canonical SEO
 *  slug tail when given (#100 phase 1) — `/n/<id>/<slug>`. Pass the EFFECTIVE slug
 *  (custom or title-derived, see effectiveSlug); a falsy slug yields the bare
 *  /n/<id> (NotePage canonicalises it on open). Null without an id. */
export const noteRoute = (id: string | null | undefined, slug?: string): string | null => {
  if (!id) {
    return null
  }
  const base = `${NOTE_PREFIX}/${encodeURIComponent(id)}`
  return slug ? `${base}/${encodeURIComponent(slug)}` : base
}

/** Build the SPA route for an agent-memory note: /m/<id>/<slug>. */
export const memoryNoteRoute = (id: string | null | undefined, slug?: string): string | null => {
  if (!id) {
    return null
  }
  const base = `${MEMORY_NOTE_PREFIX}/${encodeURIComponent(id)}`
  return slug ? `${base}/${encodeURIComponent(slug)}` : base
}

/** Canonical note route for a loaded note class. User-docs live at /n, memory at /m. */
export const noteRouteForClass = (
  id: string | null | undefined,
  noteClass?: string,
  slug?: string,
): string | null =>
  noteClass === NOTE_CLASS.agentMemory ? memoryNoteRoute(id, slug) : noteRoute(id, slug)

// A click the browser should handle natively (open in a new tab/window) instead
// of us hijacking it for in-app navigation: any modifier key, or a non-primary
// (e.g. middle) button. Needed for anchors rendered outside React's tree
// (markdown wiki-links, feed cards) where <Link> can't be used.
export const isModifiedClick = (e: {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  button: number
}): boolean => e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0
