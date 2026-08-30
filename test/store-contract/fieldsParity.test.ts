// One input, one blob. The two engines' field axis is held against EACH OTHER over a
// generated corpus of authored frontmatter — not against a hand-written expectation,
// which would only ever pin the inputs whoever wrote it happened to think of.
//
// The column is derived by `core/libs/fields` on both sides, so a difference in the
// blob is never a difference in the builder: it is a difference in what the two
// engines decided the FILE says. `NotariumStore` writes those bytes; `InMemoryStore`
// reconstructs bytes it never had, which is exactly where the two can drift — and
// every field query, facet and card plate downstream inherits the drift.
//
// This lives beside describeKnowledgeStoreContract rather than inside it because the
// claim is about a PAIR, and that spec runs one engine at a time. Both legs are the
// BARE engines on purpose: the read-model's optimistic blob is a projection of
// WriteInput rather than of the engine, so putting the decorator on either side would
// compare it with itself. What the decorator owes — that the axis survives its own
// write and then agrees with the engine's derivation — is asserted per leg in the
// contract spec.
//
// The engine is raised on the same FOUR mounts the contract spec raises it on, and the
// corpus is swept across all four classes. A one-mount `user-doc` engine leaves the
// only class where the fake runs a carry branch of its own — the Agent Skill package
// root, which pins its own path across an edit and validates its manifest before it
// will take one — outside the comparison entirely.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildNoteFields,
  FIELDS_BLOB_BYTE_CAP,
  type KnowledgeStore,
  type NoteClass,
  parseFrontmatterLines,
  serializeNoteFields,
  utf8Bytes,
  type WriteInput,
} from '@notarium/core'
import { createNotariumStore } from '@notarium/engine'
import { InMemoryStore } from '@notarium/engine-memory'

const DIR = 'fields-parity'

/** Every class the contract spec mounts. The corpus rotates through them so each key
 *  state is seen on each class, rather than on `user-doc` alone. */
const CLASSES: readonly NoteClass[] = ['user-doc', 'agent-memory', 'profile', 'skill']

type Scenario = {
  name: string
  /** The authored frontmatter the note is created with, as raw YAML lines. */
  frontmatter?: string
  /** The body — which may itself open with a frontmatter block (a third incoming
   *  metadata channel both engines have to merge, not keep as prose). */
  content: string
  /** An optional second write, so a channel that RE-STATES a key is exercised too:
   *  most of the divergence surface is in what the second write does to the first
   *  one's block, not in what a create lays down. */
  edit?: { label: string; input: Partial<WriteInput> }
  /** Filled in by the generator for every scenario that does not pin one. */
  targetClass?: NoteClass
  /** Only the skill manifests pin one. A package ROOT is `<package>/SKILL.md` BY
   *  PATH, and `fileName` goes through the slug rung (`SKILL` → `skill.md`), so an
   *  exact address is the only channel that produces one. */
  restorePath?: string
  /** The second write is expected to be REFUSED, on both engines. */
  refused?: boolean
}

/** A scenario once the generator has settled its class — and with the NAME every report
 *  in this file addresses it by. The class is part of that name because the class is an
 *  axis of the corpus: two scenarios drawn from the same block and the same body differ
 *  only by it, and a report that printed the bare name left them indistinguishable (one
 *  such collision on a corpus with no duplicate INPUT at all). */
type Generated = Scenario & { targetClass: NoteClass; label: string }

const repeated = (count: number, line: (index: number) => string): string =>
  Array.from({ length: count }, (_, index) => line(index)).join('\n')

/** Enough `key<n>: value-<n>` lines that the serialized blob runs past the cap and
 *  the tail of the authored order is demoted to `truncated`. That is what turns a
 *  key's SLOT from a cosmetic detail into the answer: a typed key that keeps its
 *  authored slot keeps its value, and one that drifts to the end loses it. */
const CAP_OVERFLOW_KEYS = 260

