import { describe, expect, it } from 'vitest'

import { NOTE_BASENAME_MAX_BYTES } from './consts'
import {
  hasPortablePathComponents,
  isAtomicInstallTempName,
  isCanonicalInternalRelativeAddress,
  isCanonicalSafeRelativeAddress,
  isCanonicalSafeRelativePath,
  isPortableMoveDestination,
  isPortablePathComponent,
  isPortableRelativeDestination,
  isSkillPackageRootPath,
  legacyNoteNameAlias,
  normalizeSafeRelativePath,
  noteFileBase,
  noteFilePath,
  skillPackagePathOf,
  skillPlacementPathOf,
  sluggedNoteName,
} from './path'

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length

describe('skill package paths', () => {
  it('keeps nested resources under the canonical personal or project package root', () => {
    expect(skillPackagePathOf('review/references/guide.md')).toBe('review')
    expect(skillPackagePathOf('_projects/project-a/review/references/guide.md')).toBe(
      '_projects/project-a/review',
    )
    expect(isSkillPackageRootPath('review/SKILL.md')).toBe(true)
    expect(isSkillPackageRootPath('review/references/SKILL.md')).toBe(false)
    expect(isSkillPackageRootPath('_projects/project-a/review/SKILL.md')).toBe(true)
  })

  it('derives the common placement root independently of the package id', () => {
    expect(skillPlacementPathOf('Ab3xK9_qZ12/SKILL.md')).toBe('')
    expect(skillPlacementPathOf('Ab3xK9_qZ12/references/guide.md')).toBe('')
    expect(skillPlacementPathOf('_projects/cHJvamVjdA/Ab3xK9_qZ12/SKILL.md')).toBe(
      '_projects/cHJvamVjdA',
    )
    expect(skillPlacementPathOf('SKILL.md')).toBeNull()
  })

  it('recognises staging names built from the exact generated-id alphabet', () => {
    const uuid = '00000000-0000-4000-8000-000000000000'

    expect(isAtomicInstallTempName(`.AbCdefGhij_1.install-${uuid}`)).toBe(true)
    expect(isAtomicInstallTempName(`.A__________-.install-${uuid}`)).toBe(true)
    expect(isAtomicInstallTempName(`._projects.install-${uuid}`)).toBe(false)
    expect(isAtomicInstallTempName(`.short.install-${uuid}`)).toBe(false)
  })
})

