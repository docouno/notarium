import { useEffect } from 'react'
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
} from 'react-router'
import { AUTH_MODE } from '@notarium/contract/enums'
import { AgentsExplorerProvider } from './composers/AgentsExplorerProvider'
import { AuthProvider, useAuth } from './composers/AuthProvider'
import { InvitePage, LoginPage, SetupPage } from './composers/AuthScreens'
import { ChromeProvider } from './composers/ChromeProvider'
import {
  ActivitySurface,
  DashboardLayout,
  HealthSurface,
  ProjectsSurface,
} from './composers/Dashboard'
import { EditingProvider } from './composers/EditingProvider'
import { FavoritesProvider } from './composers/FavoritesProvider'
import { FeedProvider } from './composers/FeedProvider'
import { FieldSchemaProvider } from './composers/FieldSchemaProvider'
import { HotkeysProvider } from './composers/HotkeysProvider'
import { ImportDropZone } from './composers/ImportDropZone'
import { NotesProvider } from './composers/NotesProvider'
import { ProjectsProvider } from './composers/ProjectsProvider'
import { Sidebar } from './composers/Sidebar'
import { SpaceAccessProvider } from './composers/SpaceAccessProvider'
import { SpaceProvider, useSpace } from './composers/SpaceProvider'
import { SpotlightProvider } from './composers/SpotlightProvider'
import { SyncProvider } from './composers/SyncProvider'
import { ErrorBoundary } from './core/ErrorBoundary'
import { SemanticPalettePlate } from './core/SemanticPalettePlate'
import { DocumentLayout } from './layouts/DocumentLayout'
import { useAutoHideScrollbars } from './libs/hooks/useAutoHideScrollbars'
import {
  agentActivityRoute,
  agentContextRoute,
  agentRolesRoute,
  AGENTS_PREFIX,
  FOLDER_PREFIX,
  MEMORY_NOTE_PREFIX,
  NOTE_PREFIX,
  SEGMENTS,
  SETTINGS_PREFIX,
  SPACE_PREFIX,
  spaceRoute,
} from './libs/routing/routePaths'
import { AgentsChrome, MemoryNotePage } from './pages/AgentsPage'
import { FeedPage } from './pages/FeedPage'
import { FilesPage } from './pages/FilesPage'
import { FolderPage } from './pages/FolderPage'
import { GraphPage } from './pages/GraphPage'
import { NotePage } from './pages/NotePage'
import { NotFoundPage } from './pages/NotFoundPage'
import {
  AboutTab,
  AccountTab,
  AppearanceTab,
  ConnectedAppsTab,
  KeyboardTab,
  ProfileTab,
  SettingsPage,
  UsersTab,
} from './pages/SettingsPage'
import { TrashPage } from './pages/TrashPage'
import {
  ExportTab,
  FieldsTab,
  GeneralTab,
  ImportTab,
  MembersTab,
  ProjectsTab,
  WorkspaceSettingsPage,
} from './pages/WorkspaceSettingsPage'

const ActivityRedirect = ({ preserveId = false }: { preserveId?: boolean }) => {
  const { id } = useParams<{ id: string }>()
  const { search } = useLocation()
  return <Navigate to={agentActivityRoute(preserveId ? id : undefined, search)} replace />
}

// App = the provider stack around a thin router. The router is a replaceable
// edge (docs/web-ui.md): it owns URL↔page mapping, links and the
// navigation blocker — data and actions live in the composer providers.
// Every space-scoped page lives under /s/<space>/… (#16); /n/<id> stays
// space-free (the registry resolves) and `/` redirects to the active space.

/** `/` (and pre-#16 space-less paths like /feed) → the active space's
 *  equivalent. The suffix survives so an old bookmark keeps its meaning. */
const SpaceRedirect = ({ suffix = '' }: { suffix?: string }) => {
  const { space } = useSpace()
  const location = useLocation()
  const tail =
    suffix === '/files'
      ? location.pathname // '/files/a/b' → '/s/<space>/files/a/b'
      : suffix
  return <Navigate to={`${spaceRoute(space)}${tail}`} replace />
}

/** `/s/<space>/dashboard` and `/s/<space>/dashboard/activity` are the DEFAULT
 *  surface — which is the space home itself (#216). Canonicalise them to the bare
 *  `/s/<space>` so the Activity pill and the home logo share one URL. */
const DashboardHomeRedirect = () => {
  const { space } = useParams()
  return <Navigate to={spaceRoute(space ?? '')} replace />
}

