/** The fake host keeps every table an owned ability is keyed by, so it needs the
 * SAME twin the server ships — not a copy of it. A fork here is how the browser
 * layer came to prove weaker behaviour than the domain: the purge fence and the
 * lifecycle keys lived on one side only. Re-exported rather than re-implemented so
 * the one contract both are run through cannot pass on one and fail on the other. */
export { InMemoryAbilityPreferences } from '@notarium/server'
