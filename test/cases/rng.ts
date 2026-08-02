import type { Rng } from './types'

// A tiny deterministic PRNG (mulberry32) seeded from a string — no deps, stable
// across Node versions. The CLI's `SEED` and each case's own label feed the seed
// so a generated case reproduces byte-for-byte (#175: fixture cases must be
// deterministic — visual snapshots depend on it), while different seeds give
// different worlds.

const hashSeed = (seed: string): number => {
  // FNV-1a → a 32-bit uint the generator advances from.
  let h = 0x811c9dc5

  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }

  return h >>> 0
}

export const makeRng = (seed: string): Rng => {
  let a = hashSeed(seed) || 1

  const next = (): number => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)],
    bool: (p) => next() < p,
  }
}
