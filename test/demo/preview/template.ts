// The composition. One recipe, several canvases: a wide banner for the top of the README,
// GitHub's social-preview card, and the two OG plates the docs site lays its own text over.
// It is the landing hero's arrangement (notarium-docs `landing.scss` §hero) minus everything
// that belongs to a website — no nav, no CTA buttons (a button painted into an image is a
// button that does not click), no eyebrow telling a reader of the repository that the
// repository is open source.
//
// What is left is the part that does the work: centred type over authored light, and
// the real product below it, wide and cropped by the bottom edge so it reads as the app
// continuing past the frame rather than a picture OF the app.
//
// The light itself is deliberately only light. Five backdrop attempts on the landing
// established that no wallpaper carries a hero on its own; the screenshot does.
//
// PLATES are the same picture with the words left out. The docs site needs a card per page
// in nine languages — 480 of them, all derived from content that lives in that repository —
// so shipping finished images across the repo boundary would mean re-exporting the set on
// every content change. Instead this exports the part that never varies (the light, the
// discs, the product window) and the docs build sets the type. One recipe for the atmosphere,
// still living here; the text stays where the text is authored.

/** Per-canvas knobs. Everything else is shared — see `styles()`. */
export type Canvas = {
  /** Artifact file stem. */
  name: string
  width: number
  height: number
  /** Vertical rhythm and type scale, in CSS px on THIS canvas. */
  padTop: number
  gutter: number
  markSize: number
  wordSize: number
  titleSize: number
  /** Wrap point for the headline, in characters — two lines is the composition. */
  titleWidth: number
  gapBrand: number
  gapShot: number
  /** Product window width, as a share of the canvas. */
  shotWidth: string
}

export const BANNER: Canvas = {
  name: 'banner',
  // 16:9 at a width GitHub never has to scale up: the README column is ~880 CSS px,
  // so this lands at ~2× on a retina display and still crops to a readable shot.
  width: 1200,
  height: 675,
  // The rhythm above the window is also what CHOOSES the crop: every pixel spent up
  // here is a pixel of application the bottom edge takes away. These three are tuned
  // together so the cut lands in the gap after the note's diagram — one line lower and
  // the reader's info callout peeks over the edge as an unexplained blue bar, which
  // draws the eye precisely because it is unreadable.
  padTop: 108,
  gutter: 64,
  markSize: 34,
  wordSize: 25,
  titleSize: 54,
  titleWidth: 22,
  gapBrand: 30,
  gapShot: 68,
  shotWidth: '84%',
}

export const SOCIAL: Canvas = {
  name: 'social-card',
  // GitHub's own recommendation for the repository social preview. It gets shown at
  // thumbnail sizes in link unfurls, so the type runs bigger against the canvas and
  // the window shows less: at 300px wide the headline is the only thing that survives.
  width: 1280,
  height: 640,
  padTop: 86,
  gutter: 72,
  markSize: 34,
  wordSize: 25,
  titleSize: 52,
  titleWidth: 21,
  gapBrand: 26,
  gapShot: 46,
  shotWidth: '80%',
}

/** A background plate: this composition with the type left out, for a consumer that sets
 *  its own words over it (the docs site's per-page OG cards). */
export type Plate = {
  /** Artifact file stem. */
  name: string
  width: number
  height: number
  /** How much of the canvas, from the top, is left free for the consumer's type. Below it
   *  the plate's own content begins, so this is a CONTRACT, not a hint: text set past this
   *  line lands on the product window. Exported alongside the image so the consumer can
   *  check its layout against the plate it actually received rather than a remembered number. */
  textZone: number
  /** Product window under the text zone, as a share of the canvas — null for a plate that
   *  carries only light. */
  shotWidth: string | null
}

/** OG cards are 1200×630 — the size Open Graph documents and every unfurl scales from. */
const OG = { width: 1200, height: 630 } as const

export const OG_HERO: Plate = {
  name: 'og-hero',
  ...OG,
  // Enough for the brand line and a two-line headline at the size the docs card sets it,
  // plus the gap that separates type from product. Same judgement as `padTop` + `gapShot`
  // above, made once here because the plate is what fixes where the window starts.
  //
  // The headline is the card's whole job — in an unfurl it is read at a third of this size,
  // where the difference between 56px and 66px is the difference between a caption and a
  // promise. Every pixel given to the type is a pixel of window the plate gives up, and
  // that trade is settled HERE: the docs card can only set type inside what this reserves.
  textZone: 384,
  shotWidth: '82%',
}

export const OG_DOC: Plate = {
  name: 'og-doc',
  ...OG,
  // No window: a page about self-hosting illustrated with a screenshot of the editor
  // claims something about its content that is not true, and 480 identical cards stop
  // telling one page from another. The whole canvas is the consumer's.
  textZone: OG.height,
  shotWidth: null,
}

