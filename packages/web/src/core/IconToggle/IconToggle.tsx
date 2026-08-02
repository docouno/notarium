import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from 'react'
import { cx } from '../../libs/cx/cx'
import styles from './IconToggle.module.scss'

// A chrome toggle button — the left-rail and right-aside/filters toggles share
// this single component so they read identically across every page (no jump, no
// drift). Two skins for the two places these toggles live:
//  - 'ghost' sits on a solid bar (the topbar, the aside header): transparent
//    until hover, matching the other bar icon buttons.
//  - 'chip'  floats over bare content with no bar behind it (the graph canvas):
//    an elevated plashka so it stays legible.
// `active` lights it with a neutral "pressed" fill while the panel it controls is
// open — the same signal in both skins.
type IconToggleProps = {
  icon: ReactNode
  active?: boolean
  variant?: 'ghost' | 'chip'
  className?: string
} & ComponentPropsWithoutRef<'button'>

// forwardRef so a toggle can also anchor a popover (e.g. the editor's Focus-mode
// dropdown) — the menu needs the trigger's ref for positioning + outside-click exempt.
export const IconToggle = forwardRef<HTMLButtonElement, IconToggleProps>(
  ({ icon, active = false, variant = 'ghost', className = '', ...rest }, ref) => {
    // The 'chip' skin floats over bare canvas — give it the shared frosted material
    // so it refracts the graph behind it (the 'ghost' skin sits on a solid bar, no
    // glass). Hover/active still swap to a solid fill for clear pressed feedback.
    const cls = cx(
      styles.iconToggle,
      styles[`icon-toggle--${variant}`],
      variant === 'chip' && 'glass glass-float',
      active && styles.active,
      className,
    )
    // Spread caller props first; the component's own props (type/className/aria-pressed)
    // win after, so a stray prop can't silently override the toggle's semantics.
    return (
      <button {...rest} ref={ref} type="button" className={cls} aria-pressed={active}>
        {icon}
      </button>
    )
  },
)
