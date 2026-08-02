import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Everything the published composition is made of comes from THIS repository: the
// palette from the app's own tokens, the typeface from the fonts the app ships, the
// mark from the file the icon set is generated from, and the words from the README
// the image sits in. No host paths, no sibling checkout, nothing to install — the
// flow renders the same on any machine, which is the whole reason it is a flow and
// not a design file.

/** Repo root, resolved from this module rather than cwd (`make` and `npx` disagree). */
export const REPO = fileURLToPath(new URL('../../../', import.meta.url))

const TOKENS = 'packages/web/src/styles/tokens.scss'
// The UI typeface, as the app itself loads it (reading-faces.scss): one variable
// woff2 covering the whole 100–900 axis, so the banner's display weight is real
// rather than a synthesised faux-bold.
const FONT = 'packages/web/public/fonts/inter-latin-normal.woff2'
// The brand mark. This exact file is what the PWA icon set is generated from
// (pwa-assets.config.ts), so the banner cannot show a stale logo.
const MARK = 'packages/web/public/favicon.svg'

/**
 * The banner's headline, DERIVED from README.md rather than copied into a literal
 * here. An image that contradicts the paragraph it is pinned above is worse than
 * no image, and a second copy of approved launch copy (#226 §7) is exactly how
 * that happens. Shape expected, directly under the `# H1`:
 *
 *     **One knowledge base, so your AI starts with context.** Your agents, …
 *
 * Only the bold sentence is used. The rest of that line is the README's subheading,
 * and on a banner it sets at a size nobody reads: at the width GitHub renders, one
 * headline over the product is the whole message the picture can carry.
 */
export const readHeadline = async (): Promise<string> => {
  const lines = (await readFile(join(REPO, 'README.md'), 'utf8')).split('\n')
  const h1 = lines.findIndex((l) => l.startsWith('# '))

  if (h1 < 0) {
    throw new Error('README.md has no `# ` heading — cannot read the banner copy')
  }

  const first = lines.slice(h1 + 1).find((l) => l.trim() !== '') ?? ''
  // The trailing group is not used, only required: bold-plus-prose is what makes the
  // line a tagline rather than a bold heading that happens to sit under the title.
  const m = first.match(/^\*\*(.+?)\*\*\s+(.+)$/)

  if (!m) {
    throw new Error(
      `README.md: expected the line under the title to be the tagline ` +
        `(\`**headline.** subheading\`), got: ${first.slice(0, 80)}`,
    )
  }

  // The headline ends the sentence in prose but not on a banner, where it is a
  // title and a full stop reads as a typo.
  return m[1].replace(/\.$/, '')
}

/**
 * The app's theme tokens as plain CSS, injected verbatim into the composition.
 * The file is two flat blocks of custom properties (`:root` and its dark override)
 * with no SCSS syntax, so it is already valid CSS — and taking it whole, rather
 * than transcribing a palette, is what stops the banner drifting away from the
 * product on the next re-theme. The brace count is asserted: if the file ever
 * grows nesting, this fails loudly instead of silently emitting half a theme.
 */
export const readThemeTokens = async (): Promise<string> => {
  const css = await readFile(join(REPO, TOKENS), 'utf8')
  const opens = css.match(/\{/g)?.length ?? 0
  const blocks = css.match(/:root[^{]*\{[^{}]*\}/g) ?? []

  if (opens !== 2 || blocks.length !== 2) {
    throw new Error(
      `${TOKENS}: expected exactly two flat \`:root\` blocks (found ${blocks.length} ` +
        `in ${opens} rules). The preview injects this file as CSS — teach it the new ` +
        `shape rather than hand-copying the palette.`,
    )
  }

  return blocks.join('\n')
}

const dataUri = async (path: string, mime: string): Promise<string> =>
  `data:${mime};base64,${(await readFile(join(REPO, path))).toString('base64')}`

/** The variable Inter face, inlined so the page has zero network and zero host fonts. */
export const readFont = (): Promise<string> => dataUri(FONT, 'font/woff2')

/** The brand mark, inlined for the same reason. */
export const readMark = (): Promise<string> => dataUri(MARK, 'image/svg+xml')
