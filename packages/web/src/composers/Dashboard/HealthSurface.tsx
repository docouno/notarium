import { useMemo } from 'react'
import { RESOLVED_VIA } from '@notarium/core'
import { CardLink } from '../../core/CardLink'
import { EmptyState } from '../../core/EmptyState'
import { IconHistory, IconLink, IconSparkles } from '../../core/Icons'
import { Skeleton } from '../../core/Skeleton'
import { orphansOf } from '../../libs/activity'
import { noteRoute } from '../../libs/routing/routePaths'
import { useDashboardContext } from './useDashboardData'
import styles from './Dashboard.module.scss'

// The Health surface (#216): the connectivity repair queue, full lists (not the
// dashboard's old 6-item cards). Three read-only sections:
//   • "Broken links" — ghost targets ([[Label]] no live note matches) + who points
//     at them, ranked by refCount (#100 phase 5). Click a source to fix the dangling link.
//   • "Resolved via a former name" — links the alias model kept working through a
//     PRIOR name; each row opens its SOURCE so a user can eyeball the [[Old Name]].
//   • "Orphans" — real notes with degree 0. Moved here from the old Hubs/Orphans
//     card: an orphan isn't navigation, it's a connectivity problem — "what's
//     detached". Computed client-side off the graph (nodes carry `degree`).
// Each section hides when empty; a wholly-healthy graph shows a friendly all-clear.
// Capability-honest: a host WITHOUT graphHealth (health === null after loading)
// can't check broken/former-name links at all, so we say so rather than claim the
// graph is healthy — orphans still compute off /api/graph regardless.

const VIA_LABEL: Record<'note-alias' | 'folder-alias', string> = {
  'note-alias': 'former name',
  'folder-alias': 'former path',
}

