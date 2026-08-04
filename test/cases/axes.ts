// The canonical product axes a seed stand can dial into (#175). Each axis names
// the SURFACES it feeds and the canon doc / issues that spec it, so the coverage
// matrix (`make seed-coverage`, docs/seeds.md) can show — honestly — what the
// catalog exercises and where a gap is. A case tags the `axes` it drives; the
// `content` axis is exercised through the corpus (Feature × Fragment). A coverage
// test asserts every axis carries at least one case and every feature at least one
// fragment, so an unseeded surface is caught, not silently missed.

export type Axis =
  | 'content'
  | 'structure'
  | 'folder-page'
  | 'activity'
  | 'history'
  | 'trash'
  | 'identity'
  | 'search'
  | 'graph'
  | 'agent-memory'
  | 'agent-audit'
  | 'agent-sessions'
  | 'note-classes'
  | 'import'
  | 'jobs'
  | 'scale'
  | 'auth'
  | 'favorites'

export type AxisInfo = {
  axis: Axis
  title: string
  /** Product surfaces this axis drives into empty/sparse/full/mixed states. */
  surfaces: readonly string[]
  /** Canon doc(s) / issues that spec the axis. */
  refs: readonly string[]
}

export const AXES: readonly AxisInfo[] = [
  {
    axis: 'content',
    title: 'Content / markdown render',
    surfaces: ['reader', 'editor-preview', 'history-diff', 'settings-sample'],
    refs: ['#235', '#236', '#237', '#117', 'reading-typography.md'],
  },
  {
    axis: 'structure',
    title: 'Spaces / projects / folders',
    surfaces: ['tree', 'explorer'],
    refs: ['#16', '#13', '#74', 'spaces.md', 'projects.md'],
  },
  {
    axis: 'folder-page',
    title: 'Folder pages',
    surfaces: ['folder-page', 'children-summary', 'breadcrumbs'],
    refs: ['#212', '#213', '#214', 'folder-page.md'],
  },
  {
    axis: 'activity',
    title: 'Journal activity',
    surfaces: ['heatmap', 'feed', 'dashboard'],
    refs: ['#12', '#217', '#218', 'dashboard.md', 'feed-page.md'],
  },
  {
    axis: 'history',
    title: 'Revision history',
    surfaces: ['history-timeline', 'diff'],
    refs: ['#12', '#203', '#160', 'note-history.md'],
  },
  {
    axis: 'trash',
    title: 'Trash / undelete',
    surfaces: ['trash'],
    refs: ['#79', '#110', '#183', '#184', 'trash.md'],
  },
  {
    axis: 'identity',
    title: 'Rename / move / alias',
    surfaces: ['breadcrumbs', 'wiki-resolution', 'health'],
    refs: ['#100', '#51', '#71', '#122'],
  },
  {
    axis: 'search',
    title: 'Search / tags / spotlight',
    surfaces: ['search', 'spotlight', 'tag-facet'],
    refs: ['#188', '#193', '#109', '#204', 'search.md', 'spotlight.md'],
  },
  {
    axis: 'graph',
    title: 'Graph / links health',
    surfaces: ['global-graph', 'local-graph', 'health'],
    refs: ['#38', '#202', '#25'],
  },
  {
    axis: 'agent-memory',
    title: 'Agent memory / context',
    surfaces: ['agents-context', 'memory'],
    refs: ['#165', '#78', '#13', '#208'],
  },
  {
    axis: 'agent-audit',
    title: 'Agent retrieval audit',
    surfaces: ['agents-audit'],
    refs: ['#243', 'projects.md', 'mcp-gateway.md'],
  },
  {
    axis: 'agent-sessions',
    title: 'Agent sessions / episode binding',
    surfaces: ['mcp-start-session', 'mcp-tool-binding'],
    refs: ['mcp-gateway.md'],
  },
  {
    axis: 'note-classes',
    title: 'Note classes / visibility',
    surfaces: ['tree', 'graph', 'feed', 'search'],
    refs: ['#78', '#74'],
  },
  {
    axis: 'import',
    title: 'Import shapes',
    surfaces: ['import', 'feed'],
    refs: ['#11', '#113', '#223', 'import.md'],
  },
  {
    axis: 'jobs',
    title: 'Durable jobs / export artifacts',
    surfaces: ['export-tab', 'job-download'],
    refs: ['#105', '#191', '#101', 'jobs.md', 'export.md'],
  },
  {
    axis: 'scale',
    title: 'Scale / virtualization',
    surfaces: ['tree', 'feed', 'heatmap', 'trash'],
    refs: ['#64', '#68', '#193'],
  },
  {
    axis: 'auth',
    title: 'Auth / space topology',
    surfaces: ['switcher', 'members'],
    refs: ['#10', '#16', '#99', 'auth.md'],
  },
  {
    axis: 'favorites',
    title: 'Favorites lens / merged Files rail',
    surfaces: ['rail', 'explorer', 'feed-favorite-facet', 'dashboard-card'],
    refs: ['#42', '#245'],
  },
]

export const AXIS_IDS: readonly Axis[] = AXES.map((a) => a.axis)

const BY_AXIS = new Map(AXES.map((a) => [a.axis, a]))

export const axisInfo = (axis: Axis): AxisInfo => {
  const info = BY_AXIS.get(axis)

  if (!info) {
    throw new Error(`unknown axis: ${axis}`)
  }

  return info
}
