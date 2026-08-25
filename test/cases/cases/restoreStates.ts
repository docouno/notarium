import { daysBefore, WorldBuilder } from '../generators'
import type { CaseSpec } from '../types'

const deletedNote = (
  builder: WorldBuilder,
  now: Date,
  input: { path: string; title: string; class?: 'user-doc' | 'skill' },
): string =>
  builder.note({
    space: 'main',
    path: input.path,
    title: input.title,
    class: input.class,
    content: `# ${input.title}\n\nCurrent body before deletion.\n`,
    created: daysBefore(now, 40, 9),
    deletedAt: daysBefore(now, 12, 10),
    principal: 'user:sergey',
  })

/** One compact manual/browser world for #275's public state algebra. Every
 * non-ordinary revision is declared once and materialized by both appliers. */
export const restoreStates: CaseSpec = {
  name: 'restore-states',
  description:
    'Exact raw, blocked, legacy, gap, opaque UTF-8/base64 and direct-SKILL revision states for history/trash restore proof (#275), plus a live 830 KB note and a live control-byte note (#392).',
  axes: ['history', 'trash', 'note-classes'],
  build: ({ now }) => {
    const b = new WorldBuilder(now)
    b.space({ slug: 'main', displayName: 'Restore states' })
    b.user({ username: 'sergey', password: 'seed-pass', displayName: 'Sergey', admin: true })
    b.member({ space: 'main', username: 'sergey', role: 'owner' })

    const exact = b.note({
      space: 'main',
      path: 'restore/exact-unicode.md',
      title: 'Exact Unicode history',
      content: '# Exact Unicode history\n\nCurrent state.\n',
      created: daysBefore(now, 40, 9),
      principal: 'user:sergey',
    })
    b.revisionState({
      note: exact,
      date: daysBefore(now, 3, 9),
      title: 'Exact Ω history',
      state: {
        kind: 'document',
        source: {
          encoding: 'utf8',
          data: '---\r\n# authored comment\r\nnotarium-id: "{{noteId}}" # owner\r\nnotarium-created: \'{{createdAt}}\'\r\nplugin: &value "café Ω"\r\ncopy: *value\r\ntitle: Exact Ω history\r\n---\r\nRaw body with spaces  \r\n',
        },
        ownerClaims: [
          { key: 'notarium-id', ownership: 'value' },
          { key: 'notarium-created', ownership: 'value' },
        ],
        generatedContainer: true,
      },
    })

    const exactTrash = deletedNote(b, now, {
      path: 'restore/exact-restorable-deletion.md',
      title: 'Exact restorable deletion',
    })
    b.revisionState({
      note: exactTrash,
      date: daysBefore(now, 5, 8),
      kind: 'delete',
      state: {
        kind: 'document',
        source: {
          encoding: 'utf8',
          data: '---\r\nnotarium-id: "{{noteId}}"\r\nnotarium-created: "{{createdAt}}"\r\ntitle: Exact restorable deletion\r\nplugin: keep-this-authored-field\r\n---\r\nThis complete deleted state is safe to restore.  \r\n',
        },
        ownerClaims: [
          { key: 'notarium-id', ownership: 'value' },
          { key: 'notarium-created', ownership: 'value' },
        ],
        generatedContainer: true,
      },
    })

    const blocked = deletedNote(b, now, {
      path: 'restore/blocked-owner-anchor.md',
      title: 'Blocked owner anchor',
    })
    b.revisionState({
      note: blocked,
      date: daysBefore(now, 5, 9),
      kind: 'delete',
      state: {
        kind: 'document',
        source: {
          encoding: 'utf8',
          data: '---\nnotarium-id: &owner "{{noteId}}"\ncopy: *owner\ntitle: Blocked owner anchor\n---\nCannot safely rebind this owner.\n',
        },
        ownerClaims: [{ key: 'notarium-id', ownership: 'value' }],
      },
    })

    const legacy = deletedNote(b, now, {
      path: 'restore/legacy-partial.md',
      title: 'Legacy partial snapshot',
    })
    b.revisionState({
      note: legacy,
      date: daysBefore(now, 5, 10),
      kind: 'delete',
      state: { kind: 'legacy', content: 'Legacy body only; authored metadata is unknown.\n' },
    })

    const gap = deletedNote(b, now, {
      path: 'restore/honest-gap.md',
      title: 'Honest content gap',
    })
    b.revisionState({
      note: gap,
      date: daysBefore(now, 5, 11),
      kind: 'delete',
      state: { kind: 'gap' },
    })

    const opaqueUtf8 = deletedNote(b, now, {
      path: 'restore/opaque-utf8.md',
      title: 'Opaque UTF-8 source',
    })
    b.revisionState({
      note: opaqueUtf8,
      date: daysBefore(now, 5, 12),
      kind: 'delete',
      state: {
        kind: 'document',
        role: 'skill-root',
        skillDirectoryName: 'opaque-utf8',
        source: {
          encoding: 'utf8',
          data: '---\nname: invalid--package\ndescription: Invalid skill name\n---\nThis remains literal UTF-8 source, not Markdown.\n',
        },
      },
    })

    const opaqueBytes = deletedNote(b, now, {
      path: 'restore/opaque-bytes.md',
      title: 'Opaque binary source',
    })
    b.revisionState({
      note: opaqueBytes,
      date: daysBefore(now, 5, 13),
      kind: 'delete',
      state: {
        kind: 'document',
        source: { encoding: 'base64', data: '/wD+YQ==' },
      },
    })

    const validSkill = b.note({
      space: 'main',
      path: '.notarium/skills/valid-direct/SKILL.md',
      title: 'Valid direct skill',
      class: 'skill',
      content: 'Valid direct skill instructions.\n',
      created: daysBefore(now, 40, 9),
      principal: 'user:sergey',
    })
    b.revisionState({
      note: validSkill,
      date: daysBefore(now, 4, 9),
      state: {
        kind: 'document',
        role: 'skill-root',
        skillDirectoryName: 'valid-direct',
        source: {
          encoding: 'utf8',
          data: '---\nname: valid-direct\ndescription: A valid directly-authored skill\n---\nFollow these exact instructions.\n',
        },
      },
    })

    const invalidSkill = deletedNote(b, now, {
      path: '.notarium/skills/invalid-direct/SKILL.md',
      title: 'Invalid direct skill',
      class: 'skill',
    })
    b.revisionState({
      note: invalidSkill,
      date: daysBefore(now, 4, 10),
      kind: 'delete',
      state: {
        kind: 'document',
        role: 'skill-root',
        skillDirectoryName: 'invalid-direct',
        source: {
          encoding: 'utf8',
          data: '---\nname: invalid--direct\n---\nThe package stays opaque because its machine name is invalid.\n',
        },
      },
    })

    // #392, kept alive on every stand from here on. Both sizes/bytes are CONSTANTS
    // on purpose: SCALE multiplies generated volume by convention, but 830 000 bytes
    // is the incident size the fingerprint must survive — a scaled-down copy would sit
    // under the old product ceiling (~123k bytes) and prove nothing.
    const LARGE_NOTE_BYTES = 830_000
    const largeLine = 'An imported dialog line that once pushed the fingerprint past its limit.\n'
    const largeBody =
      largeLine
        .repeat(Math.ceil(LARGE_NOTE_BYTES / largeLine.length))
        .slice(0, LARGE_NOTE_BYTES - 1) + '\n'

    b.note({
      space: 'main',
      path: 'restore/large-import.md',
      title: 'Large import',
      content: largeBody,
      created: daysBefore(now, 35, 9),
      principal: 'user:sergey',
    })

    // A LIVE note whose body carries a control byte from before the write fence
    // existed. Planted through the external-rewrite seam (length-preserving, marker
    // occurring once in the whole file): no store write can produce this state, which
    // is the point — reads stay ordinary, and a write from MCP answers with the
    // addressed refusal. Deliberately never repaired here, like identity-collision.
    const controlByte = b.note({
      space: 'main',
      path: 'restore/control-byte.md',
      title: 'Control byte survivor',
      content:
        '# Control byte survivor\n\nAn imported line where a CONTROL-MARKER byte survived the old fence.\n',
      created: daysBefore(now, 34, 9),
      principal: 'user:sergey',
    })
    b.externalRewrite({
      note: controlByte,
      replacements: [{ from: 'CONTROL-MARKER', to: 'CONTROL-MA\u0000KER' }],
    })

    return b.build()
  },
}
