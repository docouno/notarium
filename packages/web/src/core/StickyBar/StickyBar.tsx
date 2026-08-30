import { type HTMLAttributes, type RefObject, useRef } from 'react'
import { cx } from '../../libs/cx/cx'
import { useScrollGlass } from '../../libs/hooks/useScrollGlass'
import styles from './StickyBar.module.scss'

// Reusable sticky strip over scrolling content. Its two axes are orthogonal:
//   • edge: where it sticks and where its lit rim faces;
//   • surface: a full-width strip, or a content-local panel with its own inset/shape.
// A scrollRef opts into the shared proportional glass ramp; without one the historical
// constant-glass top banner stays unchanged. Callers own only child layout overrides.
type StickyBarProps = HTMLAttributes<HTMLDivElement> & {
  edge?: 'top' | 'bottom'
  surface?: 'edge' | 'panel'
  scrollRef?: RefObject<HTMLElement | null>
}

export const StickyBar = ({
  edge = 'top',
  surface = 'edge',
  scrollRef,
  className,
  children,
  ...rest
}: StickyBarProps) => {
  const barRef = useRef<HTMLDivElement>(null)
  const emptyScrollRef = useRef<HTMLElement>(null)
  const scrollAware = scrollRef != null
  useScrollGlass(scrollRef ?? emptyScrollRef, barRef, { edge })

  return (
    <div
      ref={barRef}
      className={cx(
        styles.bar,
        styles[edge],
        styles[surface],
        'glass',
        scrollAware && 'glass-scroll',
        edge === 'top' ? 'glass-edge-bottom' : 'glass-edge-top',
        surface === 'panel' && 'glass-panel',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}
