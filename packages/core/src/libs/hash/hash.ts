// Content addressing for the revision journal's blob table. sha-256, not
// the fnv64 the version token uses: the token is an opaque equality check with
// a tiny lifetime, the blob hash is a forever storage key — a silent 64-bit
// collision there would serve the wrong history. WebCrypto so the same code
// runs in node hosts and the browser (P9).

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  let hex = ''

  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0')
  }

  return hex
}