export type Composition = {
  canvas: Canvas
  /** The banner's one line of type — README.md's headline (see sources.readHeadline). */
  copy: string
  /** The app's own tokens, as CSS (see sources.readThemeTokens). */
  tokens: string
  font: string
  mark: string
  /** Product still, relative to the HTML file the renderer writes. */
  shot: string
}

export type PlateComposition = {
  plate: Plate
  tokens: string
  font: string
  /** Product still, relative to the HTML file the renderer writes. Ignored by a plate
   *  that carries no window. */
  shot: string
}

// A very low-alpha turbulence tile, the same one the landing uses: it breaks the long
// digital falloff of the gradients, which otherwise bands visibly once the image is
// re-encoded. Decorative only.
const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E" +
  "%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E" +
  "%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

/** The headline comes out of README.md, which is prose: `<`, `>` and `&` are all things
 *  a tagline can legitimately contain ("search in <1s", "notes & agents"). Interpolated
 *  raw they either corrupt the markup or silently swallow the rest of the line. */
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The face, the palette and the canvas box — everything a picture needs before it has
 *  any content. Shared by the artwork and the plates so a re-theme reaches both. */
const base = (c: { width: number; height: number }, tokens: string, font: string): string => `
@font-face {
  font-family: 'Inter';
  src: url(${font}) format('woff2');
  font-weight: 100 900;
  font-style: normal;
  font-display: block;
}

${tokens}

html, body { margin: 0; padding: 0; background: #000; }

.canvas {
  position: relative;
  width: ${c.width}px;
  height: ${c.height}px;
  overflow: hidden;
  background: var(--bg);
  color: var(--text);
  font-family: 'Inter', sans-serif;
  -webkit-font-smoothing: antialiased;
}
`

/** The authored light: the whole atmosphere, identical on every canvas this file makes. */
const atmosphere = (): string => `
/* ── Authored light ──────────────────────────────────────────────────────────
   Its own stacking context, so the noise tile blends with the light and not with
   the product window sitting above it. */
.backdrop {
  position: absolute;
  inset: 0;
  isolation: isolate;
  /* Every layer dissolves downward rather than ending on a line. */
  mask-image: linear-gradient(to bottom, #000 62%, transparent 100%);
}
.light {
  position: absolute;
  inset: 0;
  background-image:
    /* The landing's pitch (26px), a fatter dot, barely more ink. The landing paints its
       field at the size you look at it; this one survives 2400 → 2000 on encode and then
       2000 → ~880 in the README column, and on that trip a 1px dot averages away to
       nothing — which is why the RADIUS goes up while the ALPHA stays near where it was.
       The two knobs are not interchangeable: radius buys survival, alpha buys presence,
       and overpaying with alpha is what makes the grid shimmer under the headline
       instead of sitting behind it (2px @ 11% carried fine and did exactly that). */
    radial-gradient(color-mix(in srgb, var(--text) 5.7%, transparent) 1.5px, transparent 1.5px),
    radial-gradient(48rem 26rem at 26% 2%, color-mix(in oklab, var(--accent) 38%, transparent), transparent 64%),
    radial-gradient(86rem 44rem at 50% 6%, color-mix(in oklab, var(--accent) 13%, transparent), transparent 72%);
  background-size: 26px 26px, auto, auto;
  /* The dot field fades out before it can compete with the shot. */
  mask-image: linear-gradient(to bottom, #000 55%, transparent 92%);
}
.noise {
  position: absolute;
  inset: 0;
  opacity: 0.05;
  mix-blend-mode: soft-light;
  background-image: ${NOISE};
  background-size: 160px 160px;
}

/* Four translucent discs echoing the nodes in the product's own graph. Their tonal
   range comes from overlap, not blur; screen blending keeps them emitted haze rather
   than coloured plastic on a near-black canvas.
   The cluster is deliberately BIGGER than the canvas and hangs off the right edge: on
   the landing it does the same against a 1440px viewport, and what makes it read as
   light rather than as four circles is that you only ever see gentle arcs of it. Fit
   the whole cluster inside a 1200px still and the same recipe turns into bubbles. */
.nodes {
  position: absolute;
  top: 8%;
  left: 88%;
  width: 96%;
  height: 128%;
  transform: translateX(-50%);
}
.node {
  position: absolute;
  border-radius: 50%;
  mix-blend-mode: screen;
  /* The landing's secondary hero light — a decorative marketing hue with no token in
     the product palette, so it is declared here, once. */
  background: var(--disc, #ff8db3);
  /* Dosed down from the landing's 0.18: this canvas is a fifth of a hero's area, so
     the same alpha over the same near-black reads twice as loud. */
  opacity: 0.11;
  aspect-ratio: 1;
}
.node.a { top: -3%; left: 26%; width: 49%; }
.node.b { top: 22%; left: 0;   width: 58%; --disc: var(--accent); opacity: 0.09; }
.node.c { top: 18%; left: 53%; width: 39%; opacity: 0.095; }
.node.d { top: 47%; left: 29%; width: 48%; --disc: #fff; opacity: 0.07; }
`

