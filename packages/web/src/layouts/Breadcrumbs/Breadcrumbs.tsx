import { Link } from 'react-router'
import { useSpace } from '../../composers/SpaceProvider'
import { cx } from '../../libs/cx/cx'
import { spaceRoute } from '../../libs/routing/routePaths'
import styles from './Breadcrumbs.module.scss'

export type Crumb = { label: string; href?: string }

// The shared topbar breadcrumb (#28). Every space-scoped surface leads with the
// active space, so that's added HERE from the live SpaceProvider state — pages
// pass only their own trail and never have to thread the space name through, so
// the prefix can't drift or be forgotten. An ancestor crumb that carries an `href`
// (#214: the space home, a folder's page) renders as a real link — the trail is a
// navigation surface now, not just a label — while the LAST crumb is always the
// current page and stays plain text (a link to where you already are is noise).
// `spaceLess` drops the prefix for the few genuinely space-free surfaces (settings).
export const Breadcrumbs = ({
  trail,
  spaceLess = false,
}: {
  trail: Crumb[]
  spaceLess?: boolean
}) => {
  const { space, spaces, personalSpace } = useSpace()
  // The personal domain (#13) isn't in `spaces`; resolve its name too so reading
  // an about-you memory note shows "Personal", not a raw slug.
  const spaceName =
    spaces.find((s) => s.slug === space)?.displayName ??
    (personalSpace?.slug === space ? personalSpace.displayName : space)
  // The leading space crumb links to the space home — dropped by the last-crumb
  // rule below when it's the only crumb (the home itself).
  const crumbs: Crumb[] = spaceLess
    ? trail
    : [{ label: spaceName, href: spaceRoute(space) }, ...trail]

  return (
    <nav className={styles.crumbs} aria-label="Breadcrumb">
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1
        return (
          <span key={i} className={styles.crumb}>
            {!last && c.href ? (
              <Link to={c.href} className={styles.link}>
                {c.label}
              </Link>
            ) : (
              <span className={cx(last && styles.current)}>{c.label}</span>
            )}
            {!last && <span className={styles.sep}>/</span>}
          </span>
        )
      })}
    </nav>
  )
}
