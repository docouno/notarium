import { type MouseEvent, type ReactNode, useEffect, useMemo, useRef } from 'react'
import { effectiveSlug } from '@notarium/core/slug'
import { TagChips } from '../../core/Chips'
import { renderMarkdown, wikiLinkTarget } from '../../libs/markdown/markdown'
import { useMarkdownEnhance } from '../../libs/markdown/useMarkdownEnhance'
import { feedTagRoute, isModifiedClick, noteRouteForClass } from '../../libs/routing/routePaths'
import type { NoteDetailView, NoteView } from '../../libs/wire'
import { resolveKnownWiki } from './resolveKnownWiki'
import styles from './NoteReader.module.scss'

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
    root.querySelectorAll<HTMLAnchorElement>('a[href^="#wiki/"], a[data-wiki-raw]').forEach((a) => {
      // Keep the authored target immutable across classifications. A resolved
      // anchor's href becomes a real route, so href alone cannot drive the next
      // notes update (delete, class change, or slug change).
      const target = a.dataset.wikiRaw ?? wikiLinkTarget(a.getAttribute('href'))

      if (!target) {
        return
      }
      a.dataset.wikiRaw = target
      const match = resolveKnownWiki(target, notes)

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
        a.setAttribute('href', `#wiki/${encodeURIComponent(target)}`)
      }
    })
  }, [html, notes])

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
      // Match the fragment RAW FIRST: marked-footnote percent-encodes the label in
      // BOTH the `<a href="#footnote-…">` and the `<li id="footnote-…">`, so they are
      // equal only in ENCODED form (`[^прим]` → `footnote-%D0%BF…` on both sides) and
      // decoding first would miss it. A HEADING id is the opposite — the raw core slug,
      // non-ASCII since #296, against an href marked percent-encodes — so the decoded
      // form is tried second, guarded against the URIError a lone `%` would throw.
      // `#wiki/` hrefs carry data-wiki and are handled above; the guard also covers
      // the pre-effect race where a wikilink's href is still raw.
      e.preventDefault()
      const id = (a.getAttribute('href') || '').slice(1)
      const find = (candidate: string) =>
        candidate ? ref.current?.querySelector(`[id="${CSS.escape(candidate)}"]`) : null
      // RAW first (the footnote case above), then DECODED: a heading id is the core
      // slug, which since #296 keeps the letters of a script we cannot romanise — and
      // marked percent-encodes the href it generates for `[jump](#第三季度规划)`, so the
      // two sides meet only after decoding. Encoded-first keeps footnotes working;
      // decoding second is what makes a non-ASCII heading anchor land at all.
      let target = find(id)

      if (!target && id) {
        try {
          target = find(decodeURIComponent(id))
        } catch {
          // A lone `%` is not an escape — the raw lookup above was the honest answer.
        }
      }
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else if (a.href) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    }
  }

  return (
    <article className="doc">
      <header className="doc-head">
        <h1 className="doc-title">{note.documentTitle || note.title}</h1>
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
