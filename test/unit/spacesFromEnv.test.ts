// spacesFromEnv (#16/#69/#99): the pure env → space-set + adoptLegacyInto
// mapping that the process entry (main.ts) feeds into createServer. Pins the
// behavioural heart of #99 — the AUTH_MODE zero-config split (password → no
// spaces, none → one home) and the legacy-path adoptLegacyInto wiring — at the
// env→option boundary, where a typo in the boot decision would manifest.

import { describe, expect, it } from 'vitest'

import { spacesFromEnv } from '../../packages/server/src/apps/server/spacesFromEnv'

const env = (o: Record<string, string | undefined>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv
// <DATA_DIR>/spaces, as the composition root derives it (#101). A distinctive path
// so a test can tell "the default was applied" from "SPACES_ROOT was honoured".
const DEFAULT_ROOT = '/data/spaces'
const resolve = (
  o: Record<string, string | undefined>,
  authMode: 'password' | 'none',
): ReturnType<typeof spacesFromEnv> => spacesFromEnv(env(o), authMode, DEFAULT_ROOT)

describe('spacesFromEnv (#99)', () => {
  it('zero-config password → NO spaces, no default, no adoption (#99: first space is the owner personal at setup)', () => {
    const r = resolve({ SPACES_ROOT: '/spaces' }, 'password')
    expect(r.spaces).toEqual([])
    expect(r.adoptLegacyInto).toBeUndefined()
  })

  it('zero-config none → exactly one home space (slug "main" for continuity), no adoption', () => {
    const r = resolve({ SPACES_ROOT: '/spaces' }, 'none')
    expect(r.spaces).toEqual([
      { slug: 'main', displayName: 'Home', engine: 'notarium', notesDir: '/spaces/main' },
    ])
    expect(r.adoptLegacyInto).toBeUndefined()
  })

  it('legacy single-space ENGINE=notarium + NOTES_DIR → one space, adoptLegacyInto = its slug', () => {
    const r = resolve({ ENGINE: 'notarium', NOTES_DIR: '/notes' }, 'password')
    expect(r.spaces).toEqual([{ slug: 'main', engine: 'notarium', notesDir: '/notes' }])
    expect(r.adoptLegacyInto).toBe('main') // pre-#16 space="" rows adopt here
  })

  it('legacy single-space with only NOTES_DIR defaults the engine to notarium', () => {
    const r = resolve({ NOTES_DIR: '/notes' }, 'password')
    expect(r.spaces).toEqual([{ slug: 'main', engine: 'notarium', notesDir: '/notes' }])
    expect(r.adoptLegacyInto).toBe('main')
  })

  it('a leftover ENGINE=basic-memory is a loud boot error (the engine was removed, #131)', () => {
    expect(() => resolve({ ENGINE: 'basic-memory', NOTES_DIR: '/notes' }, 'password')).toThrow(
      /engine must be "notarium"/,
    )
  })

  it('explicit SPACES_CONFIG → the configured spaces, NO adoptLegacyInto, no defaultSpace anywhere', () => {
    const cfg = JSON.stringify({
      spaces: [
        { slug: 'team', engine: 'notarium', notesDir: '/spaces/team' },
        { slug: 'work', engine: 'notarium', notesDir: '/spaces/work' },
      ],
    })
    const r = resolve({ SPACES_CONFIG: cfg }, 'password')
    expect(r.spaces.map((s) => s.slug)).toEqual(['team', 'work'])
    expect(r.adoptLegacyInto).toBeUndefined()
  })

  it('SPACES_CONFIG wins over SPACES_ROOT (explicit topology takes precedence)', () => {
    const cfg = JSON.stringify({ spaces: [{ slug: 'team', engine: 'notarium', notesDir: '/x' }] })
    const r = resolve({ SPACES_CONFIG: cfg, SPACES_ROOT: '/spaces' }, 'password')
    expect(r.spaces.map((s) => s.slug)).toEqual(['team'])
  })

  it('SPACES_ROOT is ignored when a legacy single-space env is present (ENGINE set)', () => {
    // zero-config only triggers when ENGINE/NOTES_DIR are both unset.
    const r = resolve(
      { SPACES_ROOT: '/spaces', ENGINE: 'notarium', NOTES_DIR: '/notes' },
      'password',
    )
    expect(r.spaces).toEqual([{ slug: 'main', engine: 'notarium', notesDir: '/notes' }])
    expect(r.adoptLegacyInto).toBe('main')
  })

  it('rejects an empty SPACES_CONFIG spaces list and a bad slug', () => {
    expect(() => resolve({ SPACES_CONFIG: '{"spaces":[]}' }, 'password')).toThrow(/empty/)
    expect(() =>
      resolve(
        { SPACES_CONFIG: '{"spaces":[{"slug":"Bad Slug","engine":"notarium","notesDir":"/x"}]}' },
        'password',
      ),
    ).toThrow(/bad space slug/)
  })

  it('rejects non-durable SPACES_CONFIG display names', () => {
    const loneSurrogate = String.fromCharCode(0xd800)

    for (const displayName of ['bad\nname', `bad${loneSurrogate}`, 'x'.repeat(201)]) {
      const config = JSON.stringify({
        spaces: [{ slug: 'main', displayName, engine: 'notarium', notesDir: '/x' }],
      })

      expect(() => resolve({ SPACES_CONFIG: config }, 'password')).toThrow(
        /bad displayName for space "main"/,
      )
    }
  })

  it('ENGINE=notarium without NOTES_DIR is a loud boot error', () => {
    expect(() => resolve({ ENGINE: 'notarium' }, 'password')).toThrow(/NOTES_DIR/)
  })

  // #101 — the data root. spacesRoot is not merely a path: it gates spaceCreate and
  // purge (server.ts), so WHERE the default applies is a behavioural decision, not a
  // formatting one.
  describe('data root default (#101)', () => {
    it('NO space env at all → zero-config on <DATA_DIR>/spaces, not the legacy branch', () => {
      // The published image's own `docker run -v …:/data` with nothing else. This
      // used to fall through to legacy and die on "a single-space run needs
      // NOTES_DIR" — zero-config was unreachable without SPACES_ROOT.
      const r = resolve({}, 'password')
      expect(r.spaces).toEqual([])
      expect(r.spacesRoot).toBe(DEFAULT_ROOT)
      expect(r.adoptLegacyInto).toBeUndefined()
    })

    it('NO space env at all, none-mode → the home space under the default root', () => {
      const r = resolve({}, 'none')
      expect(r.spaces).toEqual([
        { slug: 'main', displayName: 'Home', engine: 'notarium', notesDir: '/data/spaces/main' },
      ])
      expect(r.spacesRoot).toBe(DEFAULT_ROOT)
    })

    it('explicit SPACES_ROOT still wins over the default (class-A operator knob)', () => {
      const r = resolve({ SPACES_ROOT: '/notes' }, 'none')
      expect(r.spacesRoot).toBe('/notes')
      expect(r.spaces[0]?.notesDir).toBe('/notes/main')
    })

    it('SPACES_CONFIG without SPACES_ROOT stays operator-static — NO implicit root', () => {
      // The regression the default must not cause: spacesRoot gates spaceCreate and
      // purge, so defaulting it unconditionally would hand a pinned-topology host
      // runtime space creation (and purge rm -rf) over a root it never named.
      const cfg = JSON.stringify({ spaces: [{ slug: 'team', engine: 'notarium', notesDir: '/x' }] })
      const r = resolve({ SPACES_CONFIG: cfg }, 'password')
      expect(r.spacesRoot).toBeUndefined()
    })

    it('legacy single-space without SPACES_ROOT stays operator-static — NO implicit root', () => {
      const r = resolve({ ENGINE: 'notarium', NOTES_DIR: '/notes' }, 'password')
      expect(r.spacesRoot).toBeUndefined()
    })

    it('SPACES_CONFIG + explicit SPACES_ROOT keeps runtime creation (the combo still works)', () => {
      const cfg = JSON.stringify({ spaces: [{ slug: 'team', engine: 'notarium', notesDir: '/x' }] })
      const r = resolve({ SPACES_CONFIG: cfg, SPACES_ROOT: '/spaces' }, 'password')
      expect(r.spaces.map((s) => s.slug)).toEqual(['team'])
      expect(r.spacesRoot).toBe('/spaces')
    })
  })
})
