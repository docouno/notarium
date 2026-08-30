import { type ButtonHTMLAttributes, type CSSProperties, forwardRef } from 'react'
import type { FieldColor } from '@notarium/contract'
import { cx } from '../../libs/cx/cx'
import styles from './Button.module.scss'

// Text/icon button primitive. One element, a few skins — the bordered base plus
// `primary` / `ghost` / `danger` / `warning` colour variants, an `icon` (square)
// and an `active` (pressed) flag. Extra classes pass through `className` so
// callers can add their own module class (e.g. the Feed controls trigger).

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'warning'

export type ButtonProps = {
  variant?: ButtonVariant
  /** Square, glyph-only button. */
  icon?: boolean
  /** Pressed look while a controlled menu/panel is open (ghost buttons). */
  active?: boolean
  /** Semantic tone channels. Used by field-aware surfaces and the palette proof. */
  color?: FieldColor
} & ButtonHTMLAttributes<HTMLButtonElement>

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant, icon, active, color, className, style, ...rest }, ref) => (
    // Spread caller props first; the component's own props win after it. `className`
    // is pulled out and merged (not just overridden) so a caller can extend the
    // button's classes without clobbering them.
    <button
      {...rest}
      ref={ref}
      className={cx(
        styles.btn,
        color && styles.colored,
        variant && styles[variant],
        icon && styles.icon,
        active && styles.active,
        className,
      )}
      style={
        color
          ? ({
              ...style,
              '--button-solid': `var(--field-color-${color})`,
              '--button-surface': `var(--field-color-${color}-surface)`,
              '--button-border': `var(--field-color-${color}-border)`,
            } as CSSProperties)
          : style
      }
    />
  ),
)

Button.displayName = 'Button'
