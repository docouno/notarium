// Server-rendered consent + login page for /oauth/authorize: standalone HTML
// (not the SPA) so it works in the redirect-from-claude.ai flow without booting
// the app. Every interpolated value is HTML-escaped (clientName/error are
// attacker/user-influenced).
// canon: docs/mcp-oauth.md#surfaces

import type { AuthorizeParams } from '../../../../services/oauth/oauthService'

const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

const PAGE = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · Notarium</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    background:#0f1115; color:#e7e9ee; padding:24px; }
  .card { width:100%; max-width:400px; background:#171a21; border:1px solid #262b36;
    border-radius:14px; padding:28px; }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:18px; }
  .brand b { font-size:18px; }
  h1 { font-size:18px; margin:0 0 6px; }
  p { margin:0 0 14px; color:#aab2c0; }
  .client { color:#e7e9ee; font-weight:600; }
  label { display:block; margin:12px 0 4px; font-size:13px; color:#aab2c0; }
  input { width:100%; padding:10px 12px; border-radius:9px; border:1px solid #2c3340;
    background:#0f1115; color:#e7e9ee; font-size:15px; }
  .row { display:flex; gap:10px; margin-top:20px; }
  button { flex:1; padding:11px; border-radius:9px; border:0; font-size:15px; font-weight:600;
    cursor:pointer; }
  .approve { background:#4f7cff; color:#fff; }
  .deny { background:#222732; color:#cfd5e0; }
  .err { background:#3a1d22; border:1px solid #5e2a31; color:#ffb4be; padding:9px 12px;
    border-radius:9px; font-size:13px; margin-bottom:12px; }
  .scopes { font-size:13px; color:#aab2c0; background:#0f1115; border:1px solid #262b36;
    border-radius:9px; padding:10px 12px; margin-bottom:4px; }
  .scopes b { color:#e7e9ee; }
  .spaces { margin-top:14px; font-size:13px; }
  .spaces > .spaceRow { font-weight:600; }
  .spaceRow { display:flex; align-items:center; gap:8px; margin:6px 0; color:#e7e9ee; cursor:pointer; }
  .spaceRow input { width:auto; margin:0; }
  .spaceList { margin:6px 0 0 20px; }
  .spaceList .spaceRow { font-weight:400; color:#cfd5e0; }
  .hint { font-size:12px; color:#8b93a3; margin:8px 0 0; }
</style></head>
<body><div class="card">
  <div class="brand">🧠 <b>Notarium</b></div>
  ${body}
</div></body></html>`

const hidden = (params: AuthorizeParams): string =>
  [
    ['response_type', 'code'],
    ['client_id', params.clientId],
    ['redirect_uri', params.redirectUri],
    ['scope', params.scope],
    ['state', params.state ?? ''],
    ['code_challenge', params.codeChallenge],
    ['code_challenge_method', params.codeChallengeMethod],
  ]
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n')

const scopeSummary = (scope: string): string => {
  const parts = scope.split(/\s+/).filter(Boolean)
  const write = parts.includes('write')
  return write
    ? 'read <b>and write</b> your notes, knowledge and agent memory'
    : '<b>read</b> your notes and knowledge'
}

/** Per-space checkbox field name. DISTINCT name per space (not a repeated `space`
 *  field): the urlencoded parser's Object.fromEntries collapses duplicate keys. */
const SPACE_FIELD_PREFIX = 'space:'

/** Interpret the consent form's space selection → null (all grants, incl. future
 *  spaces) or the ticked slugs. Returns WIRE SLUGS; the route maps them to stable
 *  ids before minting. */
export const readConsentSpaces = (
  body: Record<string, string | undefined>,
  available: string[],
): { spaces: string[] | null; error?: string } => {
  // Grant-less owner has no picker to satisfy → fail OPEN to all grants (null), not
  // the "pick at least one" dead-end.
  if (!available.length) {
    return { spaces: null }
  }
  if (body.all_spaces != null) {
    return { spaces: null }
  }
  const picked = available.filter((slug) => body[`${SPACE_FIELD_PREFIX}${slug}`] != null)

  if (!picked.length) {
    return { spaces: null, error: 'Pick at least one space, or choose “All spaces”.' }
  }

  return { spaces: picked }
}

export const renderConsentPage = (input: {
  params: AuthorizeParams
  clientName: string | null
  username: string | null
  spaces: string[] | null
  error: string | null
}): string => {
  const { params, clientName, username, spaces, error } = input
  const who = clientName ? esc(clientName) : 'A connected application'
  const errBlock = error ? `<div class="err">${esc(error)}</div>` : ''
  const loginFields = username
    ? `<p>Signed in as <span class="client">${esc(username)}</span>.</p>`
    : `<label for="u">Username or email</label>
       <input id="u" name="identifier" autocomplete="username" autofocus>
       <label for="p">Password</label>
       <input id="p" name="password" type="password" autocomplete="current-password">`
  const spacesBlock =
    username && spaces && spaces.length
      ? `<div class="spaces" role="group" aria-label="Spaces">
      <label class="spaceRow"><input type="checkbox" name="all_spaces" checked> All spaces</label>
      <div class="spaceList">
        ${spaces
          .map(
            (s) =>
              `<label class="spaceRow"><input type="checkbox" name="${esc(SPACE_FIELD_PREFIX + s)}"> ${esc(s)}</label>`,
          )
          .join('\n        ')}
      </div>
      <p class="hint">Uncheck “All spaces” to limit this app to only the spaces you tick.</p>
    </div>`
      : ''
  const body = `
  <h1>Authorize access</h1>
  <p><span class="client">${who}</span> wants to connect to your Notarium.</p>
  <div class="scopes">It will be able to ${scopeSummary(params.scope)}.</div>
  ${errBlock}
  <form method="post" action="/oauth/authorize">
    ${hidden(params)}
    ${loginFields}
    ${spacesBlock}
    <div class="row">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="approve" type="submit" name="decision" value="approve">Authorize</button>
    </div>
  </form>`
  return PAGE('Authorize access', body)
}

export const renderErrorPage = (message: string): string =>
  PAGE('Error', `<h1>Could not authorize</h1><p>${esc(message)}</p>`)
