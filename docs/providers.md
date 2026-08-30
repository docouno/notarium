# Model providers

Notarium can store credentials for model providers, describe callable model
resources, validate them, and share a resource with a Space or Project through an
explicit consent flow. This subsystem is an enabler: the current product exposes
management, validation, resolution, audit and the durable-call safety contract. It
does not add a chat UI, a production provider job type, or a provider-backed corpus
embedder.

## Enable and access

The subsystem is off by default:

```dotenv
PROVIDERS_ENABLED=true
PROVIDERS_PRIVATE_ORIGINS=http://host.docker.internal:11434
PROVIDERS_CALL_LOG_RETENTION_DAYS=90
```

`PROVIDERS_ENABLED` is a strict boolean. When it is false, provider routes and
Settings tabs are absent, `/api/about` does not publish the provider admin key, and
an empty keyring is not minted. Existing provider rows remain in the meta-DB and are
included in an ordinary backup.

`PROVIDERS_PRIVATE_ORIGINS` is a comma-separated list of exact canonical origins.
The default is empty. CIDRs, wildcards, paths, query strings, fragments and URL
credentials are rejected. This list is independent of `AUTH_MODE`.

`PROVIDERS_CALL_LOG_RETENTION_DAYS` accepts exactly `30`, `90`, `365`, or
`forever`; the default is 90 days. It applies to terminal raw call evidence only.
Rows still `in-flight`, and rows whose durable job is pending/running, survive
regardless of age because they are the send-fence against paying twice. Lowering
the horizon is irreversible on the live instance; an older backup may still carry
the removed rows.

Credential/resource inventory, mutation and validation are session-only
`self:manage` operations. PAT and OAuth scopes top out at `read` or `write`, so they
cannot reach this inventory. A scoped agent learns only the effective boolean
`whoami.hasModel`; it does not receive provider, model, origin or status inventory.

Management inventories are fixed cursor pages of 100 compact rows. The table carries
counts and status summaries; full model lists, diagnostics, epochs and write settings
arrive only after an explicit detail action. `Load more` advances the opaque cursor.
Retarget may page the editor DOM, but its submit still contains and atomically checks
the complete reference set — pagination never creates a partial retarget.

## Ownership and resolution

A credential and a model resource belong to one human owner. Ownership is not
transferred. A resource may refer to one credential owned by the same person, or to
no credential (for example a local Ollama endpoint).

Sharing is a separate, two-sided attachment:

1. the resource owner offers a resource to a Space or Project;
2. a manager of the target sees the literal disclosure and accepts it;
3. the accepted resource enters effective lists for that scope.

Resolution is deterministic: Project attachment, then Space attachment, then a
personal resource, then an instance-owned resource. The current implementation has
no persisted “default resource” pointer; the first product consumer that needs a
default owns that choice.

Effective lists retain accepted-but-unusable resources with one closed reason
instead of silently dropping them: `disabled`, `credential-disabled`,
`secret-unreadable`, `credential-origin-mismatch`, `owner-disabled`,
`space-archived`, or `attachment-not-active`. A never-accepted `pending` offer is
visible only on the consent surface.

## Credentials

A credential contains:

- a display name and owner;
- an immutable kind (`bearer` or custom `header`);
- a write-only secret;
- one exact HTTP(S) `origin`;
- the injection header and prefix;
- optional `rpm` and `tpm` limits;
- disabled state plus consent/runtime epochs.

The secret is stored as a versioned AES-GCM envelope, not plaintext. A read returns
the credential metadata and references, never the secret. An empty secret field in
an existing editor means “retain”, not “replace with empty”. Provider resource
header values use the same envelope; only canonical header names may return.

Changing a secret, origin, injection, disabled state or limits invalidates runtime
health. Origin and injection changes additionally invalidate consent. A credential
cannot be deleted while resources reference it: the refusal names every reference.
Retargeting is the explicit atomic path for changing the credential origin and its
complete reference set.

The credential origin and resource `baseUrl` origin must match. This prevents an
accidental edit of only one of the two records from sending an existing key to a new
recipient. It does not stop the owner of both records from changing both on purpose.

## Network policy

Every provider call goes through the same pinned transport:

- the exact canonical origin is checked before the request;
- every A and AAAA answer is classified and pinned to the connection;
- redirects are disabled;
- loopback/private access needs both an exact operator origin and the resource
  owner's `allowPrivateNetwork` opt-in;
- link-local and cloud-metadata destinations are always denied;
- one mandatory `AbortSignal` covers lookup, connection, response body and parser;
- request body, response body, decompressed bytes, stream bytes, headers and
  per-principal concurrency are bounded.

Public HTTPS origins need no allow-list entry. A private allow-list entry authorizes
only that origin; it does not open a LAN or CIDR.

