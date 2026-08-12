import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Node's fs.utimes accepts floating-point seconds and loses sub-microsecond
 *  precision at epoch-sized values. The engine reads bigint nanoseconds, so even
 *  that tiny rounding would turn this seed into a metadata-change case. POSIX
 *  touch copies the filesystem timestamp from a reference without the JS number
 *  round-trip. No shell is involved. */
const copyTimestamps = async (from: string, to: string): Promise<void> => {
  await execFileAsync('touch', ['-r', from, to])
}

export type SeedExternalRewrite = {
  filePath: string
  note: string
  replacements: Array<{ from: string; to: string }>
}

/** A cross-space id collision expressed as an external rewrite (#327). The direction is
 *  the whole seed: the CLAIMANT's file is the one edited, and what lands in it is the
 *  OWNER's id. Flipped, the rewrite looks for an id the file does not contain — the
 *  applier finds no occurrence, the stand comes up with two ordinary notes, and every
 *  check downstream passes while reproducing nothing. */
export const identityClaimRewrite = (
  claim: { note: string; claimFrom: string },
  idOf: (handle: string) => string | undefined,
): { note: string; replacements: Array<{ from: string; to: string }> } => {
  const claimantId = idOf(claim.note)
  const ownerId = idOf(claim.claimFrom)

  if (!claimantId || !ownerId) {
    throw new Error(`external identity claim references unknown note ${claim.note}`)
  }

  return { note: claim.note, replacements: [{ from: claimantId, to: ownerId }] }
}

/** Apply seed-declared external edits through the physical filesystem seam.
 *
 *  The file is rewritten in place and its original timestamps are restored. The
 *  replacement contract keeps its byte size identical as well. No Notarium store
 *  method is called: this is deliberately the editor/git/sync shape that #267
 *  needs to keep covered by the live seed system. */
export const applySeedExternalRewrites = async (
  rewrites: SeedExternalRewrite[],
): Promise<number> => {
  let applied = 0

  for (const rewrite of rewrites) {
    const beforeStat = await stat(rewrite.filePath)
    let content = await readFile(rewrite.filePath, 'utf8')
    const beforeBytes = Buffer.byteLength(content, 'utf8')

    for (const { from, to } of rewrite.replacements) {
      if (Buffer.byteLength(from, 'utf8') !== Buffer.byteLength(to, 'utf8')) {
        throw new Error(
          `external rewrite for ${rewrite.note} changes replacement byte length: ` +
            `${JSON.stringify(from)} -> ${JSON.stringify(to)}`,
        )
      }
      const parts = content.split(from)

      if (parts.length !== 2) {
        throw new Error(
          `external rewrite for ${rewrite.note} expected exactly one ${JSON.stringify(from)} ` +
            `in ${rewrite.filePath}, found ${parts.length - 1}`,
        )
      }
      content = `${parts[0]}${to}${parts[1]}`
    }
    if (Buffer.byteLength(content, 'utf8') !== beforeBytes) {
      throw new Error(`external rewrite for ${rewrite.note} changed total file size`)
    }

    const timestampRef = join(dirname(rewrite.filePath), `.seed-mtime-${randomUUID()}.tmp`)

    try {
      await writeFile(timestampRef, '')
      await copyTimestamps(rewrite.filePath, timestampRef)
      await writeFile(rewrite.filePath, content, 'utf8')
      await copyTimestamps(timestampRef, rewrite.filePath)
    } finally {
      await unlink(timestampRef).catch(() => {})
    }

    const afterStat = await stat(rewrite.filePath)

    if (afterStat.size !== beforeStat.size || afterStat.mtimeMs !== beforeStat.mtimeMs) {
      throw new Error(
        `external rewrite for ${rewrite.note} failed to preserve size + mtime ` +
          `(${beforeStat.size}/${beforeStat.mtimeMs} -> ${afterStat.size}/${afterStat.mtimeMs})`,
      )
    }
    applied++
  }

  return applied
}
