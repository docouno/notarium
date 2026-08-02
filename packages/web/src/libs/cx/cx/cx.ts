/**
 * Join class names, dropping falsy parts. Lets conditional CSS-module classes
 * compose without manual template-string juggling.
 *
 * @example cx(styles.btn, active && styles.active, className)
 */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ')
