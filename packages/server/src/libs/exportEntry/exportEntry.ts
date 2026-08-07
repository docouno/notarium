import { Buffer } from 'node:buffer'

import { type ExportEntry, stripFrontmatter } from '@notarium/core'

/** Host-edge presentation transform for an exported source file. Binary resources
 *  always stay bytes; the lossy frontmatter option applies only to Markdown. */
export const exportEntryBody = (entry: ExportEntry, strip: boolean): string | Buffer => {
  const raw = typeof entry.content === 'string' ? entry.content : Buffer.from(entry.content)

  if (!strip || entry.preserveBytes || !entry.path.toLowerCase().endsWith('.md')) {
    return raw
  }
  const markdown = typeof raw === 'string' ? raw : raw.toString('utf8')
  return stripFrontmatter(markdown).replace(/^\n+/, '')
}
