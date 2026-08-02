import { EN } from './en'
import type { DemoBundle } from './types'

// The demo bundles' registry (#256). One entry per locale the demo screenshots
// exist in. Today that is `en` alone — the product's UI chrome carries no i18n
// layer, so a localized bundle would render national note text inside an English
// interface and promise a localization that isn't there. The shape is already
// per-locale so that adding the other eight (the docs site's `de es fr pt ru kz
// zh ja`) is a translation pass over `en.ts`, not a rewrite of the case.

export const DEMO_BUNDLES: readonly DemoBundle[] = [EN]

/** The pivot locale — authored as the original, and what every other bundle is
 *  translated FROM (mirrors `LOCALES[0] = 'en'` on the docs site). */
export const DEFAULT_DEMO_LOCALE = 'en'

const BY_LOCALE = new Map(DEMO_BUNDLES.map((b) => [b.locale, b]))

export const demoLocales = (): string[] => DEMO_BUNDLES.map((b) => b.locale)

export const getDemoBundle = (locale: string = DEFAULT_DEMO_LOCALE): DemoBundle => {
  const bundle = BY_LOCALE.get(locale)

  if (!bundle) {
    throw new Error(`unknown demo locale: "${locale}". Known: ${demoLocales().join(', ')}`)
  }

  return bundle
}

export type { DemoBundle, DemoEdit, DemoNote } from './types'
