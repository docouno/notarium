import { type FormEvent, useEffect, useMemo, useState } from 'react'
import type {
  Credential,
  CredentialCreateRequest,
  CredentialKind,
  CredentialListItem,
  CredentialPatchRequest,
  ProviderRetargetRequest,
} from '@notarium/contract'
import { PROVIDER_LIST_PAGE_SIZE } from '@notarium/contract/enums'
import { CREDENTIAL_KIND } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { useDialog } from '../../core/Dialog'
import { DisclosureCard } from '../../core/DisclosureCard'
import { EmptyState } from '../../core/EmptyState'
import { IconEdit, IconKey, IconPlus, IconTrash } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Select } from '../../core/Select'
import { SettingsSection } from '../../core/SettingsSection'
import { Switch } from '../../core/Switch'
import { errorText } from '../../libs/errors'
import type { ProviderCredentialsProps } from './types'
import styles from './ProviderManagement.module.scss'

type CredentialDraft = {
  name: string
  kind: CredentialKind
  secret: string
  origin: string
  header: string
  prefix: string
  rpm: string
  tpm: string
  disabled: boolean
}

const draftOf = (credential?: Credential): CredentialDraft => ({
  name: credential?.name ?? '',
  kind: credential?.kind ?? CREDENTIAL_KIND.bearer,
  secret: '',
  origin: credential?.origin ?? 'https://openrouter.ai',
  header: credential?.injection.header ?? '',
  prefix: credential?.injection.prefix ?? 'Bearer ',
  rpm: credential?.rpm == null ? '' : String(credential.rpm),
  tpm: credential?.tpm == null ? '' : String(credential.tpm),
  disabled: credential?.disabledAt != null,
})

const limitOf = (value: string): number | null => {
  const trimmed = value.trim()
  return trimmed ? Number(trimmed) : null
}

const createInput = (draft: CredentialDraft): CredentialCreateRequest => ({
  name: draft.name.trim(),
  kind: draft.kind,
  secret: draft.secret,
  origin: draft.origin.trim(),
  injection: { header: draft.header.trim(), prefix: draft.prefix },
  rpm: limitOf(draft.rpm),
  tpm: limitOf(draft.tpm),
})

export const credentialPatchOf = (
  current: Credential,
  draft: CredentialDraft,
): CredentialPatchRequest => {
  const patch: CredentialPatchRequest = {}
  const rpm = limitOf(draft.rpm)
  const tpm = limitOf(draft.tpm)
  const injection = { header: draft.header.trim(), prefix: draft.prefix }

  if (draft.name.trim() !== current.name) {
    patch.name = draft.name.trim()
  }
  if (draft.origin.trim() !== current.origin) {
    patch.origin = draft.origin.trim()
  }
  if (draft.secret) {
    patch.secret = draft.secret
  }
  if (
    injection.header !== current.injection.header ||
    injection.prefix !== current.injection.prefix
  ) {
    patch.injection = injection
  }
  if (rpm !== current.rpm) {
    patch.rpm = rpm
  }
  if (tpm !== current.tpm) {
    patch.tpm = tpm
  }
  if (draft.disabled !== (current.disabledAt != null)) {
    patch.disabled = draft.disabled
  }

  return patch
}

const credentialAdvancedSummary = (draft: CredentialDraft): string => {
  const defaultPrefix = draft.kind === CREDENTIAL_KIND.bearer ? 'Bearer ' : ''
  const authentication =
    draft.header.trim() || draft.prefix !== defaultPrefix ? 'custom request auth' : 'default header'
  const limits = draft.rpm || draft.tpm ? 'custom limits' : 'default limits'
  return `${authentication} · ${limits}${draft.disabled ? ' · disabled' : ''}`
}

const CredentialBasicFields = ({
  draft,
  setDraft,
  creating,
  originLocked,
}: {
  draft: CredentialDraft
  setDraft: (next: CredentialDraft) => void
  creating: boolean
  originLocked: boolean
}) => (
  <div className={styles.grid}>
    <label className={styles.field}>
      <span>Name</span>
      <input
        value={draft.name}
        data-testid="credential-name"
        onChange={(event) => setDraft({ ...draft, name: event.target.value })}
      />
    </label>
    <label className={styles.field}>
      <span>Mechanism</span>
      <Select<CredentialKind>
        value={draft.kind}
        disabled={!creating}
        aria-label="Credential mechanism"
        data-testid="credential-kind"
        options={[
          { value: CREDENTIAL_KIND.bearer, label: 'Bearer token' },
          { value: CREDENTIAL_KIND.header, label: 'Header value' },
        ]}
        onChange={(kind) =>
          setDraft({
            ...draft,
            kind,
            prefix: kind === CREDENTIAL_KIND.bearer ? 'Bearer ' : '',
          })
        }
      />
    </label>
    <label className={`${styles.field} ${styles.wide}`}>
      <span>Origin</span>
      <input
        value={draft.origin}
        disabled={originLocked}
        data-testid="credential-origin"
        spellCheck={false}
        onChange={(event) => setDraft({ ...draft, origin: event.target.value })}
      />
      {originLocked && (
        <span className={styles.hint}>
          Open Used by below to retarget every referenced resource atomically.
        </span>
      )}
    </label>
    <label className={`${styles.field} ${styles.wide}`}>
      <span>{creating ? 'Secret' : 'Replacement secret'}</span>
      <input
        type="password"
        value={draft.secret}
        required={creating}
        autoComplete="new-password"
        data-testid="credential-secret"
        onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
      />
      {!creating && <span className={styles.hint}>Value is set. Leave blank to keep it.</span>}
    </label>
  </div>
)

