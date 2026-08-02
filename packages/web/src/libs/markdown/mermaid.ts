import DOMPurify from 'dompurify'
// Type-only import — erased at compile, so it pulls NOTHING into the bundle. The
// runtime library is loaded lazily via the dynamic import() in loadMermaid below.
import type { Mermaid } from 'mermaid'

// Renders ```mermaid fenced blocks into inline SVG diagrams (#236). The markdown
// pipeline leaves a mermaid fence as `<pre><code class="language-mermaid">` (an
// unknown highlighter language is returned verbatim, highlight.ts), so this is a
// POST-render DOM pass over the rendered `.markdown` surface — NOT part of the
// synchronous renderMarkdown: mermaid.render is async and yields SVG we must
// sanitise before it touches the page. Driven from useMarkdownEnhance (Pass 3).
//
// The library is HEAVY (~0.5 MB gz — d3, dagre, cytoscape), so it is pulled via a
// dynamic import() gated on a mermaid block actually being present: Vite/Rollup
// emits it as its own chunk that never reaches the main bundle. loadMermaid caches
// the promise, so N diagrams on a page — or a theme redraw — load it exactly once.

let mermaidPromise: Promise<Mermaid> | null = null

const loadMermaid = (): Promise<Mermaid> => {
  // Cache the promise so N diagrams / a redraw load the chunk once. Reset the cache on
  // rejection — a rejected promise is still truthy, so without this a single transient
  // import failure (offline blip) would latch and disable diagrams for the whole tab
  // lifetime; nulling it lets a later attempt retry.
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid')
      .then((m) => m.default)
      .catch((err) => {
        mermaidPromise = null
        throw err
      })
  }

  return mermaidPromise
}

// Match `language-mermaid` case-insensitively. marked-highlight preserves the fence
// tag's case, and CSS class selectors are case-sensitive, so a ```Mermaid fence would
// slip past a `.language-mermaid` selector even though ```JS etc. highlight fine (hljs
// lowercases internally). Shared with useMarkdownEnhance's Pass-1 skip so they never drift.
export const isMermaidPre = (pre: Element): boolean => {
  const code = pre.querySelector(':scope > code[class]')
  return !!code && /(?:^|\s)language-mermaid(?:\s|$)/i.test(code.className)
}

// Unique, CSS-id-valid target per render — mermaid injects a temporary measuring
// node keyed by this id. Module-global so ids never collide across surfaces/redraws.
let renderSeq = 0

// Mermaid bakes concrete colours into the SVG at render time (it can't read live CSS
// vars), so the theme is resolved from OUR design tokens on every draw and diagrams
// are redrawn on a light/dark flip (see retheme). We use the 'base' theme — the one
// mermaid designed FOR customisation: it DERIVES every secondary colour from the ones
// we set, so a full token-mapped palette stays internally consistent (the built-in
// default/dark themes are NOT meant to be recoloured — an earlier attempt to override
// their variables broke node-label contrast). The rule that keeps text legible is to
// pin each fill/border to its matching *TextColor explicitly, so nothing is left to a
// contrast guess. `darkMode` tells base which way to derive the rest.
const mermaidConfig = () => {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  const dark = document.documentElement.dataset.theme === 'dark'
  // Both the top-level fontFamily (drives text layout/measurement) and
  // themeVariables.fontFamily (feeds base-theme derivation) are consumed by mermaid;
  // compute once so the two can't drift.
  const fontFamily = v('--reading-font') || 'inherit'
  return {
    startOnLoad: false,
    // 'strict' is mermaid's own hardening: no click-handlers / injected JS, and its
    // own DOMPurify pass on labels. We ALSO sanitise the returned SVG below — defence
    // in depth, the issue's non-negotiable (never open XSS through a diagram).
    securityLevel: 'strict' as const,
    // htmlLabels stays at mermaid's default (true): labels are HTML in a
    // <foreignObject>, which mermaid centres and pads consistently across every shape
    // (SVG <text> labels sit tight and off-centre by shape). The sanitiser below is
    // configured to keep the foreignObject + its XHTML namespace so the labels survive.
    // No fontSize override — it desyncs mermaid's label-box measurement from the drawn
    // text; the reading font is safe (measured and drawn the same).
    flowchart: { useMaxWidth: true, curve: 'basis' as const },
    theme: 'base' as const,
    fontFamily,
    themeVariables: {
      darkMode: dark,
      background: v('--bg'),
      fontFamily,
      // Nodes: a soft neutral surface with a quiet hairline border and full-strength
      // text — calm and legible, no accent shouting (the border width/round are tuned
      // in markdown.scss). Keeping colours neutral lets the CONTENT carry the meaning.
      primaryColor: v('--bg-hover'),
      primaryTextColor: v('--text'),
      primaryBorderColor: v('--border-strong'),
      // Alternate / nested surfaces (subgraph fills, secondary node classes).
      secondaryColor: v('--bg-list'),
      secondaryTextColor: v('--text'),
      secondaryBorderColor: v('--border-strong'),
      tertiaryColor: v('--bg-hover'),
      tertiaryTextColor: v('--text'),
      tertiaryBorderColor: v('--border-strong'),
      // Edges + any diagram text outside a node.
      lineColor: v('--text-dim'),
      textColor: v('--text'),
      // Edge labels (flowchart "Yes"/"No") sit on the page, not in a grey chip.
      edgeLabelBackground: v('--bg'),
      // Subgraph containers.
      clusterBkg: v('--bg-list'),
      clusterBorder: v('--border'),
      titleColor: v('--text'),
      // Sequence-diagram notes.
      noteBkgColor: v('--bg-hover'),
      noteTextColor: v('--text'),
      noteBorderColor: v('--border-strong'),
    },
  }
}

