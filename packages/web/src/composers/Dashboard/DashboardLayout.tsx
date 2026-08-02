import { useEffect, useMemo, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router'
import {
  IconBrain,
  IconClock,
  IconFolderKanban,
  IconLink,
  IconUser,
  IconUsers,
} from '../../core/Icons'
import { Segmented } from '../../core/Segmented'
import { orphanCountOf } from '../../libs/activity'
import { type DashboardView, graphRoute, parseAppPath } from '../../libs/routing/routePaths'
import { useNotes } from '../NotesProvider'
import { useProjects } from '../ProjectsProvider'
import { useSpace } from '../SpaceProvider'
import { Splash } from '../Splash'
import { type DashboardTab, DashboardTabs } from './DashboardTabs'
import { type ActivityScope, type DashboardContext, useDashboardData } from './useDashboardData'
import styles from './Dashboard.module.scss'

// The dashboard shell (#33/#216): the space home (`/s/<space>`) and its deep
// surfaces (`/s/<space>/dashboard/<view>`) are ONE nested route — this layout
// holds the read-model load + the pill bar, the active surface renders in the
// Outlet. Because the layout sits on the shared `/s/<space>` route segment, moving
// between pills (a route change under it) never remounts it: the data survives, so
// switching surfaces is instant and flash-free (and it's SHELL-ready — a future
// document tab just wraps the route). A brand-new, note-less base falls back to
// the friendly Splash CTA rather than a grid of zeros.

export const DashboardLayout = () => {
  const { space } = useSpace()
  const { tree, openNote } = useNotes()
  const { projects: allProjects } = useProjects()
  const data = useDashboardData(space)
  const location = useLocation()
  // Orphan count for the Health pill (a hook — must run before the Splash early
  // return). Count-only (no title sort), memoised on the graph.
  const orphanCount = useMemo(() => orphanCountOf(data.graph), [data.graph])

  // Which pill is active. The default surface (Activity) is the bare home, which
  // parses as 'all', so anything that isn't an explicit deep view is Activity.
  const parsed = parseAppPath(location.pathname)
  const view: DashboardView = parsed.kind === 'dashboard' ? parsed.view : 'activity'

  // The Activity author lens (#218) lives here so its toggle rides the reference-strip
  // row (next to notes·tags·links). The toggle earns its place ONLY when the window
  // actually holds activity by someone other than the viewer (`hasOtherAuthors`, an
  // honest server signal) — a solo space, or one nobody else has touched, has nothing
  // to distinguish, so the scope is forced 'all' and no toggle shows. Unknown until the
  // aggregate loads (→ no toggle yet; the reserved row height keeps it from jumping in).
  // A space switch resets the choice.
  const [scope, setScope] = useState<ActivityScope>('all')
  useEffect(() => setScope('all'), [space])
  const canScope = data.activity?.hasOtherAuthors ?? false
  const effScope: ActivityScope = canScope ? scope : 'all'

  // A brand-new, note-less base keeps the friendly Splash CTA (create your first
  // note) rather than a barren dashboard. After all hooks (rules-of-hooks) + only
  // once the tree has loaded, to avoid a flash.
  if (tree && tree.stats.total === 0) {
    return <Splash />
  }

  const stats = tree?.stats
  const projectCount = allProjects?.length ?? null
  const activeCount = data.projects.length
  const linkCount = data.graph?.links.length ?? null
  // Health pill = the WHOLE repair queue the surface shows (broken links + former-
  // name links + orphans), so pill and surface agree on "All clear". `staleNamed` is
  // the honest (uncapped) former-name total; orphans compute off the graph. Broken
  // links are the only DANGER (a dead [[link]]); the rest is tidy-up, no red dot.
  const brokenCount = data.health?.ghosts.length ?? 0
  const staleCount = data.health?.staleNamed ?? 0
  const healthQueue = brokenCount + staleCount + orphanCount

  const tabs: DashboardTab[] = [
    {
      view: 'activity',
      label: 'Activity',
      icon: <IconClock size={15} />,
      metric: stats ? `${stats.week} this week` : '…',
    },
    {
      view: 'projects',
      label: 'Projects',
      icon: <IconFolderKanban size={15} />,
      metric:
        projectCount == null
          ? '…'
          : activeCount > 0
            ? `${projectCount} · ${activeCount} active`
            : `${projectCount}`,
    },
    {
      view: 'health',
      label: 'Health',
      icon: <IconLink size={15} />,
      metric: data.loading
        ? '…'
        : !data.health
          ? '—'
          : brokenCount > 0
            ? `${brokenCount} to fix`
            : healthQueue > 0
              ? `${healthQueue} to tidy`
              : 'All clear',
      danger: brokenCount > 0,
    },
  ]

  const ctx: DashboardContext = { ...data, space, openNote, scope: effScope }

  return (
    <div className={styles.dash} data-testid="home-dashboard">
      <header className={styles.head}>
        <div className={styles.title}>
          <IconBrain size={22} />
          <h1>{tree ? 'Dashboard' : 'Your knowledge base'}</h1>
        </div>
      </header>

      <DashboardTabs space={space} active={view} tabs={tabs} />

      {/* Reference numbers — the stats the pills don't carry, a thin line under the
          bar. "links" deep-links into the graph (the surface for connectivity). The
          Activity author toggle (#218) rides the RIGHT of this same row (shared space,
          Activity view only) — one header line, not a detached control above the heatmap. */}
      <div className={styles.refstrip} data-testid="dash-refstrip">
        <span className={styles.refItem}>
          <strong>{stats ? stats.total : '…'}</strong> notes
        </span>
        <span className={styles.refItem}>
          <strong>{data.tags ?? '…'}</strong> tags
        </span>
        <Link to={graphRoute(space)} className={styles.refLink}>
          <strong>{linkCount ?? '…'}</strong> links
        </Link>
        {view === 'activity' && canScope && (
          <div className={styles.refToggle}>
            <Segmented
              value={effScope}
              onChange={setScope}
              ariaLabel="Activity author scope"
              options={[
                {
                  value: 'all',
                  label: 'Everyone',
                  icon: <IconUsers size={14} />,
                  title: "Everyone's activity",
                },
                {
                  value: 'mine',
                  label: 'Mine',
                  icon: <IconUser size={14} />,
                  title: 'Only my activity',
                },
              ]}
            />
          </div>
        )}
      </div>

      <Outlet context={ctx} />
    </div>
  )
}
