import { type RefObject, useEffect } from 'react'
import { useCopy } from '../../core/Toast'
import { isMermaidPre, renderMermaid } from './mermaid'

// Post-render DOM enhancements for a rendered `.markdown` surface (#235). The body
// is a raw HTML string injected via dangerouslySetInnerHTML, so React doesn't own
// these nodes — this hook is the one place we reach into them after render. It runs
// three passes: a copy button on each code block, scroll-edge fades on tables, and
// mermaid diagrams (#236). It's the natural home for future post-render features on
// the same surface (e.g. #237 math). Reused by every render surface that opts in
// (reader + history + editor preview).
//
// `deps` is the rendered-html string: React only rewrites the container's innerHTML
// when __html changes (wiping our injected nodes / listeners), so re-running then
// re-applies to the fresh DOM. Every pass fully reverts in cleanup so it's
// idempotent under React StrictMode's mount→unmount→mount double-invoke.

const COPY_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const CHECK_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

export const useMarkdownEnhance = (ref: RefObject<HTMLElement | null>, deps: string): void => {
  const copy = useCopy()
  useEffect(() => {
    const root = ref.current

    if (!root) {
      return
    }
    const cleanups: Array<() => void> = []

    // ── Pass 1: copy button on each fenced code block ──────────────────────────
    // Each <pre> is moved into a relative `.md-code` wrapper and the button placed
    // in the WRAPPER, not the <pre>: a wide block scrolls horizontally, and an
    // absolutely-positioned child of the scroll box would sit at the far end of the
    // scrolled content (invisible until you scroll right). The wrapper doesn't
    // scroll, so the button stays pinned to the visible corner.
    const timers = new Set<number>()
    const wrappers: HTMLDivElement[] = []
    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('md-code')) {
        return
      } // already wrapped
      // A mermaid diagram source (#236) is turned into an SVG by Pass 3 — it's not a
      // copyable code block, so skip it here (no wrapper, no copy button). Shared
      // predicate with renderMermaid so the two stay in sync (and case-insensitive).
      if (isMermaidPre(pre)) {
        return
      }
      const wrap = document.createElement('div')
      wrap.className = 'md-code'
      pre.replaceWith(wrap)
      wrap.appendChild(pre)

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'md-copy'
      btn.title = 'Copy code'
      btn.setAttribute('aria-label', 'Copy code')
      btn.innerHTML = COPY_SVG
      btn.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        // textContent of the <code> is the raw source — hljs token <span>s carry no
        // text of their own, and the button lives outside <pre>, so it's clean.
        const code = pre.querySelector('code')?.textContent ?? pre.textContent ?? ''
        copy(code, { label: 'code' })
        btn.dataset.copied = 'true'
        btn.innerHTML = CHECK_SVG
        const t = window.setTimeout(() => {
          delete btn.dataset.copied
          btn.innerHTML = COPY_SVG
          timers.delete(t)
        }, 1400)
        timers.add(t)
      })
      wrap.appendChild(btn)
      wrappers.push(wrap)
    })
    cleanups.push(() => {
      timers.forEach((t) => window.clearTimeout(t))
      // Unwrap: put each <pre> back where its wrapper stood, then drop the wrapper.
      // Restores the pre-hook DOM so a re-run can't double-wrap (StrictMode).
      wrappers.forEach((wrap) => {
        const pre = wrap.querySelector(':scope > pre')

        if (pre) {
          wrap.replaceWith(pre)
        } else {
          wrap.remove()
        }
      })
    })

    // ── Pass 2: table scroll-edge fades ────────────────────────────────────────
    // A wide table clips at its wrapper; the edges dissolve into the page, so it's
    // not obvious it scrolls. The CSS draws an edge fade on each side of `.md-table`;
    // here we flip data-at-start / data-at-end by scroll offset so a fade shows
    // only where content is actually off-screen (and neither shows when it fits).
    root.querySelectorAll<HTMLElement>('.md-table').forEach((fig) => {
      const wrap = fig.querySelector<HTMLElement>('.md-table-wrap')

      if (!wrap) {
        return
      }
      const update = () => {
        const max = wrap.scrollWidth - wrap.clientWidth
        fig.dataset.atStart = String(wrap.scrollLeft <= 1)
        fig.dataset.atEnd = String(wrap.scrollLeft >= max - 1)
      }
      update()
      wrap.addEventListener('scroll', update, { passive: true })
      // Re-measure when the column width changes (window resize, panel toggle).
      const ro = new ResizeObserver(update)
      ro.observe(wrap)
      cleanups.push(() => {
        wrap.removeEventListener('scroll', update)
        ro.disconnect()
        delete fig.dataset.atStart
        delete fig.dataset.atEnd
      })
    })

    // ── Pass 3: mermaid diagrams (#236) ────────────────────────────────────────
    // A ```mermaid fence arrives as <pre><code class="language-mermaid"> (Pass 1
    // skipped it). renderMermaid lazily pulls the heavy lib ONLY when such a block
    // exists and swaps each <pre> for a sanitised SVG; it returns null otherwise, so
    // a mermaid-free note pays nothing (no import, no observer).
    const mermaid = renderMermaid(root)

    if (mermaid) {
      // Mermaid bakes BOTH the theme colours AND the reading font into the SVG at draw
      // time (mermaidConfig), so redraw when either runtime knob flips on <html> — a
      // light/dark theme change or a reading-font change — to keep the diagram in step
      // with the surrounding prose. (Reading SIZE bakes nothing — no fontSize is set.)
      const restyleObserver = new MutationObserver(() => mermaid.retheme())
      restyleObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme', 'data-reading-font'],
      })
      cleanups.push(() => {
        restyleObserver.disconnect()
        mermaid.dispose()
      })
    }

    return () => cleanups.forEach((fn) => fn())
  }, [deps, copy, ref])
}