// The ONE formula both engines, the read-model's path fence and the boot heal share.
// Its whole job is that no title can produce a name the storage layer loses (#296).
describe('noteFileBase', () => {
  it('names a file after the title, in any script', () => {
    expect(noteFileBase('My Note')).toBe('my-note')
    expect(noteFileBase('Планы')).toBe('plany') // romanised, unchanged by #296
    expect(noteFileBase('第三季度规划')).toBe('第三季度规划')
    expect(noteFileBase('会議の議事録')).toBe('会議の議事録')
  })

  it('never yields an empty basename — that is what wrote the dot-file `.md`', () => {
    // The regression this task exists for: an empty base made the path `<dir>/.md`,
    // which the scan hid and the reconcile then read as an external delete.
    for (const title of ['🎉🎉', '!!!', '   ', '']) {
      expect(noteFileBase(title, undefined, 'T5YQakUx0Z-7')).toBe('t5yqakux0z-7')
      expect(noteFileBase(title, undefined, 'T5YQakUx0Z-7').startsWith('.')).toBe(false)
    }
  })

  it('falls back to `note` when there is no id either (a bare-engine write)', () => {
    expect(noteFileBase('🎉')).toBe('note')
  })

  it('prefers the title over the id — the id is the LAST rung, not the first', () => {
    expect(noteFileBase('第三季度规划', undefined, 'T5YQakUx0Z-7')).toBe('第三季度规划')
  })

  it('an explicit fileName overrides the title, and falls back to it when unsluggable', () => {
    expect(noteFileBase('My Note', 'source-id-42')).toBe('source-id-42')
    expect(noteFileBase('My Note', '🎉')).toBe('my-note')
  })

  it('two different non-Latin titles take two different files', () => {
    // They used to collide on `.md`, so the second create was refused as a duplicate
    // of a note with a visibly different title.
    expect(noteFileBase('第三季度规划')).not.toBe(noteFileBase('会議の議事録'))
  })

  it('clips to a byte budget, on a code-point boundary, so a long CJK title fits', () => {
    // A limit counted in CHARACTERS would pass 255 CJK letters = 765 bytes and
    // ENAMETOOLONG on ext4/APFS.
    const base = noteFileBase('第'.repeat(200))
    expect(utf8Bytes(base)).toBeLessThanOrEqual(NOTE_BASENAME_MAX_BYTES)
    expect(base).toBe(base.normalize('NFC')) // no character was cut in half
    // The kept head is whole characters; the tail is the distinguishing tag.
    const [head, tag] = [base.slice(0, base.lastIndexOf('-')), base.slice(base.lastIndexOf('-'))]
    expect([...head].every((ch) => ch === '第')).toBe(true)
    expect(tag).toMatch(/^-[a-f0-9]{24}$/)
  })

  it('clips ASCII on the same budget and never leaves a trailing separator', () => {
    const base = noteFileBase('a '.repeat(200))
    expect(utf8Bytes(base)).toBeLessThanOrEqual(NOTE_BASENAME_MAX_BYTES)
    expect(base.endsWith('-')).toBe(false)
  })

  it('leaves a name inside the budget untouched', () => {
    expect(noteFileBase('Quarterly Plan')).toBe('quarterly-plan')
    expect(noteFileBase('a'.repeat(252))).toBe('a'.repeat(252))
  })

  it('bounds an explicit fileName without merging distinct long names', () => {
    // fileName is a public write input too, so it cannot bypass the filesystem's
    // component limit. A clip derives its suffix from the whole value: importer
    // idempotency and two same-titled conversations therefore stay distinct.
    const a = `20240101-${'第'.repeat(80)}-01aw1on1`
    const b = `20240101-${'第'.repeat(80)}-01a22vk4`
    expect(noteFileBase('t', a)).not.toBe(noteFileBase('t', b))
    expect(utf8Bytes(noteFileBase('t', a))).toBeLessThanOrEqual(NOTE_BASENAME_MAX_BYTES)
    expect(utf8Bytes(noteFileBase('t', b))).toBeLessThanOrEqual(NOTE_BASENAME_MAX_BYTES)
  })

  it('bounds the id fallback too — an adopted external claim cannot ENAMETOOLONG', () => {
    const base = noteFileBase('🎉', undefined, 'A'.repeat(300))
    expect(utf8Bytes(base)).toBeLessThanOrEqual(NOTE_BASENAME_MAX_BYTES)
    expect(base).toMatch(/-[a-f0-9]{24}$/)
  })

  it('does not inherit a known collision from the legacy 32-bit importer hash', () => {
    const head = 'a'.repeat(243)
    const a = `${head}1ytahli1oi0mdg`
    const b = `${head}03bj3ts0qjxjah`
    expect(noteFileBase(a)).not.toBe(noteFileBase(b))
  })

  it('does not clip a long title that a filesystem would still accept', () => {
    // The budget guards ENAMETOOLONG; clipping earlier would be a regression, since a
    // pre-existing long ASCII title had no cap at all and would be renamed on save.
    const a = `${'chapter-'.repeat(20)}alpha`
    const b = `${'chapter-'.repeat(20)}omega`
    expect(noteFileBase(a)).not.toBe(noteFileBase(b))
    expect(utf8Bytes(noteFileBase(a))).toBeGreaterThan(120)
  })

  it('bounds each uniquify-series member from its whole name', () => {
    const original = noteFileBase('第'.repeat(300))
    const sibling = noteFileBase(`${'第'.repeat(300)} 99`)
    expect(utf8Bytes(`${original}.md`)).toBeLessThanOrEqual(255)
    expect(utf8Bytes(`${sibling}.md`)).toBeLessThanOrEqual(255)
    expect(sibling).not.toBe(original)
  })

  // A clip cuts the TAIL, which is where every distinguishing suffix lives — so a
  // clipped name has to carry something derived from the whole slug, or a series folds
  // back onto one name and `uniquify` can never step past an occupant.
  it('keeps a clipped series distinct — uniquify and Duplicate still have somewhere to go', () => {
    for (const long of ['A'.repeat(300), '第'.repeat(100)]) {
      expect(noteFileBase(long)).not.toBe(noteFileBase(`${long} 2`))
      expect(noteFileBase(`${long} 2`)).not.toBe(noteFileBase(`${long} 3`))
      expect(noteFileBase(long)).not.toBe(noteFileBase(`${long} copy`))
    }
  })

  it('keeps two different long titles apart when they share a clipped prefix', () => {
    const shared = 'A'.repeat(300)
    expect(noteFileBase(`${shared} part one`)).not.toBe(noteFileBase(`${shared} part two`))
  })

  it('tags a name only when it was actually clipped', () => {
    // An untouched name must not grow a hash — that would rename every ordinary file.
    expect(noteFileBase('Quarterly Plan')).toBe('quarterly-plan')
    expect(noteFileBase('第三季度规划')).toBe('第三季度规划')
    expect(noteFileBase('A'.repeat(300))).toMatch(/-[a-f0-9]{24}$/)
  })

  it('makes Windows device names portable without colliding with a real suffixed title', () => {
    const reserved = noteFileBase('CON')

    expect(reserved).toMatch(/^~con-[a-f0-9]{24}$/)
    expect(isPortablePathComponent(`${reserved}.md`)).toBe(true)
    expect(reserved).not.toBe(noteFileBase(reserved))
  })
})