const CredentialAdvancedFields = ({
  draft,
  setDraft,
  creating,
}: {
  draft: CredentialDraft
  setDraft: (next: CredentialDraft) => void
  creating: boolean
}) => (
  <div className={styles.grid} data-testid="credential-advanced-content">
    <label className={styles.field}>
      <span>Header name</span>
      <input
        value={draft.header}
        placeholder="default for mechanism"
        data-testid="credential-header"
        onChange={(event) => setDraft({ ...draft, header: event.target.value })}
      />
    </label>
    <label className={styles.field}>
      <span>Value prefix</span>
      <input
        value={draft.prefix}
        data-testid="credential-prefix"
        onChange={(event) => setDraft({ ...draft, prefix: event.target.value })}
      />
    </label>
    <label className={styles.field}>
      <span>Requests per minute</span>
      <input
        type="number"
        min="1"
        value={draft.rpm}
        placeholder="host default"
        data-testid="credential-rpm"
        onChange={(event) => setDraft({ ...draft, rpm: event.target.value })}
      />
    </label>
    <label className={styles.field}>
      <span>Tokens per minute</span>
      <input
        type="number"
        min="1"
        value={draft.tpm}
        placeholder="unlimited"
        data-testid="credential-tpm"
        onChange={(event) => setDraft({ ...draft, tpm: event.target.value })}
      />
    </label>
    {!creating && (
      <div className={`${styles.field} ${styles.wide}`}>
        <span>Availability</span>
        <Switch
          checked={!draft.disabled}
          label={draft.disabled ? 'Disabled' : 'Enabled'}
          data-testid="credential-enabled"
          onChange={(enabled) => setDraft({ ...draft, disabled: !enabled })}
        />
      </div>
    )}
  </div>
)