/** The line the two cap-adjacent forms below are built out of. */
const capLine = (index: number): string => `key${index}: value-${index}`

/** How many of those lines still fit whole — the configuration where the next key is
 *  the first casualty. DERIVED from the cap through the shared builder, because a count
 *  someone measured once keeps the NAME "just under the cap" while quietly ceasing to
 *  mean it: this file shipped with 120, which is a blob of 0.56× the cap and leaves the
 *  tight configuration untested altogether. Raise or lower `FIELDS_BLOB_BYTE_CAP` and
 *  this follows, with no number here to update.
 *
 *  Bounded by the cap itself: a line costs more than one byte, so no count above that
 *  can still fit, and the throw says so rather than spinning. */
const VALUES_JUST_UNDER_THE_CAP = ((): number => {
  for (let count = 1; count <= FIELDS_BLOB_BYTE_CAP; count++) {
    if (buildNoteFields(parseFrontmatterLines(repeated(count + 1, capLine))).truncated) {
      return count
    }
  }

  throw new Error('no number of key/value lines overflows the fields blob cap')
})()

/** Authored blocks, one per key state the column encodes plus the shapes the
 *  frontmatter reader treats specially. */
const AUTHORED: Array<[string, string]> = [
  ['scalar and list values', 'status: in progress\nreviewers:\n- ann\n- bo'],
  ['an empty value', "blank: ''"],
  ['a nested map', 'broken:\n  nested: 1'],
  ['a bare key', 'bare:\nafter: 1'],
  ['a block scalar', 'note: |\n  line one\n  line two'],
  ['an empty block scalar', 'empty: |\nafter: 1'],
  ['an inline scalar wrapped onto a second line', 'wrapped: start\n  continued\nafter: 1'],
  ['a dangling flow list', 'flow: [a,\nafter: 1'],
  ['a __proto__ key', '__proto__: x\nafter: 1'],
  ['an integer-like key', '2026: budget\nname: plan'],
  ['a duplicate key whose last occurrence is unreadable', 'dup: one\ndup:\n  nested: 2'],
  ['two keys differing only in case', 'Priority: high\npriority: low'],
  ['a key containing a colon', 'https://example: note'],
  ['a bare and a quoted number', 'a: 3\nb: "3"'],
  ['keys the note projects onto its own metadata', 'slug: my-slug\ncreated: 2020-01-02\nafter: 1'],
  ['the protected keys that DO ride the column', 'type: task\nsummary: a digest\nview: board'],
  ['a typed key authored above ordinary ones', 'summary: an early digest\nalpha: 1\nbeta: 2'],
  ['a keyless comment line', '# a comment\nkeep: 1'],
  ['nothing at all', ''],
]

/** Blocks that make the byte cap speak. Swept separately from the list above: each
 *  one costs real parse work on both engines, and their point is the sacrifice
 *  sequence, not its interaction with every body shape. */
const DEGENERATE: Array<[string, string]> = [
  ['values just under the cap', repeated(VALUES_JUST_UNDER_THE_CAP, capLine)],
  [
    'a typed key authored first, values past the cap',
    `summary: an early digest\n${repeated(CAP_OVERFLOW_KEYS, capLine)}`,
  ],
  ['one value larger than the whole cap', `huge: ${'x'.repeat(5000)}\nafter: 1`],
  ['more key names than the cap can list', repeated(900, (i) => `a-rather-long-key-${i}: v${i}`)],
  [
    'more unreadable names than the cap can list',
    repeated(900, (i) => `an-unreadable-key-number-${i}:\n  nested: ${i}`),
  ],
  [
    'readable and unreadable names both past the cap',
    `${repeated(500, (i) => `a-long-readable-key-${i}: value-${i}`)}\n${repeated(
      500,
      (i) => `a-long-unreadable-key-${i}:\n  nested: ${i}`,
    )}`,
  ],
]

