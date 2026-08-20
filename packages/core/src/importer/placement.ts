import { pathHash } from '../libs/hash'
import {
  clipToBytes,
  isPortablePathComponent,
  NOTE_BASENAME_MAX_BYTES,
  utf8ByteLength,
} from '../libs/path'
import { slugify } from '../libs/slug'
import { IMPORT_DIRECTORY_MAX_BYTES } from './consts'
import { datePrefix } from './helpers/format'

const taggedComponent = (
  label: string,
  fallback: string,
  identity: string,
  prefix = '',
  maxBytes = IMPORT_DIRECTORY_MAX_BYTES,
): string => {
  const suffix = `-${pathHash(identity)}`
  const readable = slugify(label) || fallback
  const budget = maxBytes - utf8ByteLength(prefix) - utf8ByteLength(suffix)
  const clipped = clipToBytes(readable, budget).replace(/[-. ]+$/u, '') || fallback
  const component = `${prefix}${clipped}${suffix}`

  if (!isPortablePathComponent(component, maxBytes)) {
    throw new Error('canonical import component is not portable')
  }

  return component
}

/** Source-tagged project placement shared by prompt/docs/design chats. */
export const sourceProjectDirectoryName = (name: string, placementLocator: string): string =>
  taggedComponent(name, 'project', placementLocator)

/** Source-tagged basename. Date remains a readable conversation ordering hint;
 * full source identity is the 96-bit suffix and the reserved file field. */
export const sourceNoteFileName = (
  title: string,
  locator: string,
  iso: string | null = null,
): string => {
  const date = datePrefix(iso)
  return taggedComponent(
    title,
    'untitled',
    locator,
    date ? `${date}-` : '',
    NOTE_BASENAME_MAX_BYTES,
  )
}

/** Optional display-only grouping when a design chat has no project identity. */
export const portableDisplayGroup = (name: string): string => {
  const readable = slugify(name) || 'project'

  return isPortablePathComponent(readable, IMPORT_DIRECTORY_MAX_BYTES)
    ? readable
    : taggedComponent(name, 'project', `display:${name}`)
}
