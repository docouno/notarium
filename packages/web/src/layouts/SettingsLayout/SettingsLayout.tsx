import { type ReactNode } from 'react'
import { NavLink, Outlet } from 'react-router'
import { cx } from '../../libs/cx/cx'
import { Breadcrumbs, type Crumb } from '../Breadcrumbs'
import { PageFrame } from '../PageFrame'
import styles from './SettingsLayout.module.scss'

// Shared settings chrome (#28): a full page (PageFrame — sidebar-collapse toggle
// and gutters for free, no right aside) with a left tab rail over the active
// section. Both the user settings (/settings) and the per-space workspace
// settings (/s/<space>/settings) render through this — they only differ in the
// breadcrumb, which tabs they list, and how a tab id maps to a URL. Tabs are
// routed (deep-link + back button), grouped with dividers; new settings = a tab.

export type SettingsTab = { id: string; label: string; icon?: ReactNode }

export const SettingsLayout = ({
  trail,
  spaceLess = false,
  groups,
  routeFor,
  activeId,
  onSelect,
  sectionTabs,
  children,
  testIdPrefix = 'settings',
}: {
  /** This section's own breadcrumb tail; the active space is prepended unless spaceLess. */
  trail: Crumb[]
  spaceLess?: boolean
  /** Tab groups (the left scope rail), rendered with a divider between them. Omit for a
   *  surface with no secondary axis (Agents → Sessions): the panel then spans full width. */
  groups?: SettingsTab[][]
  /** Map a tab id to its route (so the same layout serves both settings homes). */
  routeFor?: (tabId: string) => string
  /** Controlled mode for chrome pages that use settings-like tabs without routes. */
  activeId?: string
  onSelect?: (tabId: string) => void
  /** A section pill-bar (#243) rendered above the body — the surface's own top-level
   *  sub-nav (the Agents Context | Sessions sections). Orthogonal to the left scope rail. */
  sectionTabs?: ReactNode
  children?: ReactNode
  testIdPrefix?: string
}) => {
  const sectionLabel = trail[trail.length - 1]?.label ?? 'Settings'
  const hasRail = !!groups && groups.length > 0
  return (
    <PageFrame topbarLeft={<Breadcrumbs trail={trail} spaceLess={spaceLess} />}>
      <div className={styles.inner}>
        {sectionTabs && <div className={styles.sectionTabs}>{sectionTabs}</div>}
        <div className={cx(styles.body, !hasRail && styles.bodyNoRail)}>
          {hasRail && (
            <nav className={styles.tabs} aria-label={`${sectionLabel} sections`}>
              {groups.map((group, gi) => (
                <div key={group[0].id} className={styles.tabGroup}>
                  {gi > 0 && <div className={styles.tabSep} aria-hidden="true" />}
                  {group.map((t) =>
                    onSelect ? (
                      <button
                        key={t.id}
                        type="button"
                        className={cx(styles.tab, activeId === t.id && styles.tabOn)}
                        onClick={() => onSelect(t.id)}
                        aria-current={activeId === t.id ? 'page' : undefined}
                        data-testid={`${testIdPrefix}-tab-${t.id}`}
                      >
                        {t.icon}
                        <span className={styles.tabLabel}>{t.label}</span>
                      </button>
                    ) : (
                      <NavLink
                        key={t.id}
                        to={routeFor ? routeFor(t.id) : '#'}
                        className={({ isActive }) => cx(styles.tab, isActive && styles.tabOn)}
                        data-testid={`${testIdPrefix}-tab-${t.id}`}
                      >
                        {t.icon}
                        <span className={styles.tabLabel}>{t.label}</span>
                      </NavLink>
                    ),
                  )}
                </div>
              ))}
            </nav>
          )}
          <section className={styles.panel}>{children ?? <Outlet />}</section>
        </div>
      </div>
    </PageFrame>
  )
}
