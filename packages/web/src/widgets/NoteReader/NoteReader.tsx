import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef } from 'react'
import { effectiveSlug, slugify, slugifyPath } from '@notarium/core/slug'
import { TagChips } from '../../core/Chips'
import { renderMarkdown, wikiLinkTarget } from '../../libs/markdown/markdown'
import { useMarkdownEnhance } from '../../libs/markdown/useMarkdownEnhance'
import { feedTagRoute, isModifiedClick, noteRouteForClass } from '../../libs/routing/routePaths'
import type { NoteDetailView, NoteView } from '../../libs/wire'
import styles from './NoteReader.module.scss'

/** A folder's current path ← one of its past paths (#100 phase 3), so a path-form
 *  `[[oldpath/note]]` resolves after the folder was renamed/moved. */
export type FolderAliasPair = { current: string; alias: string }

// Resolve a wikilink target (a title or path-ish reference) to a note in the
// list, by SLUG so it matches the same way the server/graph resolver does (#100,
// the client used to compare raw strings — a divergent channel). Passes mirror
// buildLinkIndex (collision rule current > slug > note-alias > folder-alias): a
// custom slug never out-resolves another live note's title, a renamed note's old
// [[name]] still resolves from cache, and a path-form link survives a FOLDER
// rename (the old path prefix rewrites to the current one). A cache miss falls
// back to the server.
const resolveWiki = (
  target: string | null,
  notes: NoteView[],
  folderAliases: FolderAliasPair[] = [],
) => {
  if (!target) {
    return null
  }
  const want = slugifyPath(target.replace(/\.md$/, ''))

  if (!want) {
    return null
  }
  const last = want.split('/').pop() || want
  const pathOf = (n: NoteView): string => slugifyPath((n.filePath || '').replace(/\.md$/, ''))
  // FOLDER-ALIAS full-path rewrites: an old folder path → its current path (#100 phase 3).
  // Kept SEPARATE from the literal `want` so a live note at the exact path keeps
  // STRICT priority over a historical folder-alias — mirroring buildLinkIndex (Pass 1
  // current > Pass 3 alias) and the server's resolveRow. Collapsing them would let
  // cache order / folder-name alphabetics decide a literal-vs-alias tie. The rewrite
  // still ranks BEFORE the bare last-segment, or an ambiguous filename sibling
  // out-resolves the disambiguating path-form link (the phase 1 flat-OR trap, lifted to
  // folders).
  const aliasPaths: string[] = []

  for (const { current, alias } of folderAliases) {
    const a = slugifyPath(alias)
    const cur = slugifyPath(current)

    if (a && a !== cur && (want === a || want.startsWith(a + '/'))) {
      aliasPaths.push(cur + want.slice(a.length))
    }
  }

  // Pass 1 — the literal full path. Pass 2 — a folder-alias full-path rewrite. Then
  // the bare last segment: filename, then title, then custom slug (#100 phase 1), then
  // note-alias (#100 phase 0) — collision order current > slug > alias, like buildLinkIndex.
  return (
    notes.find((n) => pathOf(n) === want) ??
    notes.find((n) => aliasPaths.includes(pathOf(n))) ??
    notes.find((n) => slugify(pathOf(n).split('/').pop() || '') === last) ??
    notes.find((n) => slugify(n.title) === last) ??
    notes.find((n) => (n.slug ? slugify(n.slug) === last : false)) ??
    notes.find((n) => (n.aliases ?? []).some((a) => slugify(a) === last)) ??
    null
  )
}

type NoteReaderProps = {
  note: NoteDetailView
  notes?: NoteView[]
  onOpenWikiLink?: (id: string) => void
  /** A click on a link whose target the session cache can't resolve. The handler
   *  asks the server (resolve → open) and, only on a genuine miss, offers to
   *  create the note (#65 variant C). The argument is the raw link target. We do
   *  NOT decide "missing" from the client cache here — it's best-effort and would
   *  mistake a real-but-not-yet-loaded note for a ghost. */
  onUnresolvedWiki?: (target: string) => void
  /** Folder path-history (#100 phase 3): lets a path-form `[[oldpath/note]]` resolve
   *  after the folder was renamed. Absent ⇒ no folder-alias pass (the last-segment
   *  fallback still covers the unambiguous case). */
  folderAliases?: FolderAliasPair[]
  /** A tag-chip click (#109): open the tag's feed (`?tag=<folded>`). The shared
   *  tag chip uses it for SPA navigation while preserving native new-tab clicks. */
  onOpenTag?: (tag: string) => void
  /** Optional content that belongs under the rendered note body but inside the
   *  same document column, e.g. a folder page's direct-children summary (#213). */
  afterContent?: ReactNode
}

