import { decodeUtf8Base64Url, encodeUtf8Base64Url } from '../libs/base64url'
import type { ViewReferencePayload } from './types'

const VIEW_REF_PREFIX = 'view-v1.'

export const encodeViewRef = (payload: ViewReferencePayload): string =>
  `${VIEW_REF_PREFIX}${encodeUtf8Base64Url(JSON.stringify(payload))}`

export const decodeViewRef = (value: string): ViewReferencePayload | null => {
  if (!value.startsWith(VIEW_REF_PREFIX)) {
    return null
  }
  const decoded = decodeUtf8Base64Url(value.slice(VIEW_REF_PREFIX.length))

  if (decoded == null) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(decoded)

    if (
      typeof parsed !== 'object' ||
      parsed == null ||
      typeof (parsed as ViewReferencePayload).documentId !== 'string' ||
      typeof (parsed as ViewReferencePayload).versionToken !== 'string' ||
      !Number.isSafeInteger((parsed as ViewReferencePayload).block) ||
      !Number.isSafeInteger((parsed as ViewReferencePayload).view) ||
      (parsed as ViewReferencePayload).block < 0 ||
      (parsed as ViewReferencePayload).view < 0
    ) {
      return null
    }

    return parsed as ViewReferencePayload
  } catch {
    return null
  }
}