const AppShell = () => {
  const location = useLocation()
  // One global auto-hide controller for every scrollable surface (#176) — mounted once,
  // document-level, so present and future scrollers are covered without per-view wiring.
  useAutoHideScrollbars()
  return (
    <ChromeProvider>
      <SpaceProvider>
        {/* Runtime access-loss detector (#111): when the active space is
            confirmed gone (revoke / archive / delete), it REPLACES everything
            below with a takeover — so the whole data subtree unmounts and the
            dead space's content leaves RAM/DOM (immediate revoke honoured).
            Above the data providers, below SpaceProvider (it needs the space). */}
        <SpaceAccessProvider>
          {/* The active space's projects (#13): the tree's badges + folder menu
              and the management Projects tab share one source of truth. Above the
              data providers — it only needs the space + the principal. */}
          <ProjectsProvider>
            {/* SyncProvider owns the app's ONE EventSource per active space (#60,
                #16): NotesProvider, GraphView and the sidebar indicator all
                consume it via context. Its dead stream is the #111 trigger. */}
            <SyncProvider>
              <NotesProvider>
                <FavoritesProvider>
                  <FieldSchemaProvider>
                    {/* The Spotlight quick-switcher (#31) — the ⌘/Ctrl+P jump-to-note,
                        also the rail Search icon and the `/` hotkey since the rail
                        Search VIEW was removed in favour of the topbar search (#190). */}
                    <SpotlightProvider>
                      <EditingProvider>
                        {/* HotkeysProvider (#30): the single keyboard dispatcher. Sits
                            here so its handlers can reach every provider above (chrome
                            toggles, editing draft, spotlight, navigation); it owns the
                            global listeners, the cheat sheet and the customisation. */}
                        <HotkeysProvider>
                          <FeedProvider>
                            <AgentsExplorerProvider>
                              <div className="app">
                                <Sidebar />
                                {/* A page crash is caught HERE (#65), so the sidebar/chrome
                                  survive while the content area shows a state screen;
                                  navigating away (resetKey) clears it. The outermost
                                  boundary in main.tsx is the last resort for the rest. */}
                                <ErrorBoundary resetKey={location.pathname}>
                                  <Outlet />
                                </ErrorBoundary>
                                {/* Drag a text file anywhere in the window → import it as a
                                  note into the folder under the cursor / current scope
                                  (#223). A portal overlay; rides `Files` drags only, so it
                                  never collides with the tree's move-DnD. */}
                                <ImportDropZone />
                              </div>
                            </AgentsExplorerProvider>
                          </FeedProvider>
                        </HotkeysProvider>
                      </EditingProvider>
                    </SpotlightProvider>
                  </FieldSchemaProvider>
                </FavoritesProvider>
              </NotesProvider>
            </SyncProvider>
          </ProjectsProvider>
        </SpaceAccessProvider>
      </SpaceProvider>
    </ChromeProvider>
  )
}

