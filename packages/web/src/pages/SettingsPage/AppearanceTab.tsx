import { useMemo } from 'react'
import {
  CODE_THEMES,
  type EditorMode,
  READING_FONTS,
  READING_SIZES,
  useChrome,
} from '../../composers/ChromeProvider'
import { IconCode, IconMoon, IconSparkles, IconSun } from '../../core/Icons'
import { Segmented } from '../../core/Segmented'
import { Select } from '../../core/Select'
import { SettingsSection } from '../../core/SettingsSection'
import { renderMarkdown } from '../../libs/markdown/markdown'
import styles from './AppearanceTab.module.scss'

// A short, multi-token sample so each preset's keyword/string/number/comment/
// function colours are all visible at a glance — rendered through the real
// markdown pipeline so the preview IS the production output, not a mock.
const SAMPLE = [
  '```js',
  '// greet a reader by name',
  'function greet(name) {',
  '  const msg = `Hello, ${name}!`',
  '  return msg.length > 0 ? msg : "friend"',
  '}',
  '```',
].join('\n')

// Prose sample for the reading-font preview (#27). It must be PROSE, not code —
// the code sample stays monospaced regardless of the reading font, so it can't
// show a font/size change. Kept SHORT on purpose (one heading + one line): a long
// filler paragraph drowned out the controls. Language-neutral (a Latin pangram +
// bold/italic/code) — no per-language sample until the app is actually
// multilingual; a lone Russian line would falsely imply a Russian-only focus.
const READING_SAMPLE = [
  '### The quick brown fox',
  '',
  'Jumps over the lazy dog. **Bold**, *italic*, `code`.',
].join('\n')

// One-line description shown under the "Editor mode" heading, swapped to match
// the selected mode (#180). The triad is Source / WYSIWYM / WYSIWYG; only the
// first two are built (WYSIWYG = #120). The acronym is spelled out here so the
// unfamiliar term reads on its own (the mitigation agreed in #117).
const EDITOR_MODE_DESC: Record<EditorMode, string> = {
  source:
    'Source — the raw markdown text, monospaced with syntax highlighting. Edit the markup directly.',
  wysiwym:
    'WYSIWYM — "what you see is what you mean": the markdown markup stays visible (dimmed) while headings, emphasis, quotes and code render in place. Same plain-text file.',
}

// Appearance preferences (#28). Theme switch (#1), reading typography (#27) and the
// code-highlighting preset (#115). The writing aids (focus / typewriter, #118) are
// controlled directly in the editor's status bar, not here. All of this reads/writes
// ChromeProvider — the single source of truth that (step 2) syncs to the server while
// keeping localStorage as the before-paint cache.
export const AppearanceTab = () => {
  const {
    theme,
    setTheme,
    codeTheme,
    setCodeTheme,
    editorMode,
    setEditorMode,
    readingFont,
    setReadingFont,
    readingSize,
    setReadingSize,
  } = useChrome()
  // Both samples render once — the previews are pure CSS over fixed HTML (a theme,
  // font or size change is a var swap on this same markup, nothing to recompute).
  const sampleHtml = useMemo(() => renderMarkdown(SAMPLE), [])
  const readingHtml = useMemo(() => renderMarkdown(READING_SAMPLE), [])

  return (
    <>
      <SettingsSection
        title="Theme"
        description="How Notarium looks across the app."
        action={
          <Segmented
            ariaLabel="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light', icon: <IconSun size={15} /> },
              { value: 'dark', label: 'Dark', icon: <IconMoon size={15} /> },
            ]}
          />
        }
      />

      <SettingsSection
        title="Reading size"
        description="Base text size for the note view. Headings, lists, code and tables scale with it."
        action={
          <Segmented
            ariaLabel="Reading size"
            value={readingSize}
            onChange={setReadingSize}
            options={READING_SIZES}
          />
        }
      />

      <SettingsSection
        title="Reading font"
        description="Typeface for the rendered note view — sans, serif and monospace presets. System and Georgia use your OS fonts; the rest are bundled, load on demand, and cover Latin, Cyrillic, Greek and more."
        action={
          <Select
            aria-label="Reading font"
            data-testid="reading-font-select"
            value={readingFont}
            onChange={setReadingFont}
            options={READING_FONTS}
          />
        }
      >
        <div className={styles.preview}>
          <div
            className="markdown"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: readingHtml }}
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title="Editor mode"
        description={EDITOR_MODE_DESC[editorMode]}
        action={
          <Segmented
            ariaLabel="Editor mode"
            value={editorMode}
            onChange={setEditorMode}
            options={[
              { value: 'source', label: 'Source', icon: <IconCode size={15} /> },
              { value: 'wysiwym', label: 'WYSIWYM', icon: <IconSparkles size={15} /> },
            ]}
          />
        }
      />

      <SettingsSection
        title="Code theme"
        description="Syntax highlighting for fenced code blocks. Each preset tracks the light/dark theme."
        action={
          <Select
            aria-label="Code theme"
            data-testid="code-theme-select"
            value={codeTheme}
            onChange={setCodeTheme}
            options={CODE_THEMES}
          />
        }
      >
        <div
          className="markdown"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: sampleHtml }}
        />
      </SettingsSection>
    </>
  )
}
