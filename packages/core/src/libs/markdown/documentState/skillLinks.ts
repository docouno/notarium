import { isGeneratedNoteId } from '../../id'

export const SKILL_LINK_SCOPE = {
  personal: 'personal',
  space: 'space',
} as const

export type SkillLinkScope = (typeof SKILL_LINK_SCOPE)[keyof typeof SKILL_LINK_SCOPE]

export type SkillLink =
  | { kind: 'name'; name: string }
  | {
      kind: 'locator'
      source: 'system'
      packageId: string
      label: string
      raw: string
    }
  | {
      kind: 'locator'
      source: 'owned'
      scope: SkillLinkScope
      packageId: string
      label: string
      raw: string
    }
  | { kind: 'invalid'; raw: string; reason: 'invalid-locator' }

const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

/** What a skill may be called. One producer, because the answer is read in four places
 *  — the package projection, both arms of this parser and the serializer — and the
 *  LENGTH half of it used to be missing from three of them. A package whose name is
 *  too long is already refused by the projection; a LABEL inside an attachment token
 *  was not, so a hand-edited `SKILL.md` produced an attachment the wire could not
 *  carry and the detail door answered 500 for a package the host called valid.
 *  Mirrored on the wire by `SkillNameSchema`; core does not import `contract`. */
export const MAX_SKILL_NAME = 64

export const isSkillName = (value: string): boolean =>
  value.length <= MAX_SKILL_NAME && SKILL_NAME.test(value) && !value.includes('--')

/** The longest an attachment token may be, brackets included — and therefore the bound
 *  the WIRE has to carry an unrecognised one back under (`invalid.raw`), not the other
 *  way round.
 *
 *  The direction matters and was got wrong once. Narrowing what core RECOGNISES to fit
 *  a wire bound looks like the conservative move and is not: the authored list is
 *  rebuilt from what came back, so a token the parser stops recognising is a token
 *  DELETED from a package its author never saw it in — silently, on the first attach or
 *  detach. The loud 500 it replaced at least left the file intact. So recognition keeps
 *  its own domain and the wire is stated FROM it.
 *
 *  Counted in CODE POINTS, because the quantifier below is a `/u` regex and counts them
 *  too. The unit is load-bearing and was got wrong once: measured in UTF-16 units, a
 *  token of 1 024 emoji is twice this number, and the wire refused what the parser had
 *  just read. */
export const MAX_SKILL_TOKEN = 1_028

/** What a token IS. Anything longer than the bound above is not an attachment token at
 *  all, exactly as a token containing `]` is not one — the parser has a domain, and the
 *  wire is stated from it rather than the other way round. */
const WIKI_SKILL = /\[\[([^\]\r\n]{1,1024})\]\]/gu
const LOCATOR_SKILL = /^notarium-id:(system|personal|space):([^|]+)\|([a-z0-9][a-z0-9-]*)$/u

export const parseSkillLinks = (value: string): SkillLink[] => {
  const links: SkillLink[] = []

  for (const match of value.matchAll(WIKI_SKILL)) {
    const raw = match[0]
    const target = match[1]!

    if (isSkillName(target)) {
      links.push({ kind: 'name', name: target })
      continue
    }
    // Anything else is kept as it was written. Dropping it would make the authored
    // list the parser's opinion rather than the file's content: the first attach or
    // detach rebuilds the list from what came back, so a token silently skipped here
    // is a token deleted from a package its author never saw it in.
    const locator = LOCATOR_SKILL.exec(target)

    // The label is judged by the same rule as any other skill name. A token that names
    // a real package under a name no skill may have is not "an exact attachment with an
    // odd label" — it is a token this reader cannot resolve, and saying so keeps the
    // package readable instead of handing the wire a value it refuses.
    if (!locator || !isGeneratedNoteId(locator[2]!) || !isSkillName(locator[3]!)) {
      links.push({ kind: 'invalid', raw, reason: 'invalid-locator' })
      continue
    }
    links.push(
      locator[1] === 'system'
        ? {
            kind: 'locator',
            source: 'system',
            packageId: locator[2]!,
            label: locator[3]!,
            raw,
          }
        : {
            kind: 'locator',
            source: 'owned',
            scope: locator[1] as SkillLinkScope,
            packageId: locator[2]!,
            label: locator[3]!,
            raw,
          },
    )
  }

  return links
}

export const serializeSkillLocator = ({
  source = 'owned',
  scope,
  packageId,
  label,
}: {
  source?: 'system' | 'owned'
  scope?: SkillLinkScope
  packageId: string
  label: string
}): string => {
  if (
    !isGeneratedNoteId(packageId) ||
    (source === 'owned' && (!scope || !Object.values(SKILL_LINK_SCOPE).includes(scope))) ||
    (source === 'system' && scope !== undefined)
  ) {
    throw new Error('invalid skill locator')
  }
  if (!isSkillName(label)) {
    throw new Error('invalid skill locator label')
  }

  return `[[notarium-id:${source === 'system' ? 'system' : scope}:${packageId}|${label}]]`
}