const BODIES: Array<[string, string]> = [
  ['a plain body', 'ordinary body text'],
  ['an empty body', ''],
  ['a body opening with a frontmatter block', '---\ninline: yes\n---\n\nbody after the block'],
  ['a body block carrying a list', '---\ninline:\n- one\n- two\n---\n\nbody'],
  ['a body block shadowing an authored key', '---\nstatus: from the body\nalpha: 9\n---\n\nbody'],
  ['a body block with a comment in it', '---\n# inline comment\ninline: yes\n---\n\nbody'],
  ['a body that is only a block', '---\nonly: 1\n---\n'],
]

const EDITS: Array<Scenario['edit'] & object> = [
  { label: 'no second write', input: {} },
  { label: 'summary set', input: { summary: 'a new digest' } },
  { label: 'summary cleared', input: { summary: '' } },
  { label: 'noteType set', input: { noteType: 'decision' } },
  { label: 'noteType cleared', input: { noteType: '' } },
  { label: 'muted set', input: { muted: true } },
  { label: 'muted cleared', input: { muted: false } },
  { label: 'tags set', input: { tags: ['x', 'y'] } },
  { label: 'slug set', input: { slug: 'a-new-slug' } },
  { label: 'createdAt set', input: { createdAt: '2021-03-04T00:00:00.000Z' } },
  { label: 'one key patched', input: { frontmatter: parseFrontmatterLines('status: done') } },
  {
    label: 'the same keys re-sent',
    input: { frontmatter: parseFrontmatterLines('status: in progress\nreviewers:\n- ann\n- bo') },
  },
  {
    label: 'a duplicated key and a comment',
    input: { frontmatter: parseFrontmatterLines('dup: one\ndup: two\n# a comment') },
  },
  {
    label: 'a key turned unreadable',
    input: { frontmatter: parseFrontmatterLines('status:\n  nested: 1') },
  },
  {
    label: 'the same key through the raw AND the typed channel',
    input: {
      summary: 'from the typed channel',
      frontmatter: parseFrontmatterLines('summary: raw'),
    },
  },
  {
    label: 'a replacing write',
    input: {
      frontmatter: parseFrontmatterLines('fresh: 1\nother: 2'),
      frontmatterMode: 'replace' as const,
    },
  },
  {
    label: 'a replacing write with nothing in it',
    input: { frontmatter: [], frontmatterMode: 'replace' as const },
  },
  { label: 'a body block arriving later', input: { content: '---\nlater: 1\n---\n\nnew body' } },
  {
    label: 'a body block carrying typed keys',
    input: { content: '---\ntype: from-the-body\nsummary: from the body\n---\n\nbody' },
  },
]

/** The two forms review caught the fake on (IMPL-03, IMPL-17), named so that a
 *  regression reads as itself instead of as "generated scenario #137". The cap
 *  variant of the first is the one that moves a VALUE out of the column: on a note
 *  near the cap the authored slot decides whether `summary` keeps its value or is
 *  demoted to `truncated`. */
const REGRESSION_FORMS: Scenario[] = [
  {
    name: 'a typed key set again keeps its authored slot',
    frontmatter: 'summary: an early digest\nalpha: 1\nbeta: 2',
    content: 'body',
    edit: { label: 'summary set', input: { summary: 'a new digest' } },
  },
  {
    name: 'a typed key set again keeps its slot with the cap in play',
    frontmatter: `summary: an early digest\n${repeated(CAP_OVERFLOW_KEYS, (i) => `key${i}: value-${i}`)}`,
    content: 'body',
    edit: { label: 'summary set', input: { summary: 'a new digest' } },
  },
  {
    name: 'a frontmatter block riding the body is incoming metadata',
    content: '---\ninline: yes\n---\n\nbody after the block',
  },
  {
    name: 'a body block merges under WriteInput.frontmatter',
    frontmatter: 'raw: 1',
    content: '---\ninline: yes\n---\n\nbody',
  },
]

