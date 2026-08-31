import { forwardRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { isModifiedClick } from '../../libs/routing/routePaths'

// CardLink — a note card that IS a real link (#32/#13). Plain click opens the
// note in-app via `onOpen` (router navigation, the unsaved-edits blocker covers
// it); ⌘/ctrl/middle/shift-click falls through to the browser natively (new tab),
// so a card behaves like every other link. Shared by the Feed cards and the
// Memory cards so the open-vs-modifier-click semantics live in ONE place. `href`
// is the real destination (for the native fallthrough); `onOpen` does the in-app
// open when the card owns navigation. A card hosted by NoteReader may instead publish
// `dataNoteRoute` and let its existing delegated route handler own the plain click.
// The ref forwards to the <a> (the Feed uses it for in-view preview loading).
export const CardLink = forwardRef<
  HTMLAnchorElement,
  {
    href: string | null
    onOpen?: () => void
    className?: string
    testId?: string
    dataId?: string
    /** Stable note id for a parent reader's delegated SPA navigation. */
    dataNoteRoute?: string
    /** Tooltip + accessible name — for an icon-only link (a card's open zone) that
     *  has no visible text of its own. */
    title?: string
    ariaLabel?: string
    draggable?: boolean
    children: ReactNode
  }
>(
  (
    {
      href,
      onOpen,
      className,
      testId,
      dataId,
      dataNoteRoute,
      title,
      ariaLabel,
      draggable,
      children,
    },
    ref,
  ) => (
    <a
      ref={ref}
      href={href || undefined}
      className={className}
      data-testid={testId}
      data-id={dataId}
      data-note-route={dataNoteRoute}
      title={title}
      aria-label={ariaLabel}
      draggable={draggable}
      onClick={(e: ReactMouseEvent) => {
        if (!onOpen || isModifiedClick(e)) {
          return
        }
        e.preventDefault()
        onOpen()
      }}
    >
      {children}
    </a>
  ),
)
