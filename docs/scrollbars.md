# Scrollbars: auto-hide + inset between glass (#176)

Scrollbars in Notarium are a **global canon** (#59 HARDENING): a single recipe in
`packages/web/src/styles/base.scss`, nothing gets scattered across modules. Task #176
took it "to pro" in one aesthetic wave together with the glass #72:

1. **Auto-hide-on-idle** — a thin translucent thumb smoothly fades out after idle and
   returns on scroll / near the edge.
2. **Inset between glass panels** — the bar lives strictly in the gap between the top
   and bottom glass chrome, without blind hit-zones; the content meanwhile keeps scrolling
   away (blurring) under the glass.

WebKit-first by design (the whole mechanism sits on `::-webkit-scrollbar-*`). Firefox honestly
degrades to a thin native bar (`scrollbar-width/-color`) — without fade or inset.

## Model — two CSS variables, both with a "flat" default

An untouched scroller looks exactly as before; a surface **optionally** enables the
behavior by setting the variable on itself:

| Variable | Default | Who writes | What it does |
|---|---|---|---|
| `--sb-op` | `1` (visible) | `useAutoHideScrollbars` per-frame | thumb opacity 0→1 (fade) |
| `--sb-inset-top` / `--sb-inset-bottom` | `0px` | SCSS/inline surfaces | height of end-stubs = height of the glass above/below the scroller |

`base.scss` multiplies the thumb color by `--sb-op` via `color-mix`, and feeds the inset
values to transparent `::-webkit-scrollbar-button` (see below). The color tokens —
`--scrollbar-thumb` (a translucent `--border-strong`) and `--scrollbar-thumb-hover`
(`--text-faint`) in `tokens.scss` — re-resolve by theme on their own.

## Auto-hide — a single global controller

`libs/hooks/useAutoHideScrollbars` is mounted **once** in `AppShell`. No per-component
wiring: `scroll` doesn't bubble, but a **capture** listener on `document` catches it on the
path down — so a single function covers any scroller, including a future one and CodeMirror's
internal scroll.

- **scroll** → thumb at full (`--sb-op=1`), the idle timer is recharged.
- **idle ~1.4s** → rAF fade of `--sb-op` 1→0 (smoothly, ~220ms).
- **reveal near the edge** → throttled `pointermove`: we show it **only** when the pointer
  is in the right gutter strip (≤22px from the right edge), and not over the content — the bar
  doesn't nag while reading.
- **`prefers-reduced-motion: reduce`** → the controller is a no-op, `base.scss` pins the thumb
  visible (without fade).

**Why per-frame JS and not a CSS transition:** WebKit **does not animate**
`::-webkit-scrollbar-thumb` (it recolors instantly, as on `:hover`). Smoothness comes
only from per-frame writing of `--sb-op` — exactly the `useScrollGlass` (#185) pattern for
`--glass-lift`. One philosophy of scroll-reactivity across the whole project.

## Inset — transparent `::-webkit-scrollbar-button`

The task's key finding: the content and the native scrollbar live on the SAME container, so
insetting the bar without insetting the content is "natively nontrivial". The solution is to
**touch neither the content, nor the container, nor the virtualization**, but to reserve the
ends of the track with transparent stub-buttons: `::-webkit-scrollbar-button` with the height
of the glass plate. The thumb physically cannot drive into the zone under the glass → the bar
is entirely in the gap and grabbable, while the content still scrolls away under the glass.
Pure CSS, zero JS, zero layout shifts.

Single-button model: only the two OUTER ends carry the height
(`:vertical:start:decrement` at the top, `:vertical:end:increment` at the bottom); the inner
double-button pseudos and all horizontal ones — `display:none`.

**Inheritance is blocked.** `--sb-inset-*` and `--sb-op` are ordinary (inherited) custom
properties, but inset/fade must affect ONLY the opt-in scroller. Otherwise a nested
scroller (a popup list inside an inset surface — the editor combo-menu, CodeMirror
autocomplete) would inherit the ancestor's inset and get a phantom stub. That's why
`base.scss` resets `* { --sb-op: 1; --sb-inset-top: 0px; --sb-inset-bottom: 0px }`:
the value set by a surface applies to ITS own scrollbar (its
`::-webkit-scrollbar` pseudo reads it directly), while descendants fall back to the default
rather than inheriting. `@property{inherits:false}` does NOT fit here — it would "starve" the
webkit pseudos that read the value through inheritance from their own element.

### Who sets the inset (single source — next to `padding-top`)

| Surface | top | bottom | File |
|---|---|---|---|
| `.content-scroll` (PageFrame) | `--chrome-h` (52px) | — | `PageFrame.module.scss` |
| `.editing-scroll` (editor) | inherits | — (layout only) | `DocumentLayout.module.scss` |
| `.editor-status-inset` (editor, NOT Preview) | inherits | `--editor-statusbar-h` (30px) | `DocumentLayout.module.scss` |
| `.rail-scroll` (Sidebar) | `--panel-head-h` (measured) | — | `Sidebar.module.scss` |
| `.aside-body`, `.group-body` | `--chrome-h` | — | `Aside/AsideGroups.module.scss` |
| TrashPage `.scroll` | measured `topH` | measured `footH` | `TrashPage.tsx` (inline) |

Invariant: `--sb-inset-*` is taken from the SAME token/measurement as the surface's
`padding-top`/`padding-bottom` — they must not drift apart. The editor's bottom inset is
split off into `.editor-status-inset` and is applied only when the status bar actually exists
(`isEditing && !preview`) — in Preview the plate is not rendered, the inset is removed,
otherwise there would be a phantom stub at the bottom. Surfaces without a glass overlap
(`.dialog-message`, `.gsearch-body`) do not set an inset.

## Verification pitfall (not theater)

The stand's headless Chromium **does not render the custom WebKit scrollbar visibly** and does
not return `getComputedStyle` for its pseudo-elements. This means **fade/inset cannot be
verified either visually or programmatically in headless** — the final visual acceptance runs
on a real browser. In e2e (`test/e2e/scrollbar-autohide.spec.ts`) the observable CONTRACT is
verified: the `--sb-op` value (snap on scroll, fade on idle, reveal near the edge vs its
absence over the content) and `--sb-inset-*` by surface.

## Seed for acceptance

`make seed CASE=scrollbars` (`test/cases/cases/scrollbars.ts`, #176) — a single stand that
overflows ALL load-bearing scroll surfaces at once: a deep tree-rail, a long note
(reader + editor with two glass plates), a populated feed, a dense graph with its
search/filter asides, a full trash. This way all scrolling surfaces can be reviewed in one
pass, without re-seeding for each.
