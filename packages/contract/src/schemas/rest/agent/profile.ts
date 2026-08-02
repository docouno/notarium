import { z } from 'zod'

/** GET /api/me/profile — the human-authored, always-load profile the agent reads
 *  at session start (opposite the agent-authored memory). Backed by ONE reserved
 *  `profile`-class note. `noteId`/`versionToken` are null until it exists (GET does
 *  not create it); `versionToken` is the CAS proof a later PUT echoes.
 *  `displayName` rides along (the user record's) so the tab is one form. */
export const ProfileResponseSchema = z.object({
  displayName: z.string().min(1),
  content: z.string(),
  noteId: z.string().nullable(),
  versionToken: z.string().nullable(),
})

/** PUT /api/me/profile — upsert the profile note (minting the personal domain on
 *  first save) and the display name in one call. `versionToken` guards the write
 *  (CAS): omit it the first time, echo the GET's token after. `content` is
 *  Markdown. */
export const ProfilePutRequestSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  content: z.string().max(100_000),
  versionToken: z.string().optional(),
})

export type Profile = z.infer<typeof ProfileResponseSchema>

export type ProfilePutRequest = z.infer<typeof ProfilePutRequestSchema>