/** The Agent Skill package ROOT — the one shape where the fake stops being a thin
 *  mirror and runs a branch of its own: it pins the manifest's path across an edit
 *  (title renames every other note's file) and refuses a write whose manifest no
 *  longer projects a name. Both of those decide which bytes the block ends up
 *  holding, so the column derived from them belongs in this comparison. `name` and
 *  `description` are the manifest's typed channels and ride the column like any other
 *  authored key (design/00, "Protected keys" — deliberately NOT protected). */
const SKILL_MANIFESTS: Scenario[] = [
  {
    name: 'a skill manifest with authored keys around its typed ones',
    frontmatter: 'name: parity-alpha\ndescription: the alpha package\nalpha: 1\nbeta: 2',
    content: 'manifest body',
    targetClass: 'skill',
    restorePath: '.notarium/skills/parity-alpha/SKILL.md',
    edit: { label: 'one key patched', input: { frontmatter: parseFrontmatterLines('alpha: 2') } },
  },
  {
    name: 'a skill manifest whose typed digest is re-stated',
    frontmatter:
      'name: parity-beta\ndescription: the beta package\nsummary: an early digest\ngamma: 3',
    content: 'manifest body',
    targetClass: 'skill',
    restorePath: '.notarium/skills/parity-beta/SKILL.md',
    // The rename is the point: every other note follows its title to a new basename,
    // and a package root does NOT — both engines pin it, and the address gate below
    // is what says so. Without a title change the generic "same title, same folder"
    // rule preserves the path anyway and the pin is never asked.
    edit: {
      label: 'summary set and the manifest renamed',
      input: { summary: 'a new digest', title: 'Parity Renamed Manifest' },
    },
  },
  {
    name: 'a skill manifest at the cap',
    frontmatter: `name: parity-gamma\ndescription: the gamma package\n${repeated(
      CAP_OVERFLOW_KEYS,
      (i) => `key${i}: value-${i}`,
    )}`,
    content: 'manifest body',
    targetClass: 'skill',
    restorePath: '.notarium/skills/parity-gamma/SKILL.md',
    edit: { label: 'summary set', input: { summary: 'a new digest' } },
  },
  {
    // The branch itself: a package root validates its own manifest out of the CARRY
    // before it will take a write, so a patch that makes `name` unprojectable is a
    // refusal rather than a note. Both engines run that fence separately — the fake
    // reads the carry it holds, the real one the file it wrote — and a fence that
    // fires on one engine and not the other is a divergence the blobs cannot show.
    name: 'a skill manifest whose second write breaks its own manifest',
    frontmatter: 'name: parity-delta\ndescription: the delta package\nalpha: 1',
    content: 'manifest body',
    targetClass: 'skill',
    restorePath: '.notarium/skills/parity-delta/SKILL.md',
    refused: true,
    edit: {
      label: 'the manifest name turned unreadable',
      input: { frontmatter: parseFrontmatterLines('name:\n  nested: 1') },
    },
  },
]

/** Deterministic by construction — a fixed-seed LCG, never Math.random: a parity
 *  test that generates a different corpus per run reports a different failure per
 *  run, and the input that broke the build is gone by the time anyone looks. */
