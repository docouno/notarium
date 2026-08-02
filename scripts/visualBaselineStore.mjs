// The S3 half of the visual baseline protocol: request signing and the four calls
// the protocol makes. Deliberately NOT the AWS SDK — this needs GET, PUT, HEAD and a
// presigned GET, and #269/#272 are actively cutting dependency weight rather than
// adding a client library for four requests. SigV4 is a closed, specified algorithm;
// what makes hand-rolling it safe here is that every operation is exercised against
// the real endpoint, not against an assumption about it.
//
// Path-style addressing throughout: virtual-hosted style puts the bucket in the
// hostname, so a bucket name containing a dot breaks TLS certificate matching — a
// failure that depends on the name someone picked rather than on anything here.
// Path style has no such constraint, and S3-compatible stores serve both.

import { createHash, createHmac } from 'node:crypto'

const SERVICE = 's3'
const UNSIGNED = 'UNSIGNED-PAYLOAD'

export const sha256hex = (data) => createHash('sha256').update(data).digest('hex')

const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding. `encodeURIComponent` leaves !'()* alone and S3 does not, and a
 *  key that signs differently than it is sent fails as an opaque 403. */
const uriEncode = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )

/** Object keys are path segments: encode each one, keep the separators. Exported
 *  because it is the one place a mismatch between what we sign and what we send
 *  turns into an opaque 403, and that deserves a test rather than a live 403. */
export const encodeKey = (key) => key.split('/').map(uriEncode).join('/')

const stamps = (now) => {
  const iso = now.toISOString().replace(/[-:]|\.\d{3}/g, '')

  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

const signingKey = (secret, dateStamp, region) => {
  let key = hmac(`AWS4${secret}`, dateStamp)

  key = hmac(key, region)
  key = hmac(key, SERVICE)

  return hmac(key, 'aws4_request')
}

const canonicalQuery = (query) =>
  Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&')

/**
 * One signed request. `body` may be a Buffer (PUT) or undefined (GET/HEAD).
 *
 * The payload hash is signed, so a proxy cannot swap the bytes without invalidating
 * the signature — which is why PUT hashes the body rather than declaring it unsigned.
 */
export const s3Request = async (
  { endpoint, region, keyId, secret },
  method,
  bucket,
  key,
  { body, query = {}, headers = {} } = {},
) => {
  const url = new URL(endpoint)
  const host = url.host
  const canonicalUri = `/${bucket}/${encodeKey(key)}`
  const { amzDate, dateStamp } = stamps(new Date())
  const payloadHash = body ? sha256hex(body) : sha256hex('')

  const signed = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  }
  const names = Object.keys(signed).sort()
  const canonicalHeaders = names.map((n) => `${n}:${String(signed[n]).trim()}\n`).join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(secret, dateStamp, region))
    .update(toSign)
    .digest('hex')

  const target = new URL(canonicalUri, endpoint)

  for (const [k, v] of Object.entries(query)) {
    target.searchParams.set(k, v)
  }

  return fetch(target, {
    method,
    body,
    headers: {
      ...signed,
      Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  })
}

/**
 * A GET anyone can follow for `expires` seconds without credentials — how the review
 * page shows images out of a bucket that allows no public read at all.
 *
 * SigV4 caps this at seven days. That is a protocol limit, not a setting: a review
 * link cannot outlive a week, so the review artefacts may be retained longer but the
 * link has to be regenerated after that.
 */
export const presignGet = ({ endpoint, region, keyId, secret }, bucket, key, expires = 604800) => {
  if (expires > 604800) {
    throw new Error('SigV4 presigned URLs expire after 7 days at most')
  }
  const url = new URL(endpoint)
  const canonicalUri = `/${bucket}/${encodeKey(key)}`
  const { amzDate, dateStamp } = stamps(new Date())
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`

  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${keyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  }

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery(query),
    `host:${url.host}\n`,
    'host',
    UNSIGNED,
  ].join('\n')

  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')
  const signature = createHmac('sha256', signingKey(secret, dateStamp, region))
    .update(toSign)
    .digest('hex')

  const target = new URL(canonicalUri, endpoint)

  for (const [k, v] of Object.entries(query)) {
    target.searchParams.set(k, v)
  }
  target.searchParams.set('X-Amz-Signature', signature)

  return target.toString()
}

export const getObject = async (credentials, bucket, key) => {
  const response = await s3Request(credentials, 'GET', bucket, key)

  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`GET ${bucket}/${key} → ${response.status} ${await response.text()}`)
  }

  return Buffer.from(await response.arrayBuffer())
}

export const headObject = async (credentials, bucket, key) => {
  const response = await s3Request(credentials, 'HEAD', bucket, key)

  if (response.status === 404) {
    return false
  }
  if (!response.ok) {
    throw new Error(`HEAD ${bucket}/${key} → ${response.status}`)
  }

  return true
}

export const putObject = async (credentials, bucket, key, body, contentType) => {
  const response = await s3Request(credentials, 'PUT', bucket, key, {
    body,
    headers: contentType ? { 'content-type': contentType } : {},
  })

  if (!response.ok) {
    throw new Error(`PUT ${bucket}/${key} → ${response.status} ${await response.text()}`)
  }
}
