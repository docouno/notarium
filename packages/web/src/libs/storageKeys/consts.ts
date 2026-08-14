// Every localStorage key the web app persists a preference under, in ONE place so
// each key is spelled once and read/written consistently (#56). The string VALUES
// are historical and load-bearing: each is the on-disk handle to a user's saved
// pref, with NO migration — change a value and the saved data is silently orphaned
// (the pref resets to its default on next load). So the three historical prefixes
// (`bm-`, `nt-`, `notarium.`) and every suffix here are frozen; only the symbol
// names are ours. Unifying the prefixes into one namespace is a separate, breaking
// migration (a one-time boot rename) — deliberately NOT done here.
//
// PREFIX keys end in a delimiter and are concatenated with a scope/space at the call
// site (`STORAGE_KEYS.recentNotesPrefix + space`); the trailing ':' is part of the
// stored key. All keys are a pure browser concern — none cross the wire, so this
// lives web-local, not in @notarium/contract.

export const STORAGE_KEYS = {
  // ── Appearance / chrome (ChromeProvider) ───────────────────────────────────
  /** Light vs dark theme. */
  theme: 'bm-theme',
  /** Syntax-highlight theme for code blocks. */
  codeTheme: 'bm-code-theme',
  /** Editor mode (wysiwyg vs source). */
  editorMode: 'bm-editor-mode',
  /** Reading-surface body font. */
  readingFont: 'bm-reading-font',
  /** Reading-surface font size. */
  readingSize: 'bm-reading-size',
  /** Right aside open/closed. */
  asideOpen: 'bm-aside',
  /** Left rail open/closed. */
  railOpen: 'bm-rail-open',
  /** Focus (distraction-free) mode on/off. */
  focus: 'bm-focus',
  /** Focus-mode granularity (sentence/paragraph). */
  focusGrain: 'bm-focus-grain',
  /** Typewriter scrolling on/off. */
  typewriter: 'bm-typewriter',

  // ── Feed prefs (useFeedState) ──────────────────────────────────────────────
  /** Feed sort field (created vs modified). */
  feedSort: 'bm-feed-sort',
  /** Feed layout (list vs grid). */
  feedView: 'bm-feed-view',
  /** Feed grid column count. */
  feedCols: 'bm-feed-cols',
  /** Feed grouping mode. */
  feedGroup: 'bm-feed-group',

  // ── Explorer prefs (NotesProvider) ──
  /** Shared file/memory/favorites sort field. */
  explorerSort: 'bm-explorer-sort',
  /** Shared file/memory/favorites sort direction. */
  explorerSortDir: 'bm-explorer-sort-dir',

  // ── Graph prefs (GraphView) ────────────────────────────────────────────────
  /** Graph node grouping (community/…). */
  graphGroupBy: 'bm-graph-groupby',
  /** Graph node sizing metric (connections/…). */
  graphSizeBy: 'bm-graph-sizeby',
  /** Graph node size scale multiplier. */
  graphSizeScale: 'bm-graph-sizescale',
  /** Graph node spacing multiplier. */
  graphSpacing: 'bm-graph-spacing',
  /** Graph filters panel open/closed. */
  graphFilters: 'bm-graph-filters',
  /** Graph aside active tab. */
  graphTab: 'bm-graph-tab',
  /** Graph connectivity filter (any/connected/isolated). */
  graphConn: 'bm-graph-conn',

  // ── Panel widths / layout (usePanelWidth, useAsideLayout) ──────────────────
  /** Right-aside width — deliberately shared by both aside variants (Aside &
   *  AsideGroups) so a user's width carries across them. */
  asideWidth: 'bm-aside-w',
  /** Left-rail width. */
  railWidth: 'bm-rail-w',
  /** Per-group height spec for the tabbed-groups aside (#35). */
  asideGroups: 'bm-aside-groups',
  /** Activity's Filters / Diagnostics group; separate from the note inspector layout. */
  activityAsideGroups: 'bm-activity-aside-groups',

  // ── Hotkeys (libs/hotkeys/storage) ─────────────────────────────────────────
  /** Chosen hotkey preset id. */
  hotkeyPreset: 'bm-hotkey-preset',
  /** Per-action hotkey overrides (JSON). */
  hotkeyOverrides: 'bm-hotkey-overrides',

  // ── Active space (SpaceProvider) ───────────────────────────────────────────
  /** Last-active space slug — the before-paint hint until the server confirms. */
  activeSpace: 'nt-space',

  // ── Per-scope / per-space PREFIX keys (concatenated with scope/space) ──────
  /** Context constructor's per-scope active space. `+ scope`. */
  contextScopeSpacePrefix: 'nt-context-scope-space:',
  /** Per-space recent NOTES ring. `+ space`. */
  recentNotesPrefix: 'notarium.recentNotes:',
  /** Per-space explorer scope (folder vs files). `+ space`. */
  explorerScopePrefix: 'notarium.explorerScope:',
  /** Per-space recent PROJECTS ring. `+ space`. Distinct from recentNotesPrefix. */
  recentProjectsPrefix: 'notarium.recentProjects:',
} as const
