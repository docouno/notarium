# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem** — it would be public before anyone
could deploy a fix.

Use **GitHub private vulnerability reporting**: the *Report a vulnerability* button under
this repository's **Security** tab. The report and the whole discussion stay private
until an advisory is published, and a fix can be prepared without the issue being visible
first. It needs a GitHub account and nothing else.

A proof of concept, the version or image digest you tested (`notarium version`, or
`/api/about`), and the configuration that matters — `AUTH_MODE`, whether a reverse proxy
sits in front, whether the vector stack is on — turn a report into a fix much faster than
a description alone.

Notarium is maintained by one person. You should get an acknowledgement within **3
working days** and an assessment within **10**. If nothing arrives in that window, add a
comment on your own report rather than assuming it was ignored.

## Disclosure

Report privately, and give a fix a reasonable chance to ship before going public — **90
days** is the default understanding, shorter if a fix lands sooner, longer only by
agreement if the fix turns out to be structural. A release that carries a security fix
says so in [CHANGELOG.md](CHANGELOG.md), and reporters are credited there unless they
ask not to be.

## What is in scope

The code in this repository and the published `docouno/notarium` image. Concretely, the
things this project claims to hold and would consider itself broken without:

- **Crossing a space boundary.** A space is the isolation boundary — its own index,
  graph, search, history and membership. Reading, writing or enumerating across one
  without membership is a vulnerability, including through the MCP gateway or a
  share/OAuth flow.
- **Authentication and session handling** — the first-owner claim, invite and reset
  links, PAT and OAuth token issuance, scope narrowing, revocation.
- **Escaping the data root.** Path traversal out of a space's notes directory, or into
  the reserved `.notarium/` namespace, through the API, import, or a crafted note.
- **Agent-facing surfaces.** The MCP gateway is deliberately built so that untrusted note
  content cannot reach a tool description or an outbound channel; anything that breaks
  that is in scope. See [docs/mcp-gateway.md](docs/mcp-gateway.md).
- **Anything that lets an unauthenticated request reach data or an expensive operation.**

## What is not in scope

Not because these do not matter, but because they are known, documented positions rather
than defects — argue with the position by opening an issue, not a report:

- **Trusting a reverse proxy you told it to trust.** `X-Forwarded-For` is ignored unless
  `TRUST_PROXY` names the proxy; a deployment that sets it to a public range and then
  reports header spoofing is describing its own configuration.
  See [docs/auth.md](docs/auth.md).
- **`AUTH_MODE=none`.** A single-principal mode for desktop and development. It is not a
  weakened password mode; it is the absence of one, and it says so.
- **Anyone with write access to the notes directory.** Markdown files on disk are the
  source of truth. A person or process that can write there is inside the trust boundary
  by construction.
- **A member of a space seeing everything in that space.** That is the access model, not
  a leak. "Share a subset" is a separate space.
- **Multi-tenant, pooled hosting.** Notarium is single-tenant self-host today. The second
  isolation boundary that open multi-tenant registration would need is not built, and
  running an untrusted multi-tenant service on it is out of scope until it is.
- Missing hardening headers, dependency advisories with no reachable path, and reports
  produced by a scanner without a demonstrated impact. A dependency advisory that *is*
  reachable is in scope — say how.

## Supported versions

Pre-1.0, only the latest release is supported: fixes land in a new release rather than
being backported. Pre-releases (`X.Y.Z-rc.N`) are not supported — report against them,
but the fix ships in the release that follows.

## Safe harbour

Research done in good faith under this policy is welcome, and we will not pursue or
support legal action over it. Test against **your own instance** — never against someone
else's data — access no more than your proof needs, and do not degrade a running service.
`docker run docouno/notarium` gives you a disposable instance to attack in a minute.
