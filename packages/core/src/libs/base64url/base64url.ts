/** Portable UTF-8 base64url without padding. Browser and Node hosts both expose
 * the Web Platform codec; keeping the implementation here avoids Buffer in core. */
export const encodeUtf8Base64Url = (value: string): string => {
  let binary = ''

  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

/** Decode only the canonical spelling emitted above. This rejects padding,
 * impossible tail bits and malformed UTF-8 instead of accepting aliases. */
export const decodeUtf8Base64Url = (value: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    return null
  }
  try {
    const encoded = value.replaceAll('-', '+').replaceAll('_', '/')
    const binary = atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '='))
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    )

    return encodeUtf8Base64Url(decoded) === value ? decoded : null
  } catch {
    return null
  }
}