const sanitizeSvg = (svg: string): string => {
  // Defence-in-depth on top of mermaid's own strict-mode DOMPurify pass — with the
  // SAME options mermaid uses, so we don't undo its work. Relies on DOMPurify's default
  // allow-list (HTML + SVG + SVG-filters — no USE_PROFILES); the key addition is
  // `HTML_INTEGRATION_POINTS: { foreignobject: true }`: it tells DOMPurify to sanitise
  // a <foreignObject>'s children as HTML (not SVG), so the <div>/<span> node labels
  // survive — without it they're treated as invalid SVG and stripped, blanking every
  // node. `foreignObject` + `style` (mermaid's inlined colours) are allow-listed, and
  // `dominant-baseline` kept. DOMPurify still strips <script>/on*/javascript: — no JS.
  return DOMPurify.sanitize(svg, {
    ADD_TAGS: ['foreignObject', 'style'],
    ADD_ATTR: ['dominant-baseline'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
  })
}

// First line of a mermaid error, capped — the caption must stay a one-liner even for
// mermaid's multi-line parse dumps. Exported for unit coverage of the three branches.
export const errText = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err)
  return (msg.split('\n')[0] || 'invalid diagram').slice(0, 200)
}

export type MermaidController = { retheme: () => void; dispose: () => void }

type Block = { pre: HTMLElement; src: string; figure: HTMLElement | null; state?: 'ok' | 'error' }

// Replace the source <pre> with a <figure> we own, the FIRST time a block draws (the
// caller sets data-state right after). Done here (inside the async draw, after import
// resolves) rather than up-front so React StrictMode's synchronous mount→unmount→mount
// stays clean: the untouched <pre> is still queryable on the second mount, and only the
// surviving controller (the disposed one bails before this) mutates the DOM.
const adopt = (block: Block): HTMLElement => {
  const fig = document.createElement('figure')
  fig.className = 'md-mermaid'
  block.pre.replaceWith(fig)
  block.figure = fig
  return fig
}

// Honest fallback for a diagram that fails to parse/render (issue: show the source or
// error, never a blank): keep the source visible as a code block under a short error
// caption, so the note stays readable and the author can see what to fix.
const showError = (block: Block, err: unknown): void => {
  const fig = block.figure ?? adopt(block)
  fig.dataset.state = 'error'
  fig.replaceChildren()
  const caption = document.createElement('div')
  caption.className = 'md-mermaid-error'
  caption.textContent = `Diagram error: ${errText(err)}`
  const pre = document.createElement('pre')
  const code = document.createElement('code')
  code.className = 'language-mermaid'
  code.textContent = block.src
  pre.appendChild(code)
  fig.append(caption, pre)
}

// Render every mermaid block under `root`. Returns a controller to redraw on a theme
// flip and to dispose (cancel pending async writes), or null when there is no mermaid
// block at all — the caller then skips the heavy import and the theme observer.
export const renderMermaid = (root: HTMLElement): MermaidController | null => {
  const blocks: Block[] = Array.from(root.querySelectorAll<HTMLElement>('pre'))
    .filter(isMermaidPre)
    .map((pre) => ({
      pre,
      src: (pre.querySelector('code')?.textContent ?? '').trim(),
      figure: null,
    }))
    // An empty fence isn't a diagram — leave its <pre> inert rather than flashing a
    // red "no diagram type" error at the author.
    .filter((block) => block.src !== '')

  if (!blocks.length) {
    return null
  }

  let disposed = false
  // Generation guard: each draw() (initial or a retheme) bumps `gen` and captures it;
  // a draw only writes to the DOM while it is still the latest. So a theme flip mid-
  // render can't let an older, stale-theme render land after the newer one (out-of-
  // order write), and concurrent draws don't double-write.
  let gen = 0

  const draw = async () => {
    const myGen = ++gen
    let mermaid: Mermaid

    try {
      mermaid = await loadMermaid()
    } catch {
      return // chunk failed to load (offline / network) — leave the code blocks as-is
    }
    if (disposed || myGen !== gen) {
      return
    }
    mermaid.initialize(mermaidConfig())
    for (const block of blocks) {
      if (disposed || myGen !== gen) {
        return
      }
      if (block.state === 'error') {
        continue
      } // a bad source never becomes valid — skip on redraw
      try {
        // parse validates syntax and mutates no DOM; render draws to a detached node.
        await mermaid.parse(block.src)
        const { svg } = await mermaid.render(`md-mermaid-${renderSeq++}`, block.src)

        if (disposed || myGen !== gen) {
          return
        }
        const fig = block.figure ?? adopt(block)
        fig.dataset.state = 'ok'
        fig.innerHTML = sanitizeSvg(svg)
        block.state = 'ok'
      } catch (err) {
        if (disposed || myGen !== gen || block.state === 'ok') {
          continue
        }
        showError(block, err)
        block.state = 'error'
      }
    }
  }

  void draw()
  return {
    retheme: () => {
      if (!disposed) {
        void draw()
      }
    },
    dispose: () => {
      disposed = true
    },
  }
}