## Local provider reachability

Container loopback is the Notarium container itself. Merely allowing
`http://127.0.0.1:11434` does not make a host Ollama process reachable.

The following shapes were checked against the project image:

| Shape | Precondition and price |
|---|---|
| `host.docker.internal:host-gateway` | The runtime must listen on an address visible from the Docker bridge. It does not reach a runtime bound only to host loopback. |
| host networking | Reaches host loopback on Linux, but removes the ordinary network-isolation boundary and differs on Docker Desktop. |
| Linux bridge gateway (commonly `172.17.0.1`) | Same bind precondition as `host-gateway`; the actual bridge address is host-specific. |

`OLLAMA_HOST=0.0.0.0` is often suggested as the bind fix, but Notarium does **not**
recommend it: Ollama has no authentication, this exposes it on every host interface,
and Docker-published traffic may bypass the firewall rules an operator expects.
Prefer a deliberately isolated network path and admit only its exact origin.

Whatever path is chosen must appear literally in `PROVIDERS_PRIVATE_ORIGINS`, and
the resource must separately opt in to private networking.

## Validation, calls and limits

“Check connection” performs a real minimal call appropriate to the resource wire
and purpose. Results are classes such as `credential-rejected`,
`parameters-rejected`, `provider-rate-limited`, `model-unavailable` or
`unreachable`, not raw provider bodies. A result is written only if both the
resource and credential runtime epochs are still the snapshots that were called;
a stale result is audited but does not overwrite current health.

The executor supports OpenAI-compatible SSE/JSON and native Ollama NDJSON/JSON,
streaming text, usage accounting and end-to-end cancellation. An intent row is
written before a send, and a terminal outcome afterward. Prompt and response bodies
are absent from the call journal. Terminal rows age out under the configured
retention horizon; a future long-term cost rollup is deliberately not invented
before its first product reader.

Provider `429` and Notarium's own limiter are different outcome classes.
Interactive calls retry only a proven-safe class. Durable calls use a stable
`jobCallKey`: a recovered intent that may already have sent is terminal
`outcome-unknown` and is not sent again. Only a proven `not-sent` attempt or a
verified provider rate-limit refusal licenses another attempt.

`rpm`/`tpm` windows belong to a credential owner and live in one process. Reserve
happens before send using a conservative input bound and output budget; unknown
usage keeps the reserve. Use separate credentials for interactive and background
work. Two workloads on one credential share one failure and budget domain; separate
numeric limits do not isolate them.

## Consent lifecycle

Acceptance stores the disclosed target Space, resource owner, origin, purposes,
models, private-network flag and header names together with the resource and
credential consent epochs. A later recipient-affecting mutation changes the current
epochs and moves an active attachment to `awaiting-reconsent`; the manager sees a
bounded literal diff before accepting again.

Removing the resource owner from the target Space atomically removes attachments
for that owner's resources. Removing an unrelated member does not. Archiving a
Space keeps the attachment row but resolution becomes `space-archived`; restoring
the Space revives the same accepted state. Permanent Space purge removes its
attachments. Runtime resolution rechecks owner membership, Space lifecycle,
attachment state and both epochs as a fail-closed backstop.

## Credential keyring

Canonical file-SQLite deployments keep provider master keys in:

```text
<DATA_DIR>/secret-keyring/
```

The directory is inside `DATA_DIR` but outside every root the Notarium ZIP packs.
For an external meta-DB, all serving processes must share the directory named by
`NOTARIUM_CREDENTIAL_KEYRING_DIR`.

Boot creates a key only when providers are enabled and no ciphertext exists. A
pointer names the active filesystem key; the meta-DB stores its generation and an
encrypted canary projection. Boot fails loudly on a missing/corrupt key, a canary
failure, a pointer/DB mismatch, or partial key loss. Every ciphertext write proves
the active key under the common keyring fence.

Rotation is a dry run by default:

```sh
docker compose exec notarium admin \
  rotate-credential-key --expected-key-id <active-id>
docker compose exec notarium admin \
  rotate-credential-key --expected-key-id <active-id> --apply
```

Stop every serving process before the apply step and verify the expected id again.
The command rewraps credential secrets and resource headers, performs a final
zero-reference scan, then retires old DB generations. It does not delete immutable
key files: retain every file needed by the backup-retention window.

## Backup, restore and recovery

The Notarium ZIP contains encrypted provider rows but deliberately excludes
`secret-keyring`. Two product measures enforce that exclusion: boot refuses a
keyring under a packed root, and backup/restore reject a manifest that admits the
keyring. These are the two product measures; no third filesystem-identity check is
claimed. See [backup.md](backup.md) for the full archive contract.

Move an instance in this order:

