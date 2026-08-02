import type { SkeletonNode } from './tree'

// The explorer's view scope (#164). The Files tree can show the whole space
// (the default), the forest of MARKED projects, or a single project in focus.
// This is a pure CLIENT view filter over the server-authoritative skeleton +
// the project registry — no contract change: the tree skeleton already carries
// every folder and ProjectsProvider already knows which are projects.
//
//  - 'files'   → the whole tree from the space root (the historical behaviour).
//  - 'projects'→ ONLY the marked projects (the "Projects" mode). The outermost
//                non-root projects become the top-level rows; their content
//                (including any NESTED projects, shown in place with their own
//                badge) nests beneath. Root-level notes + non-project folders are
//                hidden. The SPACE ROOT project is excluded on purpose: a space's
//                root is auto-marked (#97/#13 item 5), so a root-inclusive view would
//                just equal Files — the value here is the sub-projects you made.
//  - 'project' → a single project in focus: the tree is re-rooted at its folder
//                and shows only its CONTENTS (the project's own row is implied by
//                the header label, not repeated). The "root" drop zone / new-note
//                target becomes the project's folder.
//  - 'memory'  → the agent-memory audit (#165), shown as a TREE in the same
//                explorer panel: top-level axes (Personal + each project), their
//                memory categories beneath, each a link to its note. It is NOT a
//                view over the file skeleton — it's a separate data source — so the
//                file-tree helpers below ignore it (the Sidebar renders a dedicated
//                <MemoryTree> for it). Not persisted: it's driven by the route
//                (the Agents surface), so a reload restores the file scope.
//  - 'favorites' → the user's pinned notes/folders/projects (#42), shown through
//                the normal file-tree renderer as a filtered structure. Favorite
//                folders/projects keep their full subtree; favorite notes create
//                the ancestor chain needed to show the regular note row.
export type ExplorerScope =
  | { kind: 'files' }
  | { kind: 'projects' }
  | { kind: 'favorites' }
  | { kind: 'project'; path: string }
  | { kind: 'memory' }

/** A predicate "is the folder at this path a marked project?" — supplied by the
 *  caller (ProjectsProvider's projectAt). The space root ('') is intentionally
 *  treated as NOT a project by the helpers below even when it is auto-marked, so
 *  the root project never collapses the Projects view into Files. */
export type IsProject = (path: string) => boolean

/** The skeleton node at an exact folder path, or null. Depth-first over the
 *  nested skeleton (paths are absolute, so an exact match is unambiguous). */
export const findSkeletonNode = (
  nodes: readonly SkeletonNode[],
  path: string,
): SkeletonNode | null => {
  for (const n of nodes) {
    if (n.path === path) {
      return n
    }
    const hit = findSkeletonNode(n.children, path)

    if (hit) {
      return hit
    }
  }

  return null
}

/** The OUTERMOST marked-project nodes (excluding the space root): walk the
 *  skeleton, and the first time a branch is a project, take that node and do NOT
 *  descend — a project nested inside another project stays part of its ancestor's
 *  subtree (rendered in place with its own badge), so it never appears twice and
 *  the recursion the issue worried about can't happen. A non-project folder is
 *  transparent: we descend through it to surface a marked project buried under
 *  plain folders as a top-level row. */
export const outermostProjects = (
  nodes: readonly SkeletonNode[],
  isProject: IsProject,
): SkeletonNode[] => {
  const out: SkeletonNode[] = []

  const walk = (arr: readonly SkeletonNode[]) => {
    for (const n of arr) {
      if (isProject(n.path)) {
        out.push(n)
      } // a project root — its subtree carries any nested projects
      else {
        walk(n.children)
      } // a plain folder — keep looking for projects beneath it
    }
  }
  walk(nodes)
  return out
}

/** The nearest marked project at-or-above `path` (the path itself, then its
 *  ancestors), or null. The space root ('') is never considered a project here
 *  (it carries no path segment), so an auto-marked root doesn't make every folder
 *  "inside a project". Drives the Projects-scope visibility test (scopeHidesFolder). */
export const nearestProjectPath = (path: string, isProject: IsProject): string | null => {
  let acc = path

  while (acc) {
    if (isProject(acc)) {
      return acc
    }
    const i = acc.lastIndexOf('/')

    if (i === -1) {
      break
    }
    acc = acc.slice(0, i)
  }

  return null
}

/** Does the current scope HIDE a note living in `folder` from the explorer tree?
 *  Used to bounce the scope back to Files when an out-of-scope note is opened
 *  (#164, Q3) so "the open note is always revealed in the tree" holds. */