export const HealthSurface = () => {
  const { health, graph, loading, openNote } = useDashboardContext()

  // Genuinely-stale edges (resolved through a PRIOR name). A live custom slug is a
  // current alternate, not history, so it's excluded from the "former name" list.
  const stale = useMemo(
    () =>
      (health?.edges ?? []).filter(
        (e) => e.via === RESOLVED_VIA.noteAlias || e.via === RESOLVED_VIA.folderAlias,
      ),
    [health],
  )
  // The HONEST former-name total comes off the headline count, not `stale.length`:
  // the wire caps the edge list (HEALTH_EDGE_CAP), so on a large base the rendered
  // rows are a SAMPLE and `staleNamed` is the real total (drives the badge + "+N more").
  const staleTotal = health?.staleNamed ?? 0
  const ghosts = health?.ghosts ?? []
  // The FULL orphan list — no window (the surface exists to show all of it).
  const orphans = useMemo(() => orphansOf(graph, Infinity).items, [graph])

  const booting = loading && !health && !graph
  // graphHealth is optional (#100 phase 5): a host whose store can't derive it 404s, and
  // the fetch is swallowed to null. That is NOT "healthy" — we simply never checked
  // broken/former-name links, so don't assert an all-clear off it.
  const healthUnavailable = !booting && !health
  const allClear =
    !booting && !!health && ghosts.length === 0 && stale.length === 0 && orphans.length === 0

  const skeleton = (
    <div className={styles.linkList}>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className={styles.linkRow}>
          <Skeleton w="70%" h={13} />
        </div>
      ))}
    </div>
  )

  if (booting) {
    return (
      <div className={styles.surface} data-testid="dash-surface-health">
        <section className={styles.card}>{skeleton}</section>
      </div>
    )
  }

  if (allClear) {
    return (
      <div className={styles.surface} data-testid="dash-surface-health">
        <EmptyState
          icon={<IconLink size={22} />}
          title="Everything's linked up"
          hint="No broken links, no orphaned notes — the graph is healthy."
        />
      </div>
    )
  }

  // No graphHealth on this host AND nothing else to show: be honest that link
  // health wasn't checked, rather than claiming an all-clear (capability honesty).
  if (healthUnavailable && orphans.length === 0) {
    return (
      <div className={styles.surface} data-testid="dash-surface-health">
        <EmptyState
          icon={<IconLink size={22} />}
          title="Link-health checks aren't available on this workspace"
          hint="Broken-link and former-name detection needs the graph-health capability, which this host doesn't provide."
        />
      </div>
    )
  }

  return (
    <div className={styles.surface} data-testid="dash-surface-health">
      {/* Degraded host (no graphHealth): orphans still compute off the graph, but be
          explicit that broken/former-name links went UNCHECKED — else empty broken
          sections read as "zero broken links". */}
      {healthUnavailable && (
        <p className={styles.cardIntro} data-testid="dash-health-degraded">
          Broken-link and former-name checks aren’t available on this workspace — showing orphaned
          notes from the graph only.
        </p>
      )}

      {ghosts.length > 0 && (
        <section className={styles.card} data-testid="dash-broken-links">
          <h2 className={styles.cardTitle}>
            <IconLink size={15} /> Broken links
            <span className={styles.cardCount}>{ghosts.length}</span>
          </h2>
          <p className={styles.cardIntro}>
            A <code>[[link]]</code> points at a note that doesn’t exist. Rename the link to an
            existing note, or create the one it expects.
          </p>
          <div className={styles.linkList}>
            {ghosts.map((g) => {
              // A ghost isn't navigable (no note); offer to open the first source
              // with a navigable id so the user can fix the dangling [[Label]].
              const first = g.sources.find((s) => s.id) ?? g.sources[0]
              return (
                <CardLink
                  key={g.id}
                  href={first?.id ? noteRoute(first.id) : null}
                  onOpen={() => first?.id && openNote(first.id)}
                  className={styles.linkRow}
                  dataId={first?.id}
                >
                  <span className={styles.linkTitle}>{g.title || g.target}</span>
                  <span className={styles.linkBadge}>
                    {g.refCount === 1 ? '1 ref' : `${g.refCount} refs`}
                  </span>
                </CardLink>
              )
            })}
          </div>
        </section>
      )}

      {stale.length > 0 && (
        <section className={styles.card} data-testid="dash-stale-links">
          <h2 className={styles.cardTitle}>
            <IconHistory size={15} /> Resolved via a former name
            <span className={styles.cardCount}>{staleTotal}</span>
          </h2>
          <p className={styles.cardIntro}>
            These links still work — but through a note’s <em>previous</em> name (the alias holds
            after a rename). Update them to the current name so they don’t rely on history.
          </p>
          <div className={styles.linkList}>
            {stale.map((e, i) => (
              <CardLink
                key={`${e.source.id}::${e.target.id}::${i}`}
                href={noteRoute(e.source.id)}
                onOpen={() => openNote(e.source.id)}
                className={styles.linkRow}
                dataId={e.source.id}
              >
                <span className={styles.linkTitle}>
                  {e.source.title || 'Untitled'}
                  <span className={styles.linkArrow}> → {e.target.title || 'Untitled'}</span>
                </span>
                <span className={styles.linkBadge}>
                  {VIA_LABEL[e.via as 'note-alias' | 'folder-alias']}
                </span>
              </CardLink>
            ))}
            {/* The wire caps the edge list, so rows are a sample of the true total. */}
            {staleTotal > stale.length && (
              <span className={styles.linkMore}>+{staleTotal - stale.length} more</span>
            )}
          </div>
        </section>
      )}

      {orphans.length > 0 && (
        <section className={styles.card} data-testid="dash-orphans">
          <h2 className={styles.cardTitle}>
            <IconSparkles size={15} /> Orphans
            <span className={styles.cardCount}>{orphans.length}</span>
          </h2>
          <p className={styles.cardIntro}>
            Notes with no links in or out — disconnected from the rest of the graph. Link them to
            related notes so they’re reachable.
          </p>
          <div className={styles.linkList}>
            {orphans.map((n) => (
              <CardLink
                key={n.id}
                href={noteRoute(n.id)}
                onOpen={() => openNote(n.id)}
                className={styles.linkRow}
                dataId={n.id}
              >
                <span className={styles.linkTitle}>{n.title || 'Untitled'}</span>
              </CardLink>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