export const NoteReader = ({
  note,
  notes = [],
  onOpenWikiLink,
  onUnresolvedWiki,
  folderAliases,
  onOpenTag,
  afterContent,
}: NoteReaderProps) => {
  const html = useMemo(() => renderMarkdown(note.content || ''), [note.content])
  const ref = useRef<HTMLDivElement>(null)
  // Post-render enhancements (#235): copy buttons on code blocks + scroll-edge
  // fades on tables. Re-applied whenever the body re-renders (React wipes our
  // injected nodes on innerHTML swap).
  useMarkdownEnhance(ref, html)
  const fm = note.frontmatter || {}
  const tags = (Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : []) as string[]
  // A tag chip links to its feed when we know the note's space (#109). The
  // shared TagChips primitive preserves the authored label but gives href/data-tag
  // the folded filter key (`ML` and `ml` land on the same feed).
  const tagHref = (_tg: string, folded: string): string | undefined =>
    note.space ? feedTagRoute(note.space, folded) : undefined

  // After render, classify each `#wiki/…` wikilink anchor by whether the session
  // cache resolves its target to a known note:
  //  - RESOLVED → stash the note-id on `data-wiki` and rewrite the href to the
  //    real route, so middle / Ctrl / Cmd-click opens it in a new tab natively
  //    while a plain click SPA-navigates.
  //  - CACHE-UNRESOLVED → stash the raw target on `data-wiki-target`. A plain
  //    click hands it to onUnresolvedWiki, which asks the SERVER (the cache is
  //    incomplete — a real but unloaded note must not be mistaken for a ghost):
  //    resolve→open, or create on a genuine miss (#65 variant C). It carries no
  //    real URL, so a new-tab click would land on a dead `#wiki/` href — suppress it.
  useEffect(() => {
    const root = ref.current

    if (!root) {
      return
    }
    root.querySelectorAll<HTMLAnchorElement>('a[href*="#wiki/"]').forEach((a) => {
      const target = wikiLinkTarget(a.getAttribute('href'))

      if (!target) {
        return
      }
      const match = resolveWiki(target, notes, folderAliases)

      if (match) {
        a.dataset.wiki = match.id
        delete a.dataset.wikiTarget
        const route = noteRouteForClass(
          match.id,
          match.class,
          effectiveSlug(match.slug, match.title),
        )

        if (route) {
          a.setAttribute('href', route)
        }
      } else {
        a.dataset.wikiTarget = target
        delete a.dataset.wiki
      }
    })
  }, [html, notes, folderAliases])

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a')

    if (!a) {
      return
    }
    if (a.dataset.wiki !== undefined) {
      if (isModifiedClick(e)) {
        return
      } // let the browser open the route in a new tab
      e.preventDefault()
      onOpenWikiLink?.(a.dataset.wiki)
    } else if (a.dataset.wikiTarget !== undefined) {
      // Cache miss — there's no real URL to open in a new tab, so suppress the
      // dead `#wiki/` href in every case; a plain click resolves-or-creates.
      e.preventDefault()
      if (!isModifiedClick(e)) {
        onUnresolvedWiki?.(a.dataset.wikiTarget)
      }
    } else if (
      (a.getAttribute('href') || '').startsWith('#') &&
      !(a.getAttribute('href') || '').startsWith('#wiki/')
    ) {
      // An in-page fragment anchor (footnote ref / back-ref, #117; also any manual
      // `[x](#id)`). Without this it would hit the `a.href` branch below and open in
      // a new tab. Smooth-scroll to the target WITHIN this reader (scoped to ref so
      // duplicate footnote ids across multiple mounted readers can't cross-resolve).
      // Match the fragment RAW — do NOT decodeURIComponent it: marked-footnote
      // percent-encodes the label in BOTH the `<a href="#footnote-…">` and the
      // `<li id="footnote-…">`, so they're equal only in ENCODED form (`[^прим]` →
      // `footnote-%D0%BF…` on both sides); decoding would miss the target for any
      // non-ASCII / spaced label. Not decoding also means no URIError to guard.
      // `#wiki/` hrefs carry data-wiki and are handled above; the guard also covers
      // the pre-effect race where a wikilink's href is still raw.
      e.preventDefault()
      const id = (a.getAttribute('href') || '').slice(1)
      const target = id ? ref.current?.querySelector(`[id="${CSS.escape(id)}"]`) : null
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (a.href) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
  }

  return (
    <article className="doc">
      <header className={styles.docHead}>
        <h1 className={styles.docTitle}>{note.title}</h1>
        <div className={styles.docMeta}>
          {fm.type ? <span className={styles.pill}>{fm.type as string}</span> : null}
          <TagChips tags={tags} hrefForTag={tagHref} onOpenTag={onOpenTag} />
        </div>
      </header>
      <div
        ref={ref}
        className="markdown"
        onClick={onClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {afterContent}
    </article>
  )
}