const router = createBrowserRouter([
  {
    path: '__test/semantic-palette',
    element: window.__NOTARIUM_TEST__ ? <SemanticPalettePlate /> : <NotFoundPage />,
  },
  {
    element: <AppShell />,
    children: [
      { path: `${SPACE_PREFIX}/:space/graph`, element: <GraphPage /> },
      // Trash (#79): own standalone page like the graph — the sidebar stays, the
      // page owns the main area (a list of deleted notes with restore/purge).
      { path: `${SPACE_PREFIX}/:space/trash`, element: <TrashPage /> },
      // Settings (#28): own page (like the graph — sidebar stays, the page owns
      // the main area). Each section is a routed tab so it deep-links; the bare
      // path lands on the first one. User settings are space-free; workspace
      // management is scoped to a space (/s/<space>/management).
      {
        path: SETTINGS_PREFIX,
        element: <SettingsPage />,
        children: [
          { index: true, element: <Navigate to="appearance" replace /> },
          { path: 'appearance', element: <AppearanceTab /> },
          { path: 'keyboard', element: <KeyboardTab /> },
          { path: 'profile', element: <ProfileTab /> },
          { path: 'account', element: <AccountTab /> },
          { path: 'connected-apps', element: <ConnectedAppsTab /> },
          { path: 'about', element: <AboutTab /> },
          { path: 'users', element: <UsersTab /> },
        ],
      },
      // Agents (#13): role/skill packages, the context constructor and session audit.
      // User-level, space-free; the sidebar stays, the page owns the main area.
      // The bare prefix lands on the role-first package library.
      {
        path: AGENTS_PREFIX,
        element: <AgentsChrome />,
        children: [
          { index: true, element: <Navigate to={agentRolesRoute()} replace /> },
          { path: 'abilities', element: <Navigate to={agentRolesRoute()} replace /> },
          {
            path: 'context',
            lazy: async () => {
              const { ContextPage } = await import('./pages/AgentsPage/ContextPage')

              return { Component: ContextPage }
            },
          },
          { path: 'context/personal', element: <Navigate to={agentContextRoute()} replace /> },
          {
            path: 'context/:scope',
            lazy: async () => {
              const { ContextPage } = await import('./pages/AgentsPage/ContextPage')

              return { Component: ContextPage }
            },
          },
          {
            path: 'activity',
            lazy: async () => {
              const { ActivityFrame } = await import('./pages/AgentsPage/ActivityFrame')

              return { Component: ActivityFrame }
            },
            children: [
              {
                index: true,
                lazy: async () => {
                  const { ActivityPage } = await import('./pages/AgentsPage/ActivityPage')

                  return { Component: ActivityPage }
                },
              },
              { path: 'all', element: <ActivityRedirect /> },
              {
                path: ':id',
                lazy: async () => {
                  const { ActivityEpisodePage } =
                    await import('./pages/AgentsPage/ActivityEpisodePage')

                  return { Component: ActivityEpisodePage }
                },
              },
            ],
          },
          { path: 'sessions', element: <ActivityRedirect /> },
          { path: 'sessions/:id', element: <ActivityRedirect preserveId /> },
          {
            lazy: async () => {
              const { PackageLibraryFrame } = await import('./pages/AgentsPage/PackageLibraryFrame')

              return { Component: PackageLibraryFrame }
            },
            children: [
              {
                path: 'abilities/roles',
                lazy: async () => {
                  const { AbilityLibraryPage } =
                    await import('./pages/AgentsPage/AbilityLibraryPage')

                  return { Component: () => <AbilityLibraryPage expectedKind="roles" /> }
                },
              },
              {
                path: 'abilities/skills',
                lazy: async () => {
                  const { AbilityLibraryPage } =
                    await import('./pages/AgentsPage/AbilityLibraryPage')

                  return { Component: () => <AbilityLibraryPage expectedKind="skills" /> }
                },
              },
              {
                path: 'abilities/roles/new/:draftId',
                lazy: async () => {
                  const { AbilityDraftPage } = await import('./pages/AgentsPage/AbilityDraftPage')

                  return { Component: () => <AbilityDraftPage expectedKind="roles" /> }
                },
              },
              {
                path: 'abilities/skills/new/:draftId',
                lazy: async () => {
                  const { AbilityDraftPage } = await import('./pages/AgentsPage/AbilityDraftPage')

                  return { Component: () => <AbilityDraftPage expectedKind="skills" /> }
                },
              },
              {
                path: 'abilities/roles/owned/:locator',
                lazy: async () => {
                  const { AbilityDetailPage } = await import('./pages/AgentsPage/AbilityDetailPage')

                  return {
                    Component: () => (
                      <AbilityDetailPage expectedKind="role" expectedSource="owned" />
                    ),
                  }
                },
              },
              {
                path: 'abilities/skills/owned/:locator',
                lazy: async () => {
                  const { AbilityDetailPage } = await import('./pages/AgentsPage/AbilityDetailPage')

                  return {
                    Component: () => (
                      <AbilityDetailPage expectedKind="skill" expectedSource="owned" />
                    ),
                  }
                },
              },
              {
                path: 'abilities/roles/system/:packageId',
                lazy: async () => {
                  const { AbilityDetailPage } = await import('./pages/AgentsPage/AbilityDetailPage')

                  return {
                    Component: () => (
                      <AbilityDetailPage expectedKind="role" expectedSource="system" />
                    ),
                  }
                },
              },
              {
                path: 'abilities/roles/catalog/:packageId',
                lazy: async () => {
                  const { AbilityDetailPage } = await import('./pages/AgentsPage/AbilityDetailPage')

                  return {
                    Component: () => (
                      <AbilityDetailPage expectedKind="role" expectedSource="catalog" />
                    ),
                  }
                },
              },
              {
                path: 'abilities/skills/system/:packageId',
                lazy: async () => {
                  const { AbilityDetailPage } = await import('./pages/AgentsPage/AbilityDetailPage')

                  return {
                    Component: () => (
                      <AbilityDetailPage expectedKind="skill" expectedSource="system" />
                    ),
                  }
                },
              },
              {
                path: 'abilities/skills/catalog/:packageId',
                lazy: async () => {
                  const { AbilityDetailPage } = await import('./pages/AgentsPage/AbilityDetailPage')

                  return {
                    Component: () => (
                      <AbilityDetailPage expectedKind="skill" expectedSource="catalog" />
                    ),
                  }
                },
              },
            ],
          },
          { path: 'audit', element: <ActivityRedirect /> },
          { path: 'session', element: <ActivityRedirect /> },
          { path: 'session/*', element: <ActivityRedirect /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
      {
        element: <AgentsChrome />,
        children: [
          { path: `${MEMORY_NOTE_PREFIX}/:id/*`, element: <MemoryNotePage /> },
          { path: `${MEMORY_NOTE_PREFIX}/:id`, element: <MemoryNotePage /> },
        ],
      },
      {
        path: `${SPACE_PREFIX}/:space/management`,
        element: <WorkspaceSettingsPage />,
        children: [
          { index: true, element: <Navigate to="general" replace /> },
          { path: 'general', element: <GeneralTab /> },
          { path: 'members', element: <MembersTab /> },
          { path: 'projects', element: <ProjectsTab /> },
          { path: 'fields', element: <FieldsTab /> },
          { path: 'import', element: <ImportTab /> },
          { path: 'export', element: <ExportTab /> },
        ],
      },
      {
        element: <DocumentLayout />,
        children: [
          { index: true, element: <SpaceRedirect /> },
          // The dashboard (#33/#216): the space home + its deep surfaces are ONE
          // nested route — the layout holds the data + pill bar, the active surface
          // renders in its Outlet, so switching pills never remounts (or refetches)
          // the shell. Activity IS the home (bare `/s/<space>`); projects/health
          // carry a `/dashboard/<view>` tail. `/dashboard(/activity)` canonicalise
          // back to home so the default surface owns a single URL.
          {
            path: `${SPACE_PREFIX}/:space`,
            element: <DashboardLayout />,
            children: [
              { index: true, element: <ActivitySurface /> },
              { path: SEGMENTS.dashboard, element: <DashboardHomeRedirect /> },
              { path: `${SEGMENTS.dashboard}/activity`, element: <DashboardHomeRedirect /> },
              { path: `${SEGMENTS.dashboard}/projects`, element: <ProjectsSurface /> },
              { path: `${SEGMENTS.dashboard}/health`, element: <HealthSurface /> },
            ],
          },
          { path: `${SPACE_PREFIX}/:space/feed`, element: <FeedPage /> },
          // A note by identity; space-free — the registry resolves (#16); the
          // trailing slug segment is decorative (#51).
          { path: `${NOTE_PREFIX}/:id/*`, element: <NotePage /> },
          { path: `${NOTE_PREFIX}/:id`, element: <NotePage /> },
          // An agent-memory note by identity. Same reader as /n, distinct route
          // surface so the chrome stays in Agents/Memory before detail loads.
          // A folder's durable PAGE address (#212), space-free like /n — the
          // registry resolves the id; the resolver redirects to the page note or
          // the folder's current /files/<path>.
          { path: `${FOLDER_PREFIX}/:id`, element: <FolderPage /> },
          // Folders only — notes have no URL in the files namespace (#51).
          { path: `${SPACE_PREFIX}/:space/files/*`, element: <FilesPage /> },
          { path: `${SPACE_PREFIX}/:space/files`, element: <FilesPage /> },
          // Pre-#16 space-less bookmarks keep their meaning in the active space.
          { path: 'feed', element: <SpaceRedirect suffix="/feed" /> },
          { path: 'graph', element: <SpaceRedirect suffix="/graph" /> },
          { path: 'files/*', element: <SpaceRedirect suffix="/files" /> },
          // Genuinely-unknown paths get an honest 404 (#65) instead of a silent
          // bounce to home — the known scopes above are redirected first.
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
])

// The auth gate (#10) — sits ABOVE the router: until a session exists nothing
// space-scoped boots, so SpaceProvider's spacesGet always runs as a known
// principal. AuthProvider renders null while the session facts load.
const AuthGate = () => {
  const { mode, me, setup } = useAuth()
  // /invite#<token> must work logged-in or not (accepting it replaces the
  // session) — and the token rides the fragment, which the router never sees.
  const onInvite = window.location.pathname === '/invite'
  const authScreen = onInvite || (mode === AUTH_MODE.password && !me)
  // Auth screens render ABOVE ChromeProvider (which owns the theme), and :root
  // defaults to light — so without this the sign-in screen inherits whatever
  // data-theme last lingered (or light on a fresh load). Pin dark for a
  // consistent look; ChromeProvider restores the user's real theme once the
  // app tree mounts.
  useEffect(() => {
    if (authScreen) {
      document.documentElement.dataset.theme = 'dark'
    }
  }, [authScreen])
  if (onInvite) {
    return <InvitePage />
  }
  if (mode === AUTH_MODE.password && !me) {
    return setup ? <SetupPage /> : <LoginPage />
  }

  return <RouterProvider router={router} />
}

export const App = () => (
  <AuthProvider>
    <AuthGate />
  </AuthProvider>
)
