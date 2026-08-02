import type { LanguageFn } from 'highlight.js'
// highlight.js wired from the CORE build (not the default package, which pulls
// all ~190 languages) plus a curated language set registered by hand. This keeps
// the highlighter small (#115: ~30–40KB gz target, measured by the Vite build)
// while still covering the languages real notes carry. Output is class-based
// (`hljs-*`) so it passes the existing DOMPurify config untouched and a strict
// CSP — themes are CSS (see styles/code-themes.scss), switched by an attribute
// with zero re-highlighting. autodetect (highlightAuto) is bounded to exactly
// the languages registered here, so an untagged or mistagged fence still gets a
// sensible best guess instead of nothing.
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini' // also covers TOML
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml' // HTML/SVG/XML
import yaml from 'highlight.js/lib/languages/yaml'

// Registered once at module load. The `register` name is the primary id; hljs's
// own aliases (js→javascript, ts→typescript, html→xml, sh→bash, yml→yaml, …)
// come bundled with each language definition, so a ```js fence resolves here.
const LANGUAGES: Record<string, LanguageFn> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
}

for (const [name, def] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, def)
}

/** Highlight a fenced code block to class-based HTML.
 *  - Tagged with a language we recognise (aliases resolved by getLanguage —
 *    js→javascript, sh→bash, yml→yaml, …) → highlight as that language.
 *  - Tagged with anything else (`text`, `plaintext`, `mermaid`, `log`, an
 *    unknown lang) → return the body UNCHANGED so it renders plain: respect the
 *    author's explicit tag, never GUESS a language they didn't ask for (auto-
 *    detect mis-colours prose/diagrams as code). Safe: returning the input
 *    verbatim leaves marked-highlight's `escaped` flag false (it only sets it
 *    when the highlighted result DIFFERS from the source), so its renderer
 *    HTML-escapes the block — and renderMarkdown's DOMPurify pass is the final
 *    sanitiser backstop regardless.
 *  - UNtagged fence (no language) → auto-detect over the registered set, since
 *    a forgotten tag (common in pasted exports) should still get coloured.
 *  Highlighted output is hljs-escaped, class-only HTML. */
export const highlightCode = (code: string, lang?: string): string => {
  if (lang) {
    return hljs.getLanguage(lang)
      ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      : code
  }

  return hljs.highlightAuto(code).value
}
