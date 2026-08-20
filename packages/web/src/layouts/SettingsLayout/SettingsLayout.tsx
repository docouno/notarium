import { type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Link, NavLink, Outlet } from 'react-router'
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

export type SettingsTab = {
  id: string
  label: string
  icon?: ReactNode
  onClick?: (event: ReactMouseEvent<HTMLElement>) => void
}

/** The rail + body, which both forms render. */
type SettingsLayoutBody = {
  /** This section's own breadcrumb tail; the active space is prepended unless spaceLess. */
  trail: Crumb[]
  /** Tab groups (the left scope rail), rendered with a divider between them. Omit for a
   *  surface with no secondary axis (Agents → Activity): the panel then spans full width. */
  groups?: SettingsTab[][]
  /** Map a tab id to its route (so the same layout serves both settings homes). */
  routeFor?: (tabId: string) => string
  /** Controlled active state for chrome pages whose selected tab is not the raw route match. */
  activeId?: string
  onSelect?: (tabId: string) => void
  /** A section pill-bar (#243) rendered above the body — the surface's own top-level
   *  sub-nav (the Agents Context | Roles | Activity sections). Orthogonal to the left scope rail. */
  sectionTabs?: ReactNode
  children?: ReactNode
  testIdPrefix?: string
}

/** The two forms are two components behind one name, and the chrome props belong to
 *  ONE of them: unframed, this renders no PageFrame at all, so a topbar action, an
 *  aside, an inert flag or a breadcrumb setting passed here has nowhere to go. Split
 *  so the compiler says that instead of the surface silently dropping it. */
type SettingsLayoutProps = SettingsLayoutBody &
  (
    | {
        /** Agents owns one PageFrame above all of its routes; reuse only the inner
         *  rail/body there — and pass its chrome to THAT frame. */
        framed: false
      }
    | {
        framed?: true
        spaceLess?: boolean
        /** Page-specific actions in PageFrame's canonical topbar action slot. */
        topbarActions?: ReactNode
        /** Optional right panel; SettingsLayout keeps owning the document-free centre column. */
        aside?: ReactNode
        /** Makes the main column inert while a narrow overlay aside is open. */
        contentInert?: boolean
      }
  )

export const SettingsLayout = (props: SettingsLayoutProps) => {
  const {
    trail,
    groups,
    routeFor,
    activeId,
    onSelect,
    sectionTabs,
    children,
    testIdPrefix = 'settings',
  } = props
  const sectionLabel = trail[trail.length - 1]?.label ?? 'Settings'
  const hasRail = !!groups && groups.length > 0
  const content = (
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
                      onClick={(event) => {
                        t.onClick?.(event)
                        onSelect(t.id)
                      }}
                      aria-current={activeId === t.id ? 'page' : undefined}
                      data-testid={`${testIdPrefix}-tab-${t.id}`}
                    >
                      {t.icon}
                      <span className={styles.tabLabel}>{t.label}</span>
                    </button>
                  ) : activeId != null ? (
                    <Link
                      key={t.id}
                      to={routeFor ? routeFor(t.id) : '#'}
                      className={cx(styles.tab, activeId === t.id && styles.tabOn)}
                      aria-current={activeId === t.id ? 'page' : undefined}
                      data-testid={`${testIdPrefix}-tab-${t.id}`}
                      onClick={t.onClick}
                    >
                      {t.icon}
                      <span className={styles.tabLabel}>{t.label}</span>
                    </Link>
                  ) : (
                    <NavLink
                      key={t.id}
                      to={routeFor ? routeFor(t.id) : '#'}
                      className={({ isActive }) => cx(styles.tab, isActive && styles.tabOn)}
                      data-testid={`${testIdPrefix}-tab-${t.id}`}
                      onClick={t.onClick}
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
  )

  if (props.framed === false) {
    return content
  }

  return (
    <PageFrame
      topbarLeft={<Breadcrumbs trail={trail} spaceLess={props.spaceLess ?? false} />}
      topbarActions={props.topbarActions}
      aside={props.aside}
      contentInert={props.contentInert ?? false}
    >
      {content}
    </PageFrame>
  )
}