export const scopeHidesFolder = (
  scope: ExplorerScope,
  folder: string,
  isProject: IsProject,
): boolean => {
  if (scope.kind === 'files') {
    return false
  }
  // Memory isn't a file-tree view (#165) — it never hides a file folder (the
  // reveal-on-open logic that calls this only runs for the file scopes).
  if (scope.kind === 'memory') {
    return false
  }
  if (scope.kind === 'favorites') {
    return false
  }
  if (scope.kind === 'projects') {
    return nearestProjectPath(folder, isProject) === null
  }

  // single-project focus: visible iff the folder is the project or under it
  return !(folder === scope.path || folder.startsWith(scope.path + '/'))
}

/** Push a project id to the front of a most-recently-focused list (#164): dedup
 *  (move-to-front if already present) and cap. Drives the dropdown's "recent
 *  projects" quick-jumps — a clean client-side MRU over the focus action, no
 *  server signal needed. Pure, so it unit-tests on its own. */
export const pushRecent = (list: readonly string[], id: string, cap = 5): string[] =>
  [id, ...list.filter((x) => x !== id)].slice(0, cap)

/** The rail's explorer surface — which sub-view of the merged Files section is on
 *  screen (#245). Feed (the overview), a folder page, or an open note are three
 *  FACES of ONE section; `all` is the home dashboard (its own logo, not Files) and
 *  a memory note (/m) belongs to Agents. Derived from `nav.type` + whether an /m
 *  note is open. This is the EXPLICIT signal that replaces the old, overloaded
 *  `nav.type === 'feed'` "not-explorer" check. */
export type NavKind = 'all' | 'feed' | 'folder'

/** Is the current surface one of the merged Files section's faces (#245) — the feed
 *  overview, a folder page, or an open note? A note always browses at nav.type
 *  'folder'. The home dashboard ('all'), a memory note (/m, the Agents surface) and
 *  chrome pages (graph/agents/trash/settings — `browsing` false) are NOT the section.
 *  This is the ONE surface signal both the rail highlight (railScopeActive) and the
 *  "land on the section before lensing" navigation (Sidebar.pickScope) share, so
 *  they can never disagree. */
export const isFilesSection = (s: {
  browsing: boolean
  memoryNoteOpen: boolean
  navType: NavKind
}): boolean => s.browsing && !s.memoryNoteOpen && (s.navType === 'feed' || s.navType === 'folder')

/** Rail highlight for the merged Files section (#245). Feed / folder-page / open
 *  note light ONE "Files" icon (feed is the section's default view, no longer a
 *  separate rail scope). The tree LENS picks WHICH of the two file-tree rail icons
 *  lights — Favorites owns the highlight when its lens is on, else Files (covering
 *  the files / projects / single-project lenses); they are mutually exclusive.
 *
 *  Both light ONLY on the Files section (isFilesSection). Consistency rule (#245,
 *  owner): the home dashboard and chrome surfaces light NEITHER — the home logo owns
 *  home, and picking any file lens first lands you on the section (Sidebar.pickScope
 *  navigates to the feed when off-section; chooseScope, the silent variant the
 *  automatic effects use, never navigates), so the chosen lens's icon always lights
 *  where you land. This is why the star no longer lights on the bare dashboard the way
 *  it did pre-#245 — Files and Favorites now behave identically.
 *
 *  Inputs (all already known in the Sidebar): `browsing` (on a document surface),
 *  `memoryNoteOpen` (an /m note), `navType` (all | feed | folder), `scopeKind` (the
 *  tree lens: files | favorites | projects | project | memory).
 *
 *  Guarantees (unit-tested as a matrix): Files and Favorites never light at once;
 *  neither lights on the home dashboard, a memory note, or a chrome surface. */
export const railScopeActive = (input: {
  browsing: boolean
  memoryNoteOpen: boolean
  navType: NavKind
  scopeKind: ExplorerScope['kind']
}): { filesActive: boolean; favoritesActive: boolean } => {
  const onSection = isFilesSection(input)
  const favoritesActive = onSection && input.scopeKind === 'favorites'
  // Files covers the three non-favorites FILE-tree lenses explicitly (files /
  // projects / single-project) rather than "not favorites" — so a lens that isn't a
  // file-tree view (memory, or any future kind) never lights Files even if it somehow
  // reached an on-section surface. Today 'memory' can't (it's the Agents surface,
  // browsing=false), but the explicit list keeps the guarantee local, not implicit.
  const k = input.scopeKind
  const filesActive = onSection && (k === 'files' || k === 'projects' || k === 'project')
  return { filesActive, favoritesActive }
}