const scenarios = () => {
  let seed = 0x384f1e1d

  const pick = <T>(list: readonly T[]): T => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return list[(seed >>> 8) % list.length]
  }
  const out: Scenario[] = [...REGRESSION_FORMS, ...SKILL_MANIFESTS]
  // What the generator actually DREW. The authored blocks and the cap forms are in
  // the corpus unconditionally; the body and the second write are not, and a coverage
  // gate that only reads the blobs cannot tell the difference — it would stay green
  // through a re-seed that stopped drawing half of either list.
  const drawn = { bodies: new Set<string>(), edits: new Set<string>() }

  // Every authored block against a drawn body and a drawn second write; four passes,
  // so each block is seen under four different combinations.
  for (let pass = 0; pass < 4; pass++) {
    for (const [authoredName, frontmatter] of AUTHORED) {
      const [bodyName, content] = pick(BODIES)
      const edit = pick(EDITS)

      drawn.bodies.add(bodyName)
      drawn.edits.add(edit.label)
      out.push({
        name: `${authoredName} | ${bodyName} | ${edit.label}`,
        frontmatter,
        content,
        edit,
      })
    }
  }
  // The cap forms take a plain body and only the writes that restate a key.
  for (const [degenerateName, frontmatter] of DEGENERATE) {
    for (const edit of [EDITS[0], EDITS[1], EDITS[10]]) {
      out.push({ name: `${degenerateName} | ${edit.label}`, frontmatter, content: 'body', edit })
    }
  }

  // The class rotates by POSITION, not by draw: a corpus this size would leave a
  // class uncovered often enough for the sweep to be a coincidence, and the class is
  // the axis the fake models by hand (it owns no mount table).
  const corpus: Generated[] = out.map((scenario, index) => {
    const targetClass = scenario.targetClass ?? CLASSES[index % CLASSES.length]

    return { ...scenario, targetClass, label: `${scenario.name} | ${targetClass}` }
  })

  return { corpus, drawn }
}

/** A window on the first byte where two blobs part company. The degenerate forms run
 *  to the 4 KiB cap, and a failure that prints two of those in full buries the one
 *  key that actually moved. */
const around = (blob: string | null | undefined, left?: string | null, right?: string | null) => {
  if (blob === undefined) {
    return '<the note is missing from list()>'
  }
  if (blob === null) {
    return '<the engine listed the note with no fields column at all>'
  }
  let at = 0

  while (at < (left?.length ?? 0) && left![at] === right?.[at]) {
    at++
  }
  const from = Math.max(0, at - 60)
  const to = Math.min(blob.length, at + 120)

  return `${from ? '…' : ''}${blob.slice(from, to)}${to < blob.length ? '…' : ''}`
}

/** Run the corpus through one engine's PRODUCT write path and read the axis back off
 *  the snapshot the way a caller does — list(), not a private projection.
 *
 *  `null` means the engine listed the note and served NO column. That is a different
 *  finding from "a different column", and it is kept apart on purpose: substituting
 *  `{"keys":{}}` for an absent one would make an engine that stopped putting `fields`
 *  into `list()` agree with one that still does, on every note without authored keys. */
const blobsOf = async (store: KnowledgeStore, corpus: readonly Generated[]) => {
  /** The title a scenario's note ends up under, mapped back to the scenario's own key:
   *  a second write may RENAME the note, and one of the manifests does exactly that. */
  const keyByFinalTitle = new Map<string, string>()
  /** Scenarios whose second write this engine REFUSED. A refusal is an answer, and
   *  the two engines have to give the same one — it never reaches the blobs. */
  const refused: string[] = []

  for (const [index, scenario] of corpus.entries()) {
    const title = `Parity ${index}`
    const editAddress = { ...(scenario.targetClass ? { targetClass: scenario.targetClass } : {}) }
    // A manifest is addressed exactly; everything else lands by folder. The edit
    // hands no address at all in the first case — the engines' own rule that a
    // package root keeps its path across a title change is part of what is compared.
    const address = scenario.restorePath
      ? { ...editAddress, restorePath: scenario.restorePath }
      : { ...editAddress, directory: DIR }

    keyByFinalTitle.set((scenario.edit?.input.title as string | undefined) ?? title, title)
    const created = await store.write({
      title,
      ...address,
      content: scenario.content,
      ...(scenario.frontmatter ? { frontmatter: parseFrontmatterLines(scenario.frontmatter) } : {}),
    })

    if (scenario.edit && Object.keys(scenario.edit.input).length) {
      try {
        await store.write({
          title,
          ...(scenario.restorePath ? editAddress : address),
          content: 'the edited body',
          originalId: created.id ?? created.filePath,
          versionToken: created.versionToken,
          ...scenario.edit.input,
        })
      } catch {
        refused.push(scenario.label)
      }
    }
  }
  const listed = new Map<string, { blob: string | null; filePath: string }>()

  // `scope: 'all'` because three of the four classes are hidden from the default
  // surface — without it the sweep would silently compare `user-doc` alone again.
  for (const note of await store.list({ scope: 'all' })) {
    const key = keyByFinalTitle.get(note.title)

    if (key) {
      listed.set(key, {
        blob: note.fields ? serializeNoteFields(note.fields) : null,
        filePath: note.filePath,
      })
    }
  }

  return { listed, refused }
}

