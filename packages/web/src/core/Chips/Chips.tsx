import { type CSSProperties, type ReactNode } from 'react'
import type { FieldColor } from '@notarium/contract'
import { foldTag } from '@notarium/core/tags'
import { cx } from '../../libs/cx/cx'
import { isModifiedClick } from '../../libs/routing/routePaths'
import { IconX } from '../Icons'
import styles from './Chips.module.scss'

export type ChipVariant = 'neutral' | 'accent'

// A single pill (tag / handle / date). Truncates a long label with an ellipsis
// (the shared concern that used to be re-implemented per card). `className` lets a
// surface override the colour (e.g. the Memory source tag's own hues) without
// re-deriving the pill shape; `maxWidth` caps a long handle.
export const Chip = ({
  icon,
  children,
  variant = 'neutral',
  className,
  title,
  testId,
  maxWidth,
  color,
  ariaLabel,
}: {
  icon?: ReactNode
  children: ReactNode
  variant?: ChipVariant
  className?: string
  title?: string
  testId?: string
  maxWidth?: string | number
  color?: FieldColor
  ariaLabel?: string
}) => (
  <span
    className={cx(styles.chip, variant === 'accent' && styles.accent, className)}
    title={title}
    role={ariaLabel ? 'img' : undefined}
    aria-label={ariaLabel}
    data-testid={testId}
    style={
      color || maxWidth != null
        ? ({
            ...(maxWidth != null ? { maxWidth } : {}),
            ...(color
              ? {
                  '--chip-solid': `var(--field-color-${color})`,
                  '--chip-fg': `var(--field-color-${color}-fg)`,
                  '--chip-surface': `var(--field-color-${color}-surface)`,
                  '--chip-border': `var(--field-color-${color}-border)`,
                }
              : {}),
          } as CSSProperties)
        : undefined
    }
  >
    {icon}
    <span className={styles.label} aria-hidden={ariaLabel ? true : undefined}>
      {children}
    </span>
  </span>
)

export const TagChip = ({
  tag,
  foldedTag = foldTag(tag),
  href,
  onOpenTag,
  className,
  title,
  testId,
  maxWidth,
}: {
  /** The authored label. It is preserved for display even when the href uses the folded key. */
  tag: string
  /** The canonical tag-filter key. Pass it when the caller already folded the tag. */
  foldedTag?: string
  /** A feed URL carrying the folded tag, e.g. `/s/<space>/feed?tag=<folded>`. */
  href?: string
  /** SPA navigation hook for plain clicks; modifier/middle clicks keep the real href. */
  onOpenTag?: (foldedTag: string) => void
  className?: string
  title?: string
  testId?: string
  maxWidth?: string | number
}) => {
  const body = (
    <>
      <span className={styles.tagHash}>#</span>
      <span className={styles.label}>{tag}</span>
    </>
  )
  const style = maxWidth != null ? ({ maxWidth } as CSSProperties) : undefined
  const cls = cx(styles.chip, styles.tagChip, className)
  const label = title ?? tag

  if (!href) {
    return (
      <span className={cls} title={label} data-testid={testId} style={style}>
        {body}
      </span>
    )
  }

  return (
    <a
      className={cls}
      href={href}
      data-tag={foldedTag}
      title={label}
      data-testid={testId}
      style={style}
      onClick={(e) => {
        if (!onOpenTag || isModifiedClick(e)) {
          return
        }
        e.preventDefault()
        onOpenTag(foldedTag)
      }}
    >
      {body}
    </a>
  )
}

export const RemovableTagChip = ({
  tag,
  onRemove,
  className,
  title,
  testId,
  maxWidth,
}: {
  /** The authored label. This selector chip is intentionally not a link. */
  tag: string
  onRemove: () => void
  className?: string
  title?: string
  testId?: string
  maxWidth?: string | number
}) => (
  <RemovableChip
    value={tag}
    onRemove={onRemove}
    prefix="#"
    tag
    className={className}
    title={title}
    testId={testId}
    maxWidth={maxWidth}
  />
)

export const RemovableChip = ({
  value,
  onRemove,
  removeAriaLabel,
  disabled = false,
  prefix,
  tag = false,
  className,
  title,
  testId,
  maxWidth,
}: {
  value: string
  onRemove: () => void
  removeAriaLabel?: string
  disabled?: boolean
  prefix?: ReactNode
  tag?: boolean
  className?: string
  title?: string
  testId?: string
  maxWidth?: string | number
}) => (
  <span
    className={cx(
      styles.chip,
      tag && styles.tagChip,
      styles.removableChip,
      tag && styles.removableTagChip,
      className,
    )}
    title={title ?? value}
    data-testid={testId}
    style={maxWidth != null ? ({ maxWidth } as CSSProperties) : undefined}
  >
    {prefix != null && <span className={styles.tagHash}>{prefix}</span>}
    <span className={styles.label}>{value}</span>
    <button
      type="button"
      className={styles.chipRemove}
      disabled={disabled}
      onClick={onRemove}
      aria-label={removeAriaLabel ?? `Remove ${value}`}
    >
      <IconX size={14} />
    </button>
  </span>
)

// Tag pills for a note's tags. Read surfaces show all tags by default; compact
// surfaces such as Feed cards may pass `max` to cap them. `itemClassName` rides
// each chip so a surface keeps its own visibility hooks (e.g. the Feed's
// dense-grid `display:none`). `hrefForTag` gets both the authored label and the
// folded key so hrefs use the canonical filter while the chip still displays
// original case.
export const TagChips = ({
  tags,
  max,
  itemClassName,
  hrefForTag,
  onOpenTag,
}: {
  tags: readonly string[]
  max?: number
  itemClassName?: string
  hrefForTag?: (tag: string, foldedTag: string) => string | undefined
  onOpenTag?: (foldedTag: string) => void
}) => {
  const visibleTags = max == null ? tags : tags.slice(0, max)
  return (
    <>
      {visibleTags.map((t) => {
        const folded = foldTag(t)
        return (
          <TagChip
            key={t}
            tag={t}
            foldedTag={folded}
            href={hrefForTag?.(t, folded)}
            onOpenTag={onOpenTag}
            className={itemClassName}
          />
        )
      })}
    </>
  )
}
