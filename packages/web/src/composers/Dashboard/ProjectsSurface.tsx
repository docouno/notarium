import { Link } from 'react-router'
import { EmptyState } from '../../core/EmptyState'
import { IconFolderKanban } from '../../core/Icons'
import { Skeleton } from '../../core/Skeleton'
import { timeAgo } from '../../libs/datetime'
import { folderRoute } from '../../libs/routing/routePaths'
import { useDashboardContext } from './useDashboardData'
import styles from './Dashboard.module.scss'

// The Projects surface (#216): every project (#13 marked folder) ranked by recent
// activity — the FULL list, not the dashboard's old top-N card gated to ≥2. Each
// row links to the project's folder; the badge is its recent-revision tally. The
// server already returns the whole ranking (no `limit`), so this surface just
// stops truncating. Empty (a single-project space, or no activity yet) shows an
// honest hint rather than a barren block.

export const ProjectsSurface = () => {
  const { projects, space, loading } = useDashboardContext()
  const booting = loading && projects.length === 0

  return (
    <div className={styles.surface} data-testid="dash-surface-projects">
      <section className={styles.card} data-testid="dash-projects">
        <h2 className={styles.cardTitle}>
          <IconFolderKanban size={15} /> Active projects
          {projects.length > 0 && <span className={styles.cardCount}>{projects.length}</span>}
        </h2>
        {booting ? (
          <div className={styles.linkList}>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className={styles.linkRow}>
                <Skeleton w="60%" h={13} />
              </div>
            ))}
          </div>
        ) : projects.length > 0 ? (
          <div className={styles.linkList}>
            {projects.map((p) => (
              <Link
                key={p.id}
                to={folderRoute(space, p.path)}
                className={styles.linkRow}
                data-id={p.id}
              >
                <span className={styles.linkTitle}>{p.displayName}</span>
                <time className={styles.linkWhen} title={p.lastAt ?? undefined}>
                  {timeAgo(p.lastAt)}
                </time>
                <span className={styles.linkBadge}>{p.count}</span>
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            variant="bare"
            icon={<IconFolderKanban size={20} />}
            title="No project activity yet"
            hint="Projects you work in rank here by recent activity."
          />
        )}
      </section>
    </div>
  )
}
