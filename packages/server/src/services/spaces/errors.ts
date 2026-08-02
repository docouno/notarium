/** Typed not-found; host error handler maps `isNotFound` → the anti-enumeration
 *  404. canon: docs/auth.md#model */
export const spaceNotFound = (slug: string): Error => {
  const err = new Error(`space not found: ${slug}`) as Error & {
    isNotFound: boolean
    reason: string
  }
  err.isNotFound = true
  err.reason = 'space_not_found'
  return err
}
