import { z } from 'zod'
import { SpaceSlugSchema } from '../primitives'
import { ProjectHandleSchema } from './primitives'

/** The THREE-state location an agent reads on a hit/change — a single `project?`
 *  can't tell a free note in a work space from a personal-domain one, so all three
 *  are independent:
 *    • `space?` absent ⇒ the personal domain; present ⇒ that work space.
 *    • `project?` present ⇒ its handle (round-trips back into a tool's `project`).
 *    • `path?` the note's space-relative stem WITHOUT `.md`. READ-ONLY (references
 *      are always by note-id). It is a NOTE stem, NOT a folder — the create/move
 *      tools take a FOLDER (a `folders` entry); drop the last segment for its folder. */
export const locationFields = {
  space: SpaceSlugSchema.optional(),
  project: ProjectHandleSchema.optional(),
  path: z.string().optional(),
}
