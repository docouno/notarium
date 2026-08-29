import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { graphRevisionCorpusFiles } from '../test/cases/cases/graphRevision'

const notesDir = process.env.GRAPH_REVISION_NOTES_DIR?.trim()
const output = process.env.GRAPH_REVISION_CORPUS_OUTPUT?.trim()

if (!notesDir) {
  throw new Error('GRAPH_REVISION_NOTES_DIR is required')
}
if (!output) {
  throw new Error('GRAPH_REVISION_CORPUS_OUTPUT is required')
}

let files = 0

for (const file of graphRevisionCorpusFiles()) {
  const path = join(notesDir, file.path)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, file.content, { encoding: 'utf8', flag: 'wx' })
  files++
}

const observeCorpus = async (directory: string): Promise<{ notes: number; bytes: number }> => {
  let notes = 0
  let bytes = 0

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      const nested = await observeCorpus(path)
      notes += nested.notes
      bytes += nested.bytes
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      notes++
      bytes += (await stat(path)).size
    }
  }

  return { notes, bytes }
}
const observed = await observeCorpus(notesDir)

await writeFile(output, `${JSON.stringify(observed, null, 2)}\n`, 'utf8')
console.log(
  `graph revision corpus: wrote ${files} filler notes; observed ${observed.notes} notes / ${observed.bytes} bytes in ${notesDir}`,
)
