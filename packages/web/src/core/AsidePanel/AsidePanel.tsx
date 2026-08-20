import { type ReactNode } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './AsidePanel.module.scss'

// The one body layout for anything hosted by the right aside: a column of labelled
// fields with a single rhythm, shared by reading metadata, editor metadata and
// instance settings.
// canon: docs/web-ui.md#web-react
export const AsidePanel = ({
  children,
  className,
  testId,
}: {
  children: ReactNode
  className?: string
  testId?: string
}) => (
  <div className={cx(styles.panel, className)} data-testid={testId}>
    {children}
  </div>
)

/** One labelled field: the label states what it is, the body shows the value or
 *  hosts the control. Nothing else — a field that needs a sentence to be understood
 *  is a naming problem, not a layout one. */
export const AsideField = ({
  label,
  children,
  htmlFor,
}: {
  label: string
  children: ReactNode
  /** Makes the label a real <label> for a control the field hosts. */
  htmlFor?: string
}) => (
  <div className={styles.field}>
    {htmlFor ? (
      <label className={styles.label} htmlFor={htmlFor}>
        {label}
      </label>
    ) : (
      <span className={styles.label}>{label}</span>
    )}
    <div className={styles.value}>{children}</div>
  </div>
)

/** A field whose value is plain text — the read-mode counterpart of a control. */
export const AsideValue = ({ children }: { children: ReactNode }) => (
  <span className={styles.text}>{children}</span>
)

/** The other aside body: a column of captioned SECTIONS (filters, diagnostics)
 *  rather than labelled fields. Separated from its neighbours by a rule, not by a
 *  gap, so a panel of many sections still reads as one list. */
export const AsideSections = ({ children, testId }: { children: ReactNode; testId?: string }) => (
  <div className={styles.sections} data-testid={testId}>
    {children}
  </div>
)

/** One captioned section. `action` is the caption's own control (a reset), `hint`
 *  the one sentence a diagnostics caption needs to be readable at all. */
export const AsideSection = ({
  heading,
  action,
  hint,
  children,
  testId,
}: {
  heading: ReactNode
  action?: ReactNode
  hint?: ReactNode
  children: ReactNode
  testId?: string
}) => (
  <section className={styles.section} data-testid={testId}>
    <div className={styles.sectionHeading} data-aside-section-heading>
      <span>{heading}</span>
      {action}
    </div>
    {hint ? <p className={styles.sectionHint}>{hint}</p> : null}
    {children}
  </section>
)
