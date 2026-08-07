/** The reserved filename of a folder's PAGE note: a visible `index.md`
 *  living IN the folder is that folder's body, the Obsidian folder-note pattern.
 *  It is an ordinary `user-doc` (graph/search/index-visible for free), only given
 *  special-cased meaning by this name. `BASENAME` (sans `.md`) is what a write
 *  passes as `WriteInput.fileName` to land the note on exactly this path. */
export const FOLDER_PAGE_FILENAME = 'index.md'
export const FOLDER_PAGE_BASENAME = 'index'

/** The file name a note got before the name formula had an id rung (#296): a title
 *  with nothing sluggable in it produced an EMPTY basename, so `<dir>/.md` — a
 *  dot-file the scan hid, which made the reconcile read a live file as an external
 *  delete. No note can be written here any more; the constant names what the boot
 *  heal looks for, and what the scan deliberately stops hiding. */
export const UNNAMED_NOTE_FILENAME = '.md'

/** How many UTF-8 BYTES of a TITLE-derived basename reach the file name. Filesystems
 *  cap a single path component in bytes (ext4/APFS/NTFS at 255) and one CJK letter
 *  costs three of them, so a limit counted in characters would pass a title that
 *  ENAMETOOLONGs on disk — a NEW failure mode the wider alphabet introduces.
 *
 *  The budget is exactly what fits beside `.md`: 252 + 3 = 255. Reserving space for a
 *  hypothetical uniquify suffix would rename already-valid 240–252 byte files on the
 *  next save. A suffixed candidate is bounded from its own whole name instead.
 *
 *  Title-derived and explicit names both obey it. `fileName` is public write input;
 *  accepting an overlong pin only to fail at fs.rename is not a valid contract. The
 *  clip tag is derived from the whole value, retaining deterministic idempotency.
 *
 *  Only the FILE name is clipped — the resolve key keeps the whole title, so a long
 *  `[[title]]` still resolves. */
export const NOTE_BASENAME_MAX_BYTES = 252

/** Bytes reserved inside that budget for the `-<hash96>` tag a CLIPPED name carries.
 *  A clip cuts the tail, and the tail is where a series counter lives (`… 2`, ` copy`),
 *  so a clipped name needs something derived from the WHOLE slug to stay distinct —
 *  otherwise `uniquify` could never step past an occupant and two different long titles
 *  could not share a folder. Twenty-five bytes: a dash plus 24 SHA-256 hex chars. */
export const CLIPPED_NAME_TAG_BYTES = 25
