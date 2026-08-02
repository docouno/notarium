# Reading typography (#27)

> **Interface font (the entire UI outside the reader).** The default is **Inter** (bundled, `--font-sans`), preloaded in `index.html` (no flash on the first render), with the OS system stack as fallback (`--font-system`). This keeps the interface consistent across all operating systems (especially Linux). This is **separate** from the reading font: the "System" preset below = `--font-system` (the OS's native font), NOT Inter. Monospace spots in the UI use `--font-mono` (JetBrains Mono).

Notarium lets you configure the **font and size of the reading area** — the rendered markdown body of a note. This is the same `.markdown` surface that powers reading mode, the **Preview** button in the editor, revision history, and the preview in settings, so a single setting applies to all of them at once.

Two orthogonal knobs live in **Settings → Appearance**:

## Reading font

A fixed list of presets (not an arbitrary font), grouped by category. The set was selected based on research into real-world popularity + reading quality + multilingual coverage (#27). **They all include Cyrillic.**

- **sans:** System (OS, default) · Inter · Open Sans · Roboto · Source Sans 3 · Noto Sans
- **serif:** Georgia (OS) · Lora · Literata · Merriweather · Source Serif 4 · Noto Serif
- **mono:** JetBrains Mono · Fira Code · Cascadia Code

The bundled fonts are self-hosted under `public/fonts/` — **no Google CDN**: a self-hosted app must work offline and must not "phone home". The files and `@font-face` rules (`reading-faces.scss`) are **generated** by the `scripts/gen-reading-faces.mjs` script. Each `@font-face` is split into subsets via `unicode-range`, so the browser downloads **only the subset that actually occurs, and only when the font is active** — an unused `@font-face` is never downloaded at all. `font-display: swap` shows the fallback immediately, then swaps it in. The PWA caches downloaded files at runtime (CacheFirst) → offline after first use.

> **Multilingual support.** The subsets bundled are those of European scripts, which are cheap in woff2: **latin, latin-ext, cyrillic, greek, vietnamese** — this covers virtually all European languages (Russian, Polish, Czech, Turkish, Greek, Vietnamese…). CJK / Arabic / Hebrew / Indic are **not bundled** (even a CJK subset is hundreds of KB per weight): no `@font-face` is declared for them, and the browser picks up the OS font via the system tail of the stack (the GitHub/Notion/Obsidian pattern). This way a Chinese or Arabic note renders correctly without any extra download.

> **Code font.** JetBrains Mono is bundled and mapped to `--font-mono` — so **code blocks and the editor** render in quality monospace on every OS (rather than "whatever the system happens to have"). The cost: it loads on almost every page (code/editor are everywhere), not lazily. The reading presets `JetBrains Mono`/`Fira Code`/`Cascadia Code` = the same monospace for the whole body (iA Writer style).

> **A caveat about Fira Code.** On fontsource, Fira Code has no italic weight → `*italic*` is synthesized by the browser. That's why JetBrains Mono (with a true italic) was chosen as the default code font; Fira Code is a preset for the sake of ligatures, Cascadia Code for the sake of better italics.

## Reading size

A stepped preset **S / M / L / XL** ≈ 15.5 / 17 / 19 / 21px (M is the default). The size is set **once** on `.markdown`, and the entire typographic scale (headings, code, lists, tables, blockquotes) is expressed in `em` relative to it — so a single step scales the whole rhythm proportionally, not just the paragraphs.

The history diff mode is part of the reading surface, but it is source/code-like: it stays monospace and more compact than prose via the derived token `--reading-diff-size = calc(var(--reading-size) * 0.85)`. So S/M/L/XL change the line height and readability of the diff, while the gutter / line numbering keep a dense code rhythm.

## Seams and boundaries

- **Where it applies.** The knobs style the rendered markdown body (`.markdown`) **and both editor modes** — a single size knob adjusts all surfaces 1:1. WYSIWYM ("what you see is what you mean") inherits both the reader's font and its size (base `.cm-host--wysiwym .cm-content`; headings in `wysiwymSource.ts` scale in `em` behind it). **Source** (raw markdown) inherits the **size** `var(--reading-size)` 1:1, but keeps `--font-mono` as its **font** (it's code). The note title in the reader (`.doc-title`) is **left untouched** — this keeps the title and the note width from "jumping" between reading and editing (the `--doc-width` invariant, see `styles/shared.scss`). We're not doing separate reader/editor sizes yet (the mechanism is there — adding a second control is easy if needed).
- **Measure (line length).** The reading column width (`--doc-width`, 740px) is shared with the editor and is a constant for now — it isn't exposed as a separate knob, so as not to break the read↔edit invariant.
- **Code is always monospace.** Inline code and code blocks keep `--font-mono` regardless of the chosen reading font.
- **Reading body contrast (#189).** The color of the reading body text is a separate token `--reading-text` (`styles/tokens.scss`), **not** the global `--text`. `--text` drives the entire UI at the contrast ceiling (in the dark theme the body sat at ~16:1 — which was tiring over long reading), so the body is softened to a calm off-grey in the same warm palette (dark `#d6d4cf` ≈12.3:1, light `#2c313a` ≈13:1 — both in the AAA zone). It applies to `.markdown` and the WYSIWYM surface; **the expressive parts keep the full `--text`, the body is softened** — h1–h3 headings, **bold (`strong`), and inline/code** are pinned to `--text`, so the contrast step between body and accent itself becomes hierarchy, and bold/code read identically in the reader and the editor (mirroring the `t.strong`/`t.monospace` pins in `wysiwymSource.ts`). Italic (`em`) is NOT pinned — it accents through slant rather than brightness, so it goes in the same tone as the body. Strikethrough (`del`/`s`) uses `--text-dim` (deleted/dimmed, mirroring `t.strikethrough`). Links (`--accent`), callouts, and dimmed elements (h4/blockquotes/footnotes on `--text-dim`/`--text-faint`) are unchanged. **Source mode** (raw markdown) keeps `--text` — it's code editing, not reading.

## Storage

Both settings — `data-reading-font` and `data-reading-size` on `<html>` — are set by `ChromeProvider` on the same rail as the theme and code theme: a localStorage cache (`bm-reading-font` / `bm-reading-size`) for now, with server-side sync in `user_preferences` later (#28, step 2). The default tokens (`--reading-font` / `--reading-size`) and the preset mapping live in `styles/tokens.scss` + `styles/reading.scss`.