/** The product window and the light it sits on. `marginTop` differs between an artwork
 *  (a gap after the headline) and a plate (the text zone it must clear). */
const product = (shotWidth: string, marginTop: string): string => `
/* ── The product window ───────────────────────────────────────────────────── */
.shot {
  position: relative;
  width: ${shotWidth};
  margin-top: ${marginTop};
}
/* The pedestal: a pool of accent light UNDER the window. Without it a bordered
   screenshot always reads as pasted onto the page rather than lifted off it. */
.shot::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 8%;
  width: 84%;
  height: 88%;
  transform: translateX(-50%);
  background: radial-gradient(
    50% 50% at 50% 50%,
    color-mix(in oklab, var(--accent) 42%, transparent),
    transparent 74%
  );
  filter: blur(38px);
  z-index: -1;
}
/* The same plate recipe the app uses for its own modals: a crisp rim, a lit top
   edge, and two shadows — one tight, one wide and lifted. */
.frame {
  position: relative;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow:
    inset 0 1px 0 var(--glass-highlight),
    0 2px 8px rgba(0, 0, 0, 0.5),
    0 30px 60px -20px rgba(0, 0, 0, 0.75);
}
.frame img {
  display: block;
  width: 100%;
  height: auto;
}
`

const styles = (c: Canvas, tokens: string, font: string): string => `
${base(c, tokens, font)}
${atmosphere()}

/* ── Type ─────────────────────────────────────────────────────────────────── */
.stack {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: ${c.padTop}px ${c.gutter}px 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: ${c.gapBrand}px;
}
.brand img {
  /* No border-radius here: favicon.svg draws its own rounded plate, and a second radius
     in CSS only starts clipping it the day that asset's corners change. */
  width: ${c.markSize}px;
  height: ${c.markSize}px;
}
.brand span {
  font-size: ${c.wordSize}px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
/* The headline is the whole message. The README's subheading was under it at first and
   came off: at the width GitHub renders the banner it sets around 6px, too small to
   read and too present to ignore — the picture below says "editor over Markdown" more
   directly than a line of type nobody can make out. */
h1 {
  margin: 0;
  max-width: ${c.titleWidth}ch;
  font-size: ${c.titleSize}px;
  font-weight: 690;
  line-height: 1.12;
  letter-spacing: -0.03em;
  text-wrap: balance;
}

${product(c.shotWidth, `${c.gapShot}px`)}
`

/** A plate has no type of its own; the text zone is held open by margin instead, so the
 *  window lands exactly where `textZone` promises the consumer it will. */
const plateStyles = (p: Plate, tokens: string, font: string): string => `
${base(p, tokens, font)}
${atmosphere()}

.stack {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
}

${p.shotWidth ? product(p.shotWidth, `${p.textZone}px`) : ''}
`

export const composition = ({ canvas, copy, tokens, font, mark, shot }: Composition): string => {
  const headline = escapeHtml(copy)

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<title>${headline}</title>
<style>${styles(canvas, tokens, font)}</style>
</head>
<body>
<div class="canvas">
  <div class="backdrop">
    <div class="light"></div>
    <div class="nodes">
      <span class="node a"></span>
      <span class="node b"></span>
      <span class="node c"></span>
      <span class="node d"></span>
    </div>
    <div class="noise"></div>
  </div>
  <div class="stack">
    <div class="brand"><img src="${mark}" alt=""><span>Notarium</span></div>
    <h1>${headline}</h1>
    <div class="shot"><div class="frame"><img src="${shot}" alt=""></div></div>
  </div>
</div>
</body>
</html>
`
}

export const plateComposition = ({
  plate,
  tokens,
  font,
  shot,
}: PlateComposition): string => `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<title>${plate.name}</title>
<style>${plateStyles(plate, tokens, font)}</style>
</head>
<body>
<div class="canvas">
  <div class="backdrop">
    <div class="light"></div>
    <div class="nodes">
      <span class="node a"></span>
      <span class="node b"></span>
      <span class="node c"></span>
      <span class="node d"></span>
    </div>
    <div class="noise"></div>
  </div>
  <div class="stack">
${plate.shotWidth ? `    <div class="shot"><div class="frame"><img src="${shot}" alt=""></div></div>` : ''}
  </div>
</div>
</body>
</html>
`