describe('field axis parity across engines', () => {
  it('derives the same blob from the same input on both engines', async () => {
    const { corpus, drawn } = scenarios()
    const notesDir = mkdtempSync(join(tmpdir(), 'notarium-fields-parity-'))
    // The same four mounts the contract spec raises, for the same reason: `class` is
    // mount-derived on the real engine and hand-modelled on the fake, and the skill
    // mount is the one where the fake carries a branch of its own.
    const notarium = createNotariumStore({
      mounts: [
        { class: 'user-doc', dir: notesDir, prefix: '' },
        {
          class: 'agent-memory',
          dir: join(notesDir, '.notarium/memory'),
          prefix: '.notarium/memory',
        },
        { class: 'profile', dir: join(notesDir, '.notarium/profile'), prefix: '.notarium/profile' },
        { class: 'skill', dir: join(notesDir, '.notarium/skills'), prefix: '.notarium/skills' },
      ],
    })
    const inMemory = new InMemoryStore({
      space: 'main',
      now: '2026-06-10T12:00:00.000Z',
      notes: [],
    })

    try {
      const engineRun = await blobsOf(notarium, corpus)
      const fakeRun = await blobsOf(inMemory, corpus)
      const engineNotes = engineRun.listed
      const fakeNotes = fakeRun.listed
      const diverged: Array<{ scenario: string; notarium?: string; inMemory?: string }> = []

      // Every report below names a scenario by its label, so no two scenarios may share
      // one. Asserted rather than assumed: the class was added to the label precisely
      // because the generator produced a collision without it.
      expect(new Set(corpus.map((scenario) => scenario.label)).size).toBe(corpus.length)

      for (const [index, scenario] of corpus.entries()) {
        const title = `Parity ${index}`
        const engine = engineNotes.get(title)?.blob
        const fake = fakeNotes.get(title)?.blob

        if (engine !== fake) {
          diverged.push({
            scenario: scenario.label,
            notarium: around(engine, engine, fake),
            inMemory: around(fake, engine, fake),
          })
        }
      }
      expect(diverged).toEqual([])

      // An engine that served no column at all agrees with itself on every note that
      // has no authored keys, so "same blob" cannot be the only thing checked: both
      // legs have to have ANSWERED. This is the shape `metaOf` dropping `fields` from
      // list() takes, and it is invisible to the comparison above.
      const withoutAColumn = corpus.flatMap((scenario, index) =>
        engineNotes.get(`Parity ${index}`)?.blob == null ||
        fakeNotes.get(`Parity ${index}`)?.blob == null
          ? [scenario.label]
          : [],
      )
      expect(withoutAColumn).toEqual([])

      // A refusal is an answer both engines have to give — and give for the same input.
      // It never reaches a blob, so the comparison above is blind to an engine that
      // took a write the other one fenced off.
      expect({ notarium: engineRun.refused, inMemory: fakeRun.refused }).toEqual({
        notarium: corpus.flatMap((scenario) => (scenario.refused ? [scenario.label] : [])),
        inMemory: corpus.flatMap((scenario) => (scenario.refused ? [scenario.label] : [])),
      })

      // …and the manifests really landed as package ROOTS on both engines, at the same
      // address. `SKILL.md` is the whole trigger for the fake's own branch, and an
      // address that slugged to `skill.md` on the way in would leave that branch
      // untested while the comparison above stayed green.
      expect(
        corpus.flatMap((scenario, index) =>
          scenario.restorePath
            ? [
                [
                  engineNotes.get(`Parity ${index}`)?.filePath,
                  fakeNotes.get(`Parity ${index}`)?.filePath,
                ],
              ]
            : [],
        ),
      ).toEqual(SKILL_MANIFESTS.map((scenario) => [scenario.restorePath, scenario.restorePath]))

      // The cap is an invariant over the serialized object, and it holds on whatever
      // this corpus produced — the same measurement the builder makes, taken from
      // outside it.
      for (const note of engineNotes.values()) {
        expect(utf8Bytes(note.blob!)).toBeLessThanOrEqual(FIELDS_BLOB_BYTE_CAP)
      }

      // A parity check is only worth its runtime if the corpus still reaches the
      // states it was built for: a generator that silently degenerated to empty
      // blobs would agree on every leg and prove nothing.
      //
      // Two halves, because the corpus has two halves. The predicates below read the
      // BLOBS, and every state they name comes from a block this file adds
      // unconditionally — so they say nothing whatever about the drawn dimensions.
      // What the generator chose is gated first, by name.
      expect({
        bodies: [...drawn.bodies].sort(),
        edits: [...drawn.edits].sort(),
        classes: [...new Set(corpus.map((scenario) => scenario.targetClass!))].sort(),
      }).toEqual({
        bodies: BODIES.map(([name]) => name).sort(),
        edits: EDITS.map((edit) => edit.label).sort(),
        classes: [...CLASSES].sort(),
      })

      // The cap-adjacent form really is adjacent, and stays so if the cap moves: this
      // many values fit whole and one more does not. Without it a search that silently
      // returned its first candidate would leave the corpus with no tight configuration
      // at all — which is the state this file was in, at 0.56× the cap.
      expect({
        fits: buildNoteFields(parseFrontmatterLines(repeated(VALUES_JUST_UNDER_THE_CAP, capLine)))
          .truncated,
        spills: Boolean(
          buildNoteFields(parseFrontmatterLines(repeated(VALUES_JUST_UNDER_THE_CAP + 1, capLine)))
            .truncated?.length,
        ),
      }).toEqual({ fits: undefined, spills: true })

      const seen = [...engineNotes.values()].map((note) => note.blob!)
      const reaches = (predicate: (blob: string) => boolean) => seen.filter(predicate).length

      expect({
        emptyBlob: reaches((blob) => blob === '{"keys":{}}') > 0,
        listValue: reaches((blob) => blob.includes('["ann","bo"]')) > 0,
        emptyValue: reaches((blob) => blob.includes('"blank":""')) > 0,
        unreadable: reaches((blob) => blob.includes('"unreadable":[')) > 0,
        truncated: reaches((blob) => blob.includes('"truncated":[')) > 0,
        truncatedMore: reaches((blob) => blob.includes('"truncatedMore":')) > 0,
        unreadableMore: reaches((blob) => blob.includes('"unreadableMore":')) > 0,
        // …and the states only a DRAWN body or a DRAWN second write can produce: a
        // key that arrived on the body's own fenced block, one the block shadowed,
        // and one a replacing write brought in. These three are the reason the two
        // lists are swept at all, and until now nothing said they were reached.
        bodyBlockKey: reaches((blob) => blob.includes('"inline":"yes"')) > 0,
        bodyBlockShadow: reaches((blob) => blob.includes('"status":"from the body"')) > 0,
        replacedBlock: reaches((blob) => blob.includes('"fresh":"1"')) > 0,
      }).toEqual({
        emptyBlob: true,
        listValue: true,
        emptyValue: true,
        unreadable: true,
        truncated: true,
        truncatedMore: true,
        unreadableMore: true,
        bodyBlockKey: true,
        bodyBlockShadow: true,
        replacedBlock: true,
      })
    } finally {
      await notarium.stop()
      rmSync(notesDir, { recursive: true, force: true })
    }
  }, 120_000)
})
