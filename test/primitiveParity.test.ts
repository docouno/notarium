// Executable parity gate for the duplicated durable Unicode/path grammar.
// canon: docs/architecture.md#p8
import { describe, expect, it } from 'vitest'

import {
  DurableAddressPathSchema,
  DurablePathSchema,
  DurableScalarSchema,
  DurableTextSchema,
  PortablePathComponentSchema,
} from '@notarium/contract'
import {
  isDurableScalar,
  isDurableText,
  isPortablePathComponent,
  normalizeSafeRelativeAddress,
  normalizeSafeRelativePath,
} from '@notarium/core'

/** Every single UTF-16 code unit, so no range — C0/C1, the surrogate block, the
 *  specials — is probed only where someone remembered to write a case. */
const singleCodeUnits = Array.from({ length: 0x10000 }, (_, unit) => String.fromCharCode(unit))

/** Well-formed pairs: the BMP/astral boundary, the last code point and common emoji. */
const surrogatePairs = [
  String.fromCodePoint(0x10000),
  String.fromCodePoint(0x10ffff),
  '🎉',
  '🚀',
  '👩‍💻',
  '🇺🇦',
  'a🎉b',
]

/** `repeat` to an exact UTF-8 byte length: 1-, 2-, 3- and 4-byte code points each
 *  straddling the 255-byte component fence, because a cap counted in CHARACTERS
 *  passes exactly the names a filesystem then refuses. */
const bytes255 = [
  'a'.repeat(255),
  'a'.repeat(256),
  'ф'.repeat(127) + 'a',
  'ф'.repeat(128),
  '第'.repeat(85),
  '第'.repeat(85) + 'a',
  '🎉'.repeat(63) + 'abc',
  '🎉'.repeat(64),
]

const superscriptDeviceNames = ['¹', '²', '³'].flatMap((digit) => [
  `COM${digit}`,
  `com${digit}.md`,
  `LPT${digit}`,
  `lpt${digit}.txt`,
])

const explicitCases = [
  // Scripts: romanisable and not.
  'note',
  'Заметка',
  '第三季度规划',
  '会議の議事録',
  // The same name spelled NFC and NFD.
  'Caf\u00e9',
  'Cafe\u0301',
  // Whitespace, C0/C1 and every line separator, embedded rather than alone.
  ' ',
  '\t',
  'a b',
  'a\tb',
  // C0 controls: the two the durable-text fence rejects (VT/FF) and the ones
  // markdown legitimately carries (tab, CR, LF).
  'a\u0000b',
  'a\u0007b',
  'a\u000bb',
  'a\u000cb',
  'a\u001fb',
  'a\u007fb',
  // C1 range, and the line separators an ordinary /\r?\n/ check misses.
  'a\u0080b',
  'a\u009fb',
  'a\rb',
  'a\nb',
  'a\r\nb',
  'a\u0085b',
  'a\u2028b',
  'a\u2029b',
  // Structural path shapes.
  '',
  '.',
  '..',
  'a/../b',
  '../a',
  '.hidden',
  'a/.hidden/b',
  '.hidden/a',
  '/abs',
  '/',
  '//',
  'a//b',
  'a/b',
  'a\\b',
  '\\a',
  'a\\..\\b',
  './a',
  'a/./b',
  'a/',
  '/a/',
  // Legacy POSIX component the address grammar must keep addressable.
  'foo:bar',
  'a/foo:bar/b',
  // Windows device names, their case and extension variants, and the superscript
  // digit forms the fence deliberately covers.
  'CON',
  'con',
  'Con.txt',
  'PRN',
  'AUX',
  'nul',
  'COM1',
  'com1.md',
  'LPT9',
  'lpt9.md',
  ...superscriptDeviceNames,
  'CONSOLE',
  'a/CON/b',
  // Trailing dot and trailing space, bare and as a path component.
  'foo.',
  'foo ',
  'a/foo./b',
  'a/foo /b',
  ' foo',
  // Reserved-looking but ordinary content.
  'notarium-id:abc',
  '[[wiki]]',
  '#tag',
]

const CORPUS = [...new Set([...singleCodeUnits, ...surrogatePairs, ...bytes255, ...explicitCases])]

const diagnosticValue = (value: string): string =>
  JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )

/** The five relations the two decoupled implementations must agree on, each as
 *  (wire schema, engine predicate). */
const RELATIONS: ReadonlyArray<
  [
    name: string,
    schema: { safeParse: (v: string) => { success: boolean } },
    guard: (v: string) => boolean,
  ]
> = [
  ['DurableTextSchema ↔ isDurableText', DurableTextSchema, isDurableText],
  ['DurableScalarSchema ↔ isDurableScalar', DurableScalarSchema, isDurableScalar],
  [
    'DurablePathSchema ↔ normalizeSafeRelativePath',
    DurablePathSchema,
    (value) => normalizeSafeRelativePath(value) !== null,
  ],
  [
    'DurableAddressPathSchema ↔ normalizeSafeRelativeAddress',
    DurableAddressPathSchema,
    (value) => normalizeSafeRelativeAddress(value) !== null,
  ],
  [
    'PortablePathComponentSchema ↔ isPortablePathComponent',
    PortablePathComponentSchema,
    (value) => isDurableScalar(value) && isPortablePathComponent(value),
  ],
]

describe('primitive grammar drift across the P8 core/contract seam', () => {
  it.each(RELATIONS)('%s agrees on every corpus value', (name, schema, guard) => {
    // Collected rather than asserted per value: 65k+ values × 5 relations is a
    // third of a million comparisons, and a report that names the pair and the
    // exact offending value localizes drift better than the first thrown expect.
    const drift: string[] = []

    for (const value of CORPUS) {
      const wire = schema.safeParse(value).success
      const engine = guard(value)

      if (wire !== engine) {
        drift.push(`${name}: ${diagnosticValue(value)} → contract=${wire} core=${engine}`)
      }
    }

    expect(drift).toEqual([])
  })

  it('probes every UTF-16 code unit plus the explicit multi-unit cases', () => {
    // A silently shrunken corpus would turn this file green without proving
    // anything, so the coverage claim above is itself asserted.
    expect(singleCodeUnits).toHaveLength(0x10000)
    expect(singleCodeUnits[0]).toBe('\u0000')
    expect(singleCodeUnits[0xffff]).toBe('\uffff')
    expect(singleCodeUnits.every((value, unit) => value === String.fromCharCode(unit))).toBe(true)
    expect(CORPUS).toContain(String.fromCharCode(0xd800)) // a lone high surrogate
    expect(CORPUS).toEqual(expect.arrayContaining(superscriptDeviceNames))
    expect(CORPUS).toContain('a'.repeat(256))
  })

  it('escapes C1 and Unicode line separators in drift diagnostics', () => {
    expect(diagnosticValue('a\u007fb\u0080c\u0085d\u009fe\u2028f\u2029g')).toBe(
      '"a\\u007fb\\u0080c\\u0085d\\u009fe\\u2028f\\u2029g"',
    )
  })
})
