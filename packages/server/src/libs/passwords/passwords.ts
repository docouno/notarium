// scrypt password hashing; params are encoded in the hash string so they can be
// raised without invalidating old hashes.
// canon: docs/auth.md#credentials · docs/architecture.md#p9

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const CURRENT = { logN: 17, r: 8, p: 1 }
const KEYLEN = 32
const SALT_BYTES = 16

const derive = (password: string, salt: Buffer, logN: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEYLEN,
      // maxmem must clear 128·N·r bytes; double it for headroom.
      { N: 2 ** logN, r, p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    )
  })

/** → `scrypt:<logN>:<r>:<p>:<salt b64>:<key b64>` */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, CURRENT.logN, CURRENT.r, CURRENT.p)
  return [
    'scrypt',
    CURRENT.logN,
    CURRENT.r,
    CURRENT.p,
    salt.toString('base64'),
    key.toString('base64'),
  ].join(':')
}

export const verifyPassword = async (password: string, encoded: string): Promise<boolean> => {
  const parts = encoded.split(':')

  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return false
  }
  const [logN, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]

  if (![logN, r, p].every((n) => Number.isInteger(n) && n > 0) || logN > 20) {
    return false
  }
  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')

  if (expected.length !== KEYLEN) {
    return false
  }
  const key = await derive(password, salt, logN, r, p)
  return timingSafeEqual(key, expected)
}

export const passwordNeedsRehash = (encoded: string): boolean => {
  const parts = encoded.split(':')

  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return true
  }

  return Number(parts[1]) < CURRENT.logN
}

/** A real hash of an unguessable value, verified against on login for unknown
 *  usernames — "no such user" and "wrong password" take the same time. */
export const DUMMY_HASH_PROMISE: Promise<string> = hashPassword(randomBytes(16).toString('hex'))
