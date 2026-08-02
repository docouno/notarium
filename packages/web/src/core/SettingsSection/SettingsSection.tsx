import { type ReactNode } from 'react'

import { cx } from '../../libs/cx/cx'
import styles from './SettingsSection.module.scss'

// A settings block: a header (title + optional description, optional right-side
// action) over its body (#28). Every settings tab composes these so sections
// read identically across Appearance / Account / Users / Members — uniform
// headers, one rhythm. A core primitive so widgets and pages can both use it.
// `htmlFor` makes the whole header text a <label> for a form control in the
// action slot (a Switch's `id`), so clicking the title/description toggles it.
export const SettingsSection = ({
  title,
  description,
  action,
  htmlFor,
  children,
  testId,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  /** id of a labelable control in `action` (e.g. a Switch) — clicking the header
   *  text then toggles it. */
  htmlFor?: string
  children?: ReactNode
  testId?: string
}) => {
  const head = (
    <>
      <h3 className={styles.title}>{title}</h3>
      {description && <p className={styles.desc}>{description}</p>}
    </>
  )
  return (
    <section className={styles.section} data-testid={testId}>
      <div className={styles.head}>
        {htmlFor ? (
          <label className={cx(styles.headText, styles.clickable)} htmlFor={htmlFor}>
            {head}
          </label>
        ) : (
          <div className={styles.headText}>{head}</div>
        )}
        {action && (
          <div className={cx(styles.action, Boolean(description) && styles.actionOffset)}>
            {action}
          </div>
        )}
      </div>
      {children}
    </section>
  )
}