const RetargetForm = ({
  credential,
  resources,
  onRetarget,
  onCancel,
}: {
  credential: Credential
  resources: ProviderCredentialsProps['referencedResources']
  onRetarget: ProviderCredentialsProps['onRetarget']
  onCancel: () => void
}) => {
  const [origin, setOrigin] = useState(credential.origin)
  const [rows, setRows] = useState(() =>
    resources.map((resource) => ({
      id: resource.id,
      baseUrl: resource.baseUrl ?? '',
      detach: false,
    })),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [visibleRows, setVisibleRows] = useState(PROVIDER_LIST_PAGE_SIZE)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const input: ProviderRetargetRequest = {
      origin: origin.trim(),
      resources: rows.map((row) => ({
        id: row.id,
        baseUrl: row.baseUrl.trim(),
        detachCredential: row.detach,
      })),
    }
    setBusy(true)
    try {
      await onRetarget(credential.id, input)
      onCancel()
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className={styles.form}
      data-testid="credential-retarget-form"
      onSubmit={(e) => void submit(e)}
    >
      <div className={styles.formHeader}>Retarget credential</div>
      <Notice variant="warning">
        Changing the credential recipient updates every referencing resource atomically and asks
        attached Spaces to consent again. Confirm each exact URL; Notarium will not derive paths.
      </Notice>
      <label className={styles.field}>
        <span>New exact origin</span>
        <input value={origin} required onChange={(event) => setOrigin(event.target.value)} />
      </label>
      {rows.slice(0, visibleRows).map((row, index) => (
        <div className={styles.grid} key={row.id}>
          <label className={styles.field}>
            <span>{resources[index]?.name ?? row.id}</span>
            <input
              value={row.baseUrl}
              required={!row.detach}
              disabled={row.detach}
              onChange={(event) =>
                setRows(
                  rows.map((item) =>
                    item.id === row.id ? { ...item, baseUrl: event.target.value } : item,
                  ),
                )
              }
            />
          </label>
          <div className={styles.field}>
            <span>Credential</span>
            <Switch
              checked={row.detach}
              label="Detach instead"
              onChange={(detach) =>
                setRows(rows.map((item) => (item.id === row.id ? { ...item, detach } : item)))
              }
            />
          </div>
        </div>
      ))}
      {visibleRows < rows.length && (
        <div className={styles.actions}>
          <Button
            type="button"
            data-testid="credential-retarget-load-more"
            onClick={() => setVisibleRows((current) => current + PROVIDER_LIST_PAGE_SIZE)}
          >
            Load more resources
          </Button>
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.actions}>
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          Retarget all
        </Button>
      </div>
    </form>
  )
}

export const ProviderCredentials = ({
  credentials,
  total,
  nextCursor,
  selected,
  referencedResources,
  loading,
  loadingMore,
  error,
  continuationError,
  detailError,
  selectingId,
  onSelect,
  onLoadMore,
  onCreate,
  onPatch,
  onPrepareRetarget,
  onRetarget,
  onDelete,
  onClose,
}: ProviderCredentialsProps) => {
  const { confirm } = useDialog()
  const [creating, setCreating] = useState(false)
  const [retargeting, setRetargeting] = useState(false)
  const [draft, setDraft] = useState<CredentialDraft>(draftOf())
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)

  useEffect(() => {
    if (selected) {
      setDraft(draftOf(selected.credential))
    }
  }, [selected])

  const referenceNames = useMemo(
    () => selected?.references.map((reference) => reference.name) ?? [],
    [selected],
  )

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await onCreate(createInput(draft))
      setCreating(false)
      setDraft(draftOf())
      setAdvancedOpen(false)
      setActionError(null)
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const submitEdit = async (event: FormEvent) => {
    event.preventDefault()
    if (!selected) {
      return
    }
    const patch = credentialPatchOf(selected.credential, draft)

    if (!Object.keys(patch).length) {
      setAdvancedOpen(false)
      setUsageOpen(false)
      onClose()
      return
    }
    setBusy(true)
    try {
      await onPatch(selected.credential.id, patch)
      setAdvancedOpen(false)
      setUsageOpen(false)
      setActionError(null)
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (credential: CredentialListItem) => {
    const ok = await confirm({
      title: `Delete “${credential.name}”?`,
      message:
        'The encrypted value will be deleted. If provider resources still use it, Notarium will refuse and show every reference.',
      confirmLabel: 'Delete',
      danger: true,
    })

    if (!ok) {
      return
    }
    try {
      await onDelete(credential.id)
      setActionError(null)
    } catch (cause) {
      setUsageOpen(true)
      setActionError(errorText(cause))
    }
  }

  const prepareRetarget = async () => {
    setBusy(true)
    setActionError(null)
    try {
      await onPrepareRetarget()
      setRetargeting(true)
    } catch (cause) {
      setUsageOpen(true)
      setActionError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const select = async (id: string) => {
    setActionError(null)
    try {
      await onSelect(id)
    } catch (cause) {
      setActionError(errorText(cause))
    }
  }

  return (
    <SettingsSection
      title="Credentials"
      description="Encrypted provider secrets. Secret values are write-only and never return to the browser."
      testId="provider-credentials"
      action={
        !creating && !selected ? (
          <Button
            data-testid="credential-new"
            onClick={() => {
              onClose()
              setCreating(true)
              setDraft(draftOf())
              setAdvancedOpen(false)
              setUsageOpen(false)
              setActionError(null)
            }}
          >
            <IconPlus size={14} /> New credential
          </Button>
        ) : undefined
      }
    >
      <div className={styles.stack}>
        {error && <Notice variant="error">{error}</Notice>}
        {detailError && <Notice variant="error">{detailError}</Notice>}
        {selectingId && (
          <p className={styles.meta} aria-live="polite">
            Loading credential…
          </p>
        )}
        {actionError && !creating && !selected && <p className={styles.error}>{actionError}</p>}
        {creating && (
          <form
            className={styles.form}
            data-testid="credential-create-form"
            onSubmit={(e) => void submitCreate(e)}
          >
            <div className={styles.formHeader}>New credential</div>
            <CredentialBasicFields
              draft={draft}
              setDraft={setDraft}
              creating
              originLocked={false}
            />
            <DisclosureCard
              header={
                <>
                  <strong className={styles.disclosureTitle}>Advanced settings</strong>
                  <span className={styles.disclosureSummary}>
                    {credentialAdvancedSummary(draft)}
                  </span>
                </>
              }
              open={advancedOpen}
              onToggle={setAdvancedOpen}
              testId="credential-advanced"
              headerTestId="credential-advanced-toggle"
            >
              <div className={styles.disclosureBody}>
                <CredentialAdvancedFields draft={draft} setDraft={setDraft} creating />
              </div>
            </DisclosureCard>
            {actionError && <p className={styles.error}>{actionError}</p>}
            <div className={styles.actions}>
              <Button
                type="button"
                onClick={() => {
                  setCreating(false)
                  setAdvancedOpen(false)
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                Create
              </Button>
            </div>
          </form>
        )}
        {selected && !retargeting && (
          <form
            className={styles.form}
            data-testid="credential-edit-form"
            onSubmit={(e) => void submitEdit(e)}
          >
            <div className={styles.formHeader}>Edit credential</div>
            <CredentialBasicFields
              draft={draft}
              setDraft={setDraft}
              creating={false}
              originLocked={selected.references.length > 0}
            />
            <DisclosureCard
              header={
                <>
                  <strong className={styles.disclosureTitle}>Advanced settings</strong>
                  <span className={styles.disclosureSummary}>
                    {credentialAdvancedSummary(draft)}
                  </span>
                </>
              }
              open={advancedOpen}
              onToggle={setAdvancedOpen}
              testId="credential-advanced"
              headerTestId="credential-advanced-toggle"
            >
              <div className={styles.disclosureBody}>
                <CredentialAdvancedFields draft={draft} setDraft={setDraft} creating={false} />
              </div>
            </DisclosureCard>
            <DisclosureCard
              header={
                <>
                  <strong className={styles.disclosureTitle}>Used by</strong>
                  <span className={styles.disclosureSummary}>
                    {referenceNames.length
                      ? `${referenceNames.length} provider resource${referenceNames.length === 1 ? '' : 's'}`
                      : 'No references'}
                  </span>
                </>
              }
              open={usageOpen}
              onToggle={setUsageOpen}
              testId="credential-usage"
              headerTestId="credential-usage-toggle"
            >
              <div className={styles.disclosureBody}>
                {referenceNames.length ? (
                  <>
                    <ul className={styles.refs} data-testid="credential-references">
                      {referenceNames.map((name) => (
                        <li key={name}>{name}</li>
                      ))}
                    </ul>
                    <div className={styles.actions}>
                      <Button type="button" disabled={busy} onClick={() => void prepareRetarget()}>
                        Retarget resources…
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className={styles.meta}>This credential is not used by a model provider.</p>
                )}
              </div>
            </DisclosureCard>
            {actionError && <p className={styles.error}>{actionError}</p>}
            <div className={styles.actions}>
              <Button type="button" disabled={busy} onClick={onClose}>
                Close
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                Save
              </Button>
            </div>
          </form>
        )}
        {selected && retargeting && (
          <RetargetForm
            credential={selected.credential}
            resources={referencedResources}
            onRetarget={onRetarget}
            onCancel={() => setRetargeting(false)}
          />
        )}
        {credentials && credentials.length === 0 && !creating && (
          <EmptyState
            icon={<IconKey size={22} />}
            title="No credentials yet"
            hint="Add a provider key or a custom header value."
          />
        )}
        {credentials && credentials.length > 0 && (
          <table className={styles.table} data-testid="credential-list">
            <thead>
              <tr>
                <th>Credential</th>
                <th>Mechanism</th>
                <th>Limits</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {credentials.map((credential) => (
                <tr key={credential.id} data-testid="credential-row">
                  <td className={styles.cellName}>
                    {credential.name}
                    <div className={styles.cellSub}>{credential.origin}</div>
                  </td>
                  <td>
                    <span className={styles.badge}>{credential.kind}</span>
                  </td>
                  <td>
                    {credential.rpm ? `${credential.rpm} rpm` : 'default rpm'} ·{' '}
                    {credential.tpm ? `${credential.tpm} tpm` : 'no tpm cap'}
                  </td>
                  <td>
                    <span
                      className={`${styles.badge} ${credential.disabledAt ? styles.badgeDanger : ''}`}
                    >
                      {credential.disabledAt ? 'disabled' : 'enabled'}
                    </span>
                  </td>
                  <td className={styles.cellActions}>
                    <Button
                      icon
                      variant="ghost"
                      disabled={busy || selectingId === credential.id}
                      aria-busy={selectingId === credential.id}
                      title={`Edit ${credential.name}`}
                      onClick={() => {
                        setAdvancedOpen(false)
                        setUsageOpen(false)
                        setRetargeting(false)
                        setActionError(null)
                        void select(credential.id)
                      }}
                    >
                      <IconEdit size={14} />
                    </Button>
                    <Button
                      icon
                      variant="ghost"
                      disabled={busy}
                      title={`Delete ${credential.name}`}
                      onClick={() => void remove(credential)}
                    >
                      <IconTrash size={14} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {loading && credentials == null && <p className={styles.empty}>Loading credentials…</p>}
        {continuationError && <Notice variant="error">{continuationError}</Notice>}
        {nextCursor && (
          <div className={styles.actions}>
            <Button
              type="button"
              disabled={loadingMore}
              data-testid="credential-load-more"
              onClick={() => void onLoadMore()}
            >
              {loadingMore ? 'Loading…' : `Load more (${credentials?.length ?? 0} of ${total})`}
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  )
}