1. restore the Notarium ZIP into an empty data root;
2. place the separately retained `secret-keyring` in its configured location;
3. start Notarium for the first time.

An exact historical DB/keyring snapshot starts directly. If the supplied keyring
is a superset whose pointer names a newer generation than the restored DB, boot
does not guess. Reconcile explicitly, first as a dry run:

```sh
docker compose exec notarium admin \
  reconcile-credential-keyring --expected-key-id <database-active-id>
docker compose exec notarium admin \
  reconcile-credential-keyring --expected-key-id <database-active-id> --apply
```

The command proves the DB-active canary and durable key file before moving the
pointer. The newer key file remains intact.

If the keyring is completely lost while ciphertext remains, credentials cannot be
recovered. Stop all serving processes, inspect the affected rows, and use the DB
active projection as the witness:

```sh
docker compose exec notarium admin \
  purge-unreadable-secrets --expected-key-id <database-active-id>
docker compose exec notarium admin \
  purge-unreadable-secrets --expected-key-id <database-active-id> --apply
```

The first command is a dry run. `--apply` removes unreadable credentials/header
values, disables affected resources, replaces the completely lost key, and refuses
partial loss. The command requires a stopped server **by operator procedure**; it
does not claim to probe whether a server is live. Its executable gates are the
two-step `--apply` flow and exact `--expected-key-id` comparison.

## System-owned resources

There is no special management branch for owner `@system`. An operator can create
instance-owned rows only through a temporary authless maintenance window. Read the
price before using it:

- `AUTH_MODE=none` grants **full access to the entire instance** to anyone who can
  reach the port: every Space, membership, attachment and management operation;
- rows created as `@system` cannot be revoked in password mode. Revoking one means
  opening the same full-access window again.

Procedure:

1. Back up the instance, stop the service and restrict network access to the port.
2. Set `PROVIDERS_ENABLED=true`, `AUTH_MODE=none`, and add the exact local runtime
   origin (for example `http://host.docker.internal:11434`) to
   `PROVIDERS_PRIVATE_ORIGINS`. There is no blanket private-network switch.
3. Start the isolated instance, create the credential/resource and set the
   resource's private-network opt-in when applicable.
4. Stop it, restore `AUTH_MODE=password`, keep the exact origin allow-list entry,
   and start normally.

In password mode a resource owned by `@system` is visible as such, which tells the
operator this procedure created it. Do not promise the same visibility for
credentials: anti-enumeration makes `@system` credentials indistinguishable from
foreign/nonexistent ids and no user's credential inventory owns them. Other users'
credentials remain owner-protected during the authless window because the acting
owner is exactly `@system`; the rest of the instance is not protected.

## Measured provider shapes

The calibration used synthetic requests and records only shapes, counts and
latencies; no captured provider body, response header/cookie, key metadata or local
workstation path is published here.

### OpenAI-compatible / OpenRouter

- Observed default embedding dimensions were 1024, 1536, 3072 and 4096 depending
  on the exact route. OpenAI-shaped batches accepted at most 2048 inputs; the
  measured Qwen route accepted 1024. The OpenAI per-input context was 8192 tokens.
- Valid response bodies measured 60,440,334 bytes (2048×1536), 124,020,823 bytes
  (2048×3072) and 90,150,498 bytes (1024×4096). Transport therefore has a 256 MiB
  hard response ceiling; the executor targets at most 128 MiB once dimensions are
  known.
- Error status is not a sufficient classifier: an invalid key returned 401,
  missing model 400, and batch overflow 400 or 422 depending on route. A successful
  whitespace-only response was also observed, so output schema is mandatory.
- Observed usage fields included prompt/total tokens, cost and cost details.
- External chat streaming TTFT (`n=5`) had median 876 ms.
  `max_completion_tokens` was accepted and won when both it and `max_tokens` were
  present; values below 16 were clamped by the measured provider.

### Native Ollama

- Embeddings use `POST /api/embed` and return `embeddings[][]`, duration counters
  and prompt token count. The measured default width was 768; smaller dimensions
  worked and oversized dimensions were clamped. `truncate:false` rejected beyond
  the exact 2048-token limit, while default truncation succeeded.
- Native chat streams NDJSON and puts counters in the final record. The
  OpenAI-compatible facade streams SSE with OpenAI-shaped usage.
- `think:false` was not semantically portable between native and OpenAI-compatible
  wires for the imported Qwen model.
- Cancellation stopped generation but could leave a model resident. An incomplete
  stream has unknown usage.
- Cold TTFT medians were 4.03 s (Qwen 9B), 6.15 s (GPT-OSS 20B; observed maximum
  21.94 s), and 6.25 s (Qwen 35B). Warm medians were 132/200/91 ms. The 120 s
  first-byte ceiling intentionally leaves room for slower storage and cold OS cache.

