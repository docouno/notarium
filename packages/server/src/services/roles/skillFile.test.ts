// SKILL.md is read and rewritten by the SAME predicate the rest of the domain uses, so a
// manifest is not a seventh opinion about where frontmatter is.
// canon: docs/core.md#write-through

import { describe, expect, it } from 'vitest'
import { frontmatterValue } from '@notarium/core'

import { parseSkillFile, withCatalogProvenance, withFreshNoteId, withSkillLinks } from './skillFile'

const MANIFEST =
  '---\nname: review\ndescription: Review the changes on a branch\n---\n\n# Review\n\nSteps here.\n'
const BOM = '\uFEFF'

describe('skill manifests behind an encoding prologue', () => {
  it.each([
    ['a plain manifest', MANIFEST],
    ['a marked manifest', `${BOM}${MANIFEST}`],
    ['a marked CRLF manifest', `${BOM}${MANIFEST.replace(/\n/gu, '\r\n')}`],
  ])('parses %s', (_name, raw) => {
    expect(parseSkillFile(raw, 'review').name).toBe('review')
  })

  it.each([
    ['withSkillLinks', (raw: string) => withSkillLinks(raw, ['other'])],
    ['withFreshNoteId', (raw: string) => withFreshNoteId(raw, 'AbCdEfGhIjKl')],
    ['withCatalogProvenance', (raw: string) => withCatalogProvenance(raw, 'pkg', 'rev')],
  ])('%s keeps the mark leading, exactly once, and the result still parses', (_name, rewrite) => {
    const out = rewrite(`${BOM}${MANIFEST}`)

    expect(out.charCodeAt(0)).toBe(0xfeff)
    expect(out.match(/\uFEFF/gu)).toHaveLength(1)
    expect(parseSkillFile(out, 'review').name).toBe('review')
    // The authored body rides through untouched — the mark is the only thing added.
    expect(out).toContain('Steps here.')
  })

  it.each([
    ['withSkillLinks', (raw: string) => withSkillLinks(raw, ['other'])],
    ['withFreshNoteId', (raw: string) => withFreshNoteId(raw, 'AbCdEfGhIjKl')],
    ['withCatalogProvenance', (raw: string) => withCatalogProvenance(raw, 'pkg', 'rev')],
  ])('%s invents no mark for a file that had none', (_name, rewrite) => {
    expect(rewrite(MANIFEST)).not.toContain(BOM)
  })

  // A CRLF manifest is the shape a Windows author (or `core.autocrlf`) produces. Reading
  // its payload by hunting `\n---` finds the `\n` of the closing fence's CRLF pair and
  // leaves the `\r` on the last entry, which YAML reads as part of that value — so the
  // rewrite put `name: "review\r"` into the file and the package stopped parsing.
  it.each([
    ['withSkillLinks', (raw: string) => withSkillLinks(raw, ['other'])],
    ['withFreshNoteId', (raw: string) => withFreshNoteId(raw, 'AbCdEfGhIjKl')],
    ['withCatalogProvenance', (raw: string) => withCatalogProvenance(raw, 'pkg', 'rev')],
  ])('%s carries a CRLF manifest through without pulling the fence into a value', (_n, rewrite) => {
    // `name:` LAST is load-bearing: it is the value the stray CR lands on.
    const crlf =
      '---\r\ndescription: Review the changes on a branch\r\nname: review\r\n---\r\n\r\n# Review\r\n'
    const out = rewrite(crlf)
    const parsed = parseSkillFile(out, 'review')

    expect(parsed.name).toBe('review')
    expect(parsed.description).toBe('Review the changes on a branch')
  })

  it('keeps a CRLF manifest note id readable after a rewrite', () => {
    const crlf =
      '---\r\nname: review\r\ndescription: Review the changes\r\nnotarium-id: AbCdEfGhIjKl\r\n---\r\n\r\n# Review\r\n'

    expect(frontmatterValue(withSkillLinks(crlf, ['other']), 'notarium-id')).toBe('AbCdEfGhIjKl')
  })

  // The shape `PREP-10` was raised for: a role attachment reads SKILL.md as BYTES out of
  // the package on disk, rewrites it, and re-parses the result (`roles.ts` — `currentRaw`
  // → `withSkillLinks` → `parsePackage`). A regression inside `skillFile` is caught by the
  // cases above; a regression in that round trip through Buffer is not.
  it.each([
    ['a marked manifest', `${BOM}${MANIFEST}`],
    ['a marked CRLF manifest', `${BOM}${MANIFEST.replace(/\n/gu, '\r\n')}`],
    [
      'a CRLF manifest whose name is last',
      '---\r\ndescription: Reviews\r\nname: review\r\n---\r\n\r\n# Review\r\n',
    ],
  ])('survives the package round trip: %s', (_name, authored) => {
    // Exactly what the attachment path does, byte for byte.
    const onDisk = Buffer.from(authored, 'utf8')
    const rewritten = withSkillLinks(Buffer.from(onDisk).toString('utf8'), ['other'])
    const reparsed = parseSkillFile(Buffer.from(Buffer.from(rewritten)).toString('utf8'), 'review')

    expect(reparsed.name).toBe('review')
    expect(reparsed.metadata['notarium.skills']).toBe('other')
  })

  it('still refuses a file with no manifest block at all', () => {
    expect(() => parseSkillFile('# Review\n\nno frontmatter\n', 'review')).toThrow(
      /frontmatter is required/u,
    )
    // A leading rule that is not a block is prose, exactly as the domain reads it.
    expect(() => withSkillLinks('   ---\nname: x\n---\n', ['a'])).toThrow(
      /frontmatter is required/u,
    )
  })
})
