import { type ReactNode } from 'react'

// Minimal line icons (24x24, currentColor) — keeps the bundle dependency-free.
// `className` is forwarded to the <svg> so callers can style/animate the glyph
// itself (e.g. rotating a chevron via a `.open` class on expand).
type IconProps = { size?: number; className?: string }

const S = ({
  children,
  size = 18,
  className,
}: {
  children?: ReactNode
  size?: number
  className?: string
}) => (
  <svg
    className={className}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
)

export const IconSearch = (p: IconProps) => (
  <S {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </S>
)
export const IconDoc = (p: IconProps) => (
  <S {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </S>
)
// Download (Lucide `download`) — export-to-disk affordance (#105).
export const IconDownload = (p: IconProps) => (
  <S {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="M7 10l5 5 5-5" />
    <path d="M12 15V3" />
  </S>
)
export const IconFolder = (p: IconProps) => (
  <S {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </S>
)
// An expanded folder (Lucide `folder-open`) — the tree's open-folder state.
export const IconFolderOpen = (p: IconProps) => (
  <S {...p}>
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  </S>
)
// A project folder (#13) — Lucide `folder-kanban`. A marked folder an agent can
// address by handle; replaces the folder glyph in the tree (not a side badge).
// When the folder is OPEN it shows IconFolderOpen (kanban has no open variant) —
// the accent tint keeps the project distinction either way.
export const IconFolderKanban = (p: IconProps) => (
  <S {...p}>
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    <path d="M8 10v4" />
    <path d="M12 10v2" />
    <path d="M16 10v6" />
  </S>
)
// A "New folder" action (Lucide `folder-plus`): the folder glyph with a plus.
export const IconFolderPlus = (p: IconProps) => (
  <S {...p}>
    <path d="M12 10v6" />
    <path d="M9 13h6" />
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </S>
)
export const IconChevron = (p: IconProps) => (
  <S {...p}>
    <path d="m9 6 6 6-6 6" />
  </S>
)
// Left/right chevrons (Lucide `chevron-left`/`chevron-right`) — stepper nav like the
// DatePicker's month prev/next, where a literal ‹ › reads clearer than a rotation.
export const IconChevronLeft = (p: IconProps) => (
  <S {...p}>
    <path d="m15 18-6-6 6-6" />
  </S>
)
export const IconChevronRight = (p: IconProps) => (
  <S {...p}>
    <path d="m9 6 6 6-6 6" />
  </S>
)
// "Collapse all" (Lucide `chevrons-down-up`) — the two chevrons point toward each
// other, the file-tree header action that folds every open folder shut (#98).
export const IconCollapse = (p: IconProps) => (
  <S {...p}>
    <path d="m7 4 5 5 5-5" />
    <path d="m7 20 5-5 5 5" />
  </S>
)
// "Refresh" (Lucide `rotate-cw`) — a single circular arrow, the tree header's
// reload action (#98); distinct from the two-arrow sync glyph (IconSync).
export const IconRefresh = (p: IconProps) => (
  <S {...p}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
    <path d="M21 3v5h-5" />
  </S>
)
export const IconPlus = (p: IconProps) => (
  <S {...p}>
    <path d="M12 5v14M5 12h14" />
  </S>
)
export const IconEdit = (p: IconProps) => (
  <S {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </S>
)
export const IconHistory = (p: IconProps) => (
  <S {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v4h4" />
    <path d="M12 7v5l3 3" />
  </S>
)
// Scroll-text (Lucide `scroll-text`) — the context constructor: a curated scroll of
// what the agent carries (#243).
export const IconScrollText = (p: IconProps) => (
  <S {...p}>
    <path d="M15 12h-5" />
    <path d="M15 8h-5" />
    <path d="M19 17V5a2 2 0 0 0-2-2H4" />
    <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />
  </S>
)
export const IconTrash = (p: IconProps) => (
  <S {...p}>
    <path d="M3 6h18" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </S>
)
export const IconCheck = (p: IconProps) => (
  <S {...p}>
    <path d="M20 6 9 17l-5-5" />
  </S>
)
export const IconStar = (p: IconProps) => (
  <S {...p}>
    <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z" />
  </S>
)
export const IconStarFilled = (p: IconProps) => (
  <S {...p}>
    <path
      d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"
      fill="currentColor"
    />
  </S>
)
// Archive box (#110): a lidded box — the empty-state glyph on the Trash → Spaces tab.
export const IconArchive = (p: IconProps) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </S>
)
export const IconMinus = (p: IconProps) => (
  <S {...p}>
    <path d="M5 12h14" />
  </S>
)
export const IconSync = (p: IconProps) => (
  <S {...p}>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </S>
)
export const IconX = (p: IconProps) => (
  <S {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </S>
)
export const IconCrosshair = (p: IconProps) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </S>
)
export const IconEye = (p: IconProps) => (
  <S {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </S>
)
// Typewriter mode (#118): centered text lines with the active (middle) one carrying
// a caret tick — reads as "the line you write stays centered", the typewriter idea.
export const IconTypewriter = (p: IconProps) => (
  <S {...p}>
    <path d="M5 6h14M5 18h14M7 10h10" />
    <path d="M7.5 14h9" />
    <path d="M12 12.5v3" />
  </S>
)
export const IconEyeOff = (p: IconProps) => (
  <S {...p}>
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7" />
    <path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
    <path d="m2 2 20 20" />
  </S>
)
export const IconBrain = (p: IconProps) => (
  <S {...p}>
    <path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 1 5 3 3 0 0 0 5 1.5V5.5A3 3 0 0 0 9 3Z" />
    <path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-1 5 3 3 0 0 1-5 1.5V5.5A3 3 0 0 1 15 3Z" />
  </S>
)
// Agents section glyph (#169): Lucide `bot` analog — a neutral agent face, not
// a message/memory bubble.
export const IconBot = (p: IconProps) => (
  <S {...p}>
    <path d="M12 8V4H8" />
    <rect x="4" y="8" width="16" height="12" rx="2" />
    <path d="M2 14h2" />
    <path d="M20 14h2" />
    <path d="M9 13v2" />
    <path d="M15 13v2" />
  </S>
)
// Agent-memory glyph (#169): Lucide `bot-message-square` analog — use where the
// UI means remembered/recorded memory, not the Agents section itself.
export const IconBotMessage = (p: IconProps) => (
  <S {...p}>
    <path d="M12 6V2H8" />
    <path d="m8 18-4 4V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2Z" />
    <path d="M2 12h2" />
    <path d="M9 11v2" />
    <path d="M15 11v2" />
    <path d="M20 12h2" />
  </S>
)
// The personal-layer / Agents glyph (#13): an AI "sparkle" — distinct from the
// brand (IconBrain) and from Files (IconLayers).
export const IconSparkles = (p: IconProps) => (
  <S {...p}>
    <path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4L12 3Z" />
    <path d="M18.5 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8 .8-2Z" />
  </S>
)
// A push-pin (#165): the «always-load» / pinned-note glyph — a literal pin, not a
// sparkle (which read as decoration, not "kept in context").
export const IconPin = (p: IconProps) => (
  <S {...p}>
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </S>
)
// lucide `pin-off`: the pin with a slash — the reversible "unpin" action.
export const IconPinOff = (p: IconProps) => (
  <S {...p}>
    <path d="M12 17v5" />
    <path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" />
    <path d="m2 2 20 20" />
    <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
  </S>
)
export const IconSun = (p: IconProps) => (
  <S {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </S>
)
export const IconMoon = (p: IconProps) => (
  <S {...p}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
  </S>
)
export const IconClock = (p: IconProps) => (
  <S {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </S>
)
// A calendar (Lucide `calendar`) — the DatePicker trigger glyph.
export const IconCalendar = (p: IconProps) => (
  <S {...p}>
    <path d="M8 2v4M16 2v4" />
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M3 10h18" />
  </S>
)
// Feed: a post card — image block over two text lines, like a social feed item.
export const IconFeed = (p: IconProps) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <rect x="6.5" y="7" width="11" height="5" rx="1" />
    <path d="M7 15.5h10M7 18h6" />
  </S>
)
// Card-size / density toggles: one big tile (L) → 2×2 (M) → 3×3 (S). More cells
// reads as "smaller, denser cards" (more columns).
export const IconDensityL = (p: IconProps) => (
  <S {...p}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
  </S>
)
export const IconDensityM = (p: IconProps) => (
  <S {...p}>
    <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.3" />
    <rect x="13" y="3.5" width="7.5" height="7.5" rx="1.3" />
    <rect x="3.5" y="13" width="7.5" height="7.5" rx="1.3" />
    <rect x="13" y="13" width="7.5" height="7.5" rx="1.3" />
  </S>
)
export const IconDensityS = (p: IconProps) => (
  <S {...p}>
    <rect x="3.5" y="3.5" width="4.3" height="4.3" rx="1" />
    <rect x="9.8" y="3.5" width="4.3" height="4.3" rx="1" />
    <rect x="16.2" y="3.5" width="4.3" height="4.3" rx="1" />
    <rect x="3.5" y="9.8" width="4.3" height="4.3" rx="1" />
    <rect x="9.8" y="9.8" width="4.3" height="4.3" rx="1" />
    <rect x="16.2" y="9.8" width="4.3" height="4.3" rx="1" />
    <rect x="3.5" y="16.2" width="4.3" height="4.3" rx="1" />
    <rect x="9.8" y="16.2" width="4.3" height="4.3" rx="1" />
    <rect x="16.2" y="16.2" width="4.3" height="4.3" rx="1" />
  </S>
)
export const IconLink = (p: IconProps) => (
  <S {...p}>
    <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
  </S>
)
export const IconGraph = (p: IconProps) => (
  <S {...p}>
    <circle cx="5" cy="6" r="2.4" />
    <circle cx="18" cy="5" r="2.4" />
    <circle cx="12" cy="18" r="2.4" />
    <path d="M7 7.2 10.6 16M16.4 6.8 13.2 16.2M7.1 6.4 15.7 5.2" />
  </S>
)
// Toggle the right panel: a framed area with its right column partitioned off.
export const IconPanelRight = (p: IconProps) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </S>
)
// Toggle the left panel: a framed area with its left column partitioned off.
export const IconPanelLeft = (p: IconProps) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </S>
)
// Settings (gear).
export const IconSettings = (p: IconProps) => (
  <S {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
  </S>
)
// Open in a new tab (box with an out-arrow).
export const IconExternal = (p: IconProps) => (
  <S {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 10 14" />
    <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
  </S>
)
// Overflow menu (vertical three-dots).
export const IconMore = (p: IconProps) => (
  <S {...p}>
    <circle cx="12" cy="5" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="19" r="1.4" fill="currentColor" stroke="none" />
  </S>
)
export const IconDocPage = (p: IconProps) => (
  <S {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13h6M9 17h4" />
  </S>
)
// Drag handle (lucide `grip-vertical`): two columns of dots — the "grab to reorder"
// affordance on a draggable list row (#210).
export const IconGrip = (p: IconProps) => (
  <S {...p}>
    <circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none" />
  </S>
)
export const IconLayers = (p: IconProps) => (
  <S {...p}>
    <path d="m12 2 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12 9 5 9-5" />
    <path d="m3 17 9 5 9-5" />
  </S>
)
// Workspace / space — an isometric cube ("a self-contained space"). Deliberately
// unique: not the 2×2 grid (that reads identically to the feed's density toggle)
// and not Files' flat stacked layers.
export const IconWorkspace = (p: IconProps) => (
  <S {...p}>
    <path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z" />
    <path d="M3.5 7 12 11.5 20.5 7" />
    <path d="M12 11.5V21.5" />
  </S>
)
export const IconCopy = (p: IconProps) => (
  <S {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </S>
)
// Project marker (#13): a small rhombus that tags a folder the user has marked
// as a project. A distinct mark, not a second folder — the row already carries
// IconFolder; this is the "this one is addressable" badge an agent resolves by
// handle.
export const IconProject = (p: IconProps) => (
  <S {...p}>
    <path d="M12 3 20.5 12 12 21 3.5 12z" />
  </S>
)
// ---- Auth/account glyphs (#10) -------------------------------------------- //
export const IconUser = (p: IconProps) => (
  <S {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M5 21a7 7 0 0 1 14 0" />
  </S>
)
export const IconUsers = (p: IconProps) => (
  <S {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M3 20a6 6 0 0 1 12 0" />
    <path d="M16 4.6a3.5 3.5 0 0 1 0 6.8" />
    <path d="M17.5 14.6a6 6 0 0 1 3.5 5.4" />
  </S>
)
// A PAT — the bearer key an agent carries (#21).
export const IconKey = (p: IconProps) => (
  <S {...p}>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m11 12 9-9" />
    <path d="M17 5l3 3" />
    <path d="M14 8l2 2" />
  </S>
)
export const IconLogout = (p: IconProps) => (
  <S {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </S>
)

// ---- Editor formatting toolbar icons ------------------------------------- //
export const IconBold = (p: IconProps) => (
  <S {...p}>
    <path d="M14 12a4 4 0 0 0 0-8H6v8" />
    <path d="M15 20a4 4 0 0 0 0-8H6v8z" />
  </S>
)
export const IconItalic = (p: IconProps) => (
  <S {...p}>
    <path d="M19 4h-9M14 20H5M15 4 9 20" />
  </S>
)
export const IconStrikethrough = (p: IconProps) => (
  <S {...p}>
    <path d="M16 4H9a3 3 0 0 0-2.83 4" />
    <path d="M14 12a4 4 0 0 1 0 8H6" />
    <path d="M4 12h16" />
  </S>
)
export const IconCode = (p: IconProps) => (
  <S {...p}>
    <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
  </S>
)
export const IconHeading = (p: IconProps) => (
  <S {...p}>
    <path d="M6 12h12M6 20V4M18 20V4" />
  </S>
)
export const IconList = (p: IconProps) => (
  <S {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </S>
)
export const IconListOrdered = (p: IconProps) => (
  <S {...p}>
    <path d="M10 6h11M10 12h11M10 18h11" />
    <path d="M4 4h1v4M4 8h2" />
  </S>
)
export const IconQuote = (p: IconProps) => (
  <S {...p}>
    <path d="M6 5v14" />
    <path d="M11 7h7M11 12h7M11 17h7" />
  </S>
)