References for the measured wire shapes: [Ollama chat API](https://docs.ollama.com/api/chat),
[Ollama embed API](https://docs.ollama.com/api/embed), and
[OpenRouter embeddings API](https://openrouter.ai/docs/api/api-reference/embeddings/create-embeddings).

## Guarantees

- A leaked `meta.db` contains ciphertext rather than live credential and resource
  header values. A Notarium backup also lacks this instance's credential keyring.
- Exported note corpora contain no provider secret.
- Management responses expose only `hasCredentials`, names and allowed metadata;
  secrets/header values are write-only.
- AAD binds ciphertext to its facet, record and field, so moving a credential or
  header ciphertext to another carrier is detected.
- Replacing the master key without the matching canary fails loudly.
- Origin binding prevents the accidental one-record change that sends a credential
  to a different origin. A third party controlling only one of the credential or
  resource records cannot retarget the pair.
- Pinned all-address DNS, redirect refusal and the destination policy apply to every
  outbound provider request.
- Secret values never enter the call log, last-check diagnostic, durable job
  params/result/error, model names or the structures the server logs.

In one sentence: encryption means a leaked database and Notarium ZIP do not contain
live provider credentials; it does **not** mean the machine operator or somebody who
controls the owner's account cannot obtain them.

## Non-guarantees

The following list is deliberate and exhaustive for the current subsystem:

- Anyone who has both the database and key files can decrypt secrets. This includes
  anyone with full `DATA_DIR` access and the instance operator.
- The admin exclusion protects against casual inspection through provider routes,
  not machine access or account recovery: an admin can issue an access-recovery link
  for the owner and then act as that owner.
- PAT/OAuth cannot enumerate or mutate management inventory; they receive only the
  coarse `whoami.hasModel` capability.
- The envelope does not hide ciphertext length. Length beside an open header name
  can distinguish common provider-key formats; the format adds no padding.
- A readable `@system` credential is not revocable in password mode. The only
  recovery path is another full-access authless maintenance window.
- Consent is granted to a Space, not its current member list. Adding members does
  not ask the resource owner again.
- The proposer and accepter may be the same person when a resource owner also
  manages the target Space.
- A host admin can join a non-personal Space through membership recovery and the
  product has no membership-history table that records that action.
- `ClassPolicy.providerEgress` is declared but no v1 path consults it. The coverage
  rule does **not** work yet; current notes do not leave only because this task ships
  no production content consumer. Enforcement belongs to the first consumer.
- A ZIP without `secret-keyring` restores notes, search, Spaces and accounts, but
  not provider credentials. `backup verify` cannot prove decryption because the
  separately retained keyring is intentionally absent.
- Rotation does not make old archives readable with only the new key. Retention
  requires every historical key file that covers retained archives.
- The backup exclusion does not protect an operator who deliberately hard-links or
  bind-mounts key material into a packed root. Symlinks and non-regular files are
  rejected; hard links and bind mounts remain outside the product boundary.
- Attachment changes have no push signal. A stale screen may show the old state
  until refresh, while runtime resolution is already fail-closed.
- The subsystem is a bounded proxy to an arbitrary public HTTPS origin selected by
  a resource owner. Private/loopback proxying is the separately accepted exact-origin
  operator policy; link-local and metadata targets remain impossible.
- A shared credential is one common budget and failure point.
- `origin`, `injection`, resource name and `lastCheck` diagnostic are plaintext in
  the meta-DB/archive. Header **values** are encrypted; open metadata is not.
- For admitted HTTP private origins, origin identifies a name, not a physical peer.
  Whoever owns that address at call time receives the credential.
- The owner of both credential and resource records can intentionally change both
  and send their own key to another recipient.
- A resource owner can read every request made through that resource, including
  profile or agent-memory content a future consumer includes.
- `rpm`/`tpm` limits are process-local. With an external meta-DB and several replicas,
  the effective budget is multiplied by the replica count. They do not isolate two
  scopes sharing one credential.
- A warm vector partition with a live subscriber is not evicted solely because a
  provider resource changed; provider-backed embeddings are not shipped here and
  their future reindex window belongs to that consumer.
- Rotating Notarium's master key does not revoke a credential compromised at the
  upstream provider.
- Log masking is not claimed as a security control. The control is that secret
  values never enter loggable structures.

## Scope boundary

Not included: a direct Anthropic wire, OAuth2 provider credentials, built-in chat,
provider-backed corpus embedding, production background watchers/jobs, automatic
fallback to a different resource, separate background attachments, cost/billing,
ownership transfer, MCP management, class-egress enforcement, or audience-membership
epochs. See [contract.md](contract.md) for REST shapes and [jobs.md](jobs.md) for the
durable runner contract.
