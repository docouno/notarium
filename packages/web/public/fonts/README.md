# Bundled reading/code fonts (#27)

Self-hosted woff2 for the "reading font" presets (Settings → Appearance) and for the
code font `--font-mono` (JetBrains Mono). **Not from the Google CDN** — a self-hosted
app works offline and does not phone home.

These files and `src/styles/reading-faces.scss` are **generated** — do not edit by hand:

```
node scripts/gen-reading-faces.mjs
```

The script downloads subsets from [Fontsource](https://fontsource.org) (= the canonical
Google Fonts subsets) and emits `@font-face`. It bundles the subsets of European
scripts that woff2 carries cheaply: **latin, latin-ext, cyrillic, greek,
vietnamese** (× normal/italic where available). The browser downloads only the needed
subset of the needed font and only when it is active. CJK/Arabic/Hebrew/Indic are **not**
bundled (megabytes) — they render with the OS system font via the fallback tail of the
stack (see `reading.scss`).

All fonts are under the **SIL Open Font License 1.1** (Cascadia Code is OFL too).
Cyrillic/Greek coverage (verified via Fontsource):

| Category | Fonts | Greek | Note |
|-----------|--------|-------|-------|
| sans  | Inter · Open Sans · Roboto · Source Sans 3 · Noto Sans | all | — |
| serif | Lora · Literata · Merriweather · Source Serif 4 · Noto Serif | Literata/Source Serif/Noto Serif | Lora/Merriweather without greek |
| mono  | JetBrains Mono · Fira Code · Cascadia Code | all | Fira Code without italic (synthesized) |

The system presets (System sans, Georgia serif) do not vendor any fonts.

**Not included and why:** Atkinson Hyperlegible — no Cyrillic. Hack — not on
Fontsource (only the `hack-font` package), it breaks the unified pipeline; the 3 monos
already cover ligatures/no-ligatures/italic. DejaVu — a dated look. Commit Mono /
Iosevka — on Fontsource without Cyrillic.