describe('legacyNoteNameAlias', () => {
  it('recognises only an exact obsolete title-derived basename', () => {
    const title = 'Қазақстан жоспары'
    const alias = 'aza-stan-zhospary'

    expect(legacyNoteNameAlias(title, `archive/${alias}.md`)).toBe(alias)
    expect(legacyNoteNameAlias(title, `archive/${alias}.MD`)).toBe(alias)
    expect(legacyNoteNameAlias(title, 'archive/arbitrary.md')).toBeNull()
    expect(legacyNoteNameAlias(title, 'archive/қазақстан-жоспары.md')).toBeNull()
  })

  it('rejects empty and still-current legacy keys', () => {
    expect(legacyNoteNameAlias('第三季度规划', '.md')).toBeNull()
    expect(legacyNoteNameAlias('Планы', 'plany.md')).toBeNull()
  })
})

describe('portable relative paths', () => {
  it('measures each component in UTF-8 bytes', () => {
    expect(isPortablePathComponent('a'.repeat(255))).toBe(true)
    expect(isPortablePathComponent('a'.repeat(256))).toBe(false)
    expect(isPortablePathComponent('界'.repeat(85))).toBe(true)
    expect(isPortablePathComponent('界'.repeat(86))).toBe(false)
  })

  it('rejects Windows-reserved and non-portable components', () => {
    for (const path of ['CON', 'aux.txt', 'COM¹', 'lpt³.log', 'a:b', 'trail.', 'trail ']) {
      expect(hasPortablePathComponents(path)).toBe(false)
    }
  })

  it('normalizes only public relative paths', () => {
    expect(normalizeSafeRelativePath('a\\b/./c//')).toBe('a/b/c')
    for (const path of ['/abs', '../up', 'a/../b', '.lost', 'a/.hidden']) {
      expect(normalizeSafeRelativePath(path)).toBeNull()
    }
  })

  it('distinguishes canonical destinations from legacy addresses', () => {
    expect(isCanonicalSafeRelativePath('a/b')).toBe(true)
    for (const path of ['a//b', './a', 'a/']) {
      expect(isCanonicalSafeRelativePath(path)).toBe(false)
    }
    expect(isCanonicalSafeRelativeAddress('a\\b')).toBe(true)
    expect(isCanonicalSafeRelativePath('a\\b')).toBe(false)
    expect(isCanonicalSafeRelativeAddress('foo:bar/legacy')).toBe(true)
    expect(isCanonicalSafeRelativePath('foo:bar/legacy')).toBe(false)
  })

  it('admits trusted hidden mount paths without admitting ambiguous traversal', () => {
    expect(isCanonicalInternalRelativeAddress('.notarium/memory/category/note.md')).toBe(true)
    for (const path of [
      '/absolute.md',
      '../escape.md',
      '.notarium//note.md',
      '.notarium/./note.md',
      '.notarium/memory/../note.md',
      '.notarium\\memory\\note.md',
    ]) {
      expect(isCanonicalInternalRelativeAddress(path)).toBe(false)
    }
  })

  it('allows a portable new child inside an existing legacy directory', () => {
    const existing = new Set(['foo:bar'])

    expect(isPortableRelativeDestination('foo:bar/new', (path) => existing.has(path))).toBe(true)
    expect(isPortableRelativeDestination('foo:bar/new:bad', (path) => existing.has(path))).toBe(
      false,
    )
  })

  it('lets a move carry its exact legacy leaf but never mint a different one', () => {
    const existing = new Set(['foo:parent', 'archive'])
    const hasDir = (path: string) => existing.has(path)

    expect(isPortableMoveDestination('archive/foo:bar.md', 'foo:bar.md', hasDir)).toBe(true)
    expect(isPortableMoveDestination('foo:parent/foo:bar.md', 'foo:bar.md', hasDir)).toBe(true)
    expect(isPortableMoveDestination('archive/other:bad.md', 'foo:bar.md', hasDir)).toBe(false)
    expect(isPortableMoveDestination('new:parent/foo:bar.md', 'foo:bar.md', hasDir)).toBe(false)
  })
})

describe('sluggedNoteName', () => {
  it("reports '' exactly when the id rung is what will name the file", () => {
    expect(sluggedNoteName('🎉🎉')).toBe('')
    expect(sluggedNoteName('Note')).toBe('note') // NOT '' — a title of "Note" is a name
    expect(sluggedNoteName('第三季度规划')).toBe('第三季度规划')
  })

  it('mirrors the fileName precedence noteFileBase applies', () => {
    expect(sluggedNoteName('My Note', '🎉')).toBe('my-note')
    expect(sluggedNoteName('🎉', '🎉')).toBe('')
  })
})

describe('noteFilePath', () => {
  it('joins the directory and adds the extension', () => {
    expect(noteFilePath('第三季度规划', 'journal')).toBe('journal/第三季度规划.md')
    expect(noteFilePath('Plans')).toBe('plans.md')
    expect(noteFilePath('Plans', '/')).toBe('plans.md')
    expect(noteFilePath('Plans', '/work/')).toBe('work/plans.md')
  })

  it('a name can neither escape its directory nor grow a second extension', () => {
    expect(noteFilePath('../../etc/passwd', 'journal')).toBe('journal/etc-passwd.md')
    expect(noteFilePath('note.md', 'journal')).toBe('journal/note-md.md')
  })
})
