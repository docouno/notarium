import { type FormEvent, useEffect, useMemo, useState } from 'react'
import type {
  CredentialListItem,
  ProviderModel,
  ProviderResource,
  ProviderResourceCreateRequest,
  ProviderResourceHeaderPatch,
  ProviderResourceListItem,
  ProviderResourcePatchRequest,
  Purpose,
  Wire,
} from '@notarium/contract'
import { MODEL_STATUS, PROVIDER_STATUS, PURPOSE, WIRE } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { Checkbox } from '../../core/Checkbox'
import { useDialog } from '../../core/Dialog'
import { DisclosureCard } from '../../core/DisclosureCard'
import { EmptyState } from '../../core/EmptyState'
import { IconEdit, IconLink, IconPlus, IconRefresh, IconTrash } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { Select } from '../../core/Select'
import { SettingsSection } from '../../core/SettingsSection'
import { Switch } from '../../core/Switch'
import { authorLabel } from '../../libs/author'
import { errorText } from '../../libs/errors'
import type { ProviderResourcesProps } from './types'
import styles from './ProviderManagement.module.scss'

type HeaderDraft = {
  key: string
  originalName: string | null
  name: string
  value: string
  remove: boolean
}

type ResourceDraft = {
  name: string
  wire: Wire
  baseUrl: string
  allowPrivateNetwork: boolean
  purposes: Purpose[]
  modelNames: string
  defaultModel: string
  credentialId: string
  firstByteTimeoutMs: string
  callTimeoutMs: string
  disabled: boolean
  headers: HeaderDraft[]
}

let nextHeaderKey = 0
const headerRow = (name = '', originalName: string | null = null): HeaderDraft => ({
  key: `header-${++nextHeaderKey}`,
  originalName,
  name,
  value: '',
  remove: false,
})

const modelsOf = (value: string, current: ProviderModel[] = []): ProviderModel[] => {
  const existing = new Map(current.map((model) => [model.name, model]))

  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ].map((name) => existing.get(name) ?? { name, dimensions: null, status: MODEL_STATUS.available })
}

const timeoutOf = (value: string): number | null => (value.trim() ? Number(value) : null)

const draftOf = (resource?: ProviderResource): ResourceDraft => ({
  name: resource?.name ?? '',
  wire: resource?.wire ?? WIRE.openaiCompatible,
  baseUrl: resource?.baseUrl ?? 'https://openrouter.ai/api/v1',
  allowPrivateNetwork: resource?.allowPrivateNetwork ?? false,
  purposes: resource?.purposes ?? [PURPOSE.chat],
  modelNames: resource?.models.map((model) => model.name).join('\n') ?? '',
  defaultModel: resource?.defaultModel ?? '',
  credentialId: resource?.credentialId ?? '',
  firstByteTimeoutMs:
    resource?.firstByteTimeoutMs == null ? '' : String(resource.firstByteTimeoutMs),
  callTimeoutMs: resource?.callTimeoutMs == null ? '' : String(resource.callTimeoutMs),
  disabled: resource?.disabledAt != null,
  headers: resource?.headerNames?.map((name) => headerRow(name, name)) ?? [],
})

export const providerHeaderPatchOf = (headers: HeaderDraft[]): ProviderResourceHeaderPatch => {
  const patch: ProviderResourceHeaderPatch = {}

  for (const header of headers) {
    if (header.originalName) {
      if (header.remove) {
        patch[header.originalName] = null
      } else if (header.value) {
        patch[header.originalName] = header.value
      }
    } else if (!header.remove && header.name.trim() && header.value) {
      patch[header.name.trim()] = header.value
    }
  }

  return patch
}

const createInput = (draft: ResourceDraft): ProviderResourceCreateRequest => ({
  name: draft.name.trim(),
  wire: draft.wire,
  baseUrl: draft.baseUrl.trim(),
  headers: Object.fromEntries(
    draft.headers
      .filter(
        (header) => !header.originalName && !header.remove && header.name.trim() && header.value,
      )
      .map((header) => [header.name.trim(), header.value]),
  ),
  allowPrivateNetwork: draft.allowPrivateNetwork,
  purposes: draft.purposes,
  models: modelsOf(draft.modelNames),
  defaultModel: draft.defaultModel.trim() || null,
  credentialId: draft.credentialId || null,
  firstByteTimeoutMs: timeoutOf(draft.firstByteTimeoutMs),
  callTimeoutMs: timeoutOf(draft.callTimeoutMs),
})

export const providerResourcePatchOf = (
  current: ProviderResource,
  draft: ResourceDraft,
): ProviderResourcePatchRequest => {
  const patch: ProviderResourcePatchRequest = {}
  const models = modelsOf(draft.modelNames, current.models)
  const headers = providerHeaderPatchOf(draft.headers)
  const firstByteTimeoutMs = timeoutOf(draft.firstByteTimeoutMs)
  const callTimeoutMs = timeoutOf(draft.callTimeoutMs)

  if (draft.name.trim() !== current.name) {
    patch.name = draft.name.trim()
  }
  if (draft.wire !== current.wire) {
    patch.wire = draft.wire
  }
  if (draft.baseUrl.trim() !== current.baseUrl) {
    patch.baseUrl = draft.baseUrl.trim()
  }
  if (draft.allowPrivateNetwork !== current.allowPrivateNetwork) {
    patch.allowPrivateNetwork = draft.allowPrivateNetwork
  }
  if (JSON.stringify(draft.purposes) !== JSON.stringify(current.purposes)) {
    patch.purposes = draft.purposes
  }
  if (JSON.stringify(models) !== JSON.stringify(current.models)) {
    patch.models = models
  }
  if ((draft.defaultModel.trim() || null) !== current.defaultModel) {
    patch.defaultModel = draft.defaultModel.trim() || null
  }
  if ((draft.credentialId || null) !== (current.credentialId ?? null)) {
    patch.credentialId = draft.credentialId || null
  }
  if (firstByteTimeoutMs !== (current.firstByteTimeoutMs ?? null)) {
    patch.firstByteTimeoutMs = firstByteTimeoutMs
  }
  if (callTimeoutMs !== (current.callTimeoutMs ?? null)) {
    patch.callTimeoutMs = callTimeoutMs
  }
  if (draft.disabled !== (current.disabledAt != null)) {
    patch.disabled = draft.disabled
  }
  if (Object.keys(headers).length) {
    patch.headers = headers
  }

  return patch
}

const recipientOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).origin
  } catch {
    return baseUrl.trim() || 'the provider address above'
  }
}

const resourceAdvancedSummary = (draft: ResourceDraft): string => {
  const purposes = draft.purposes.length
    ? draft.purposes
        .map((purpose) => (purpose === PURPOSE.embedding ? 'Embeddings' : 'Chat'))
        .join(' + ')
    : 'No purpose'
  const network = draft.allowPrivateNetwork ? 'private opt-in' : 'external only'
  const timeouts =
    draft.firstByteTimeoutMs || draft.callTimeoutMs ? 'custom timeouts' : 'automatic timeouts'
  const headers = draft.headers.length
    ? `${draft.headers.length} custom header${draft.headers.length === 1 ? '' : 's'}`
    : 'no custom headers'
  return `${purposes} · ${network} · ${timeouts} · ${headers}${draft.disabled ? ' · disabled' : ''}`
}

const ResourceFields = ({
  draft,
  setDraft,
  credentials,
  creating,
  advancedOpen,
  onAdvancedToggle,
  credentialsNextCursor,
  loadingMoreCredentials,
  credentialContinuationError,
  onLoadMoreCredentials,
}: {
  draft: ResourceDraft
  setDraft: (next: ResourceDraft) => void
  credentials: CredentialListItem[]
  creating: boolean
  advancedOpen: boolean
  onAdvancedToggle: (open: boolean) => void
  credentialsNextCursor: string | null
  loadingMoreCredentials: boolean
  credentialContinuationError: string | null
  onLoadMoreCredentials: () => Promise<void>
}) => {
  const setPurpose = (purpose: Purpose, checked: boolean) => {
    const purposes = checked
      ? [...new Set([...draft.purposes, purpose])]
      : draft.purposes.filter((candidate) => candidate !== purpose)
    setDraft({ ...draft, purposes })
  }
  const addHeader = () => setDraft({ ...draft, headers: [...draft.headers, headerRow()] })
  const changeHeader = (key: string, change: Partial<HeaderDraft>) =>
    setDraft({
      ...draft,
      headers: draft.headers.map((header) =>
        header.key === key ? { ...header, ...change } : header,
      ),
    })

  return (
    <>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span>Name</span>
          <input
            value={draft.name}
            required
            data-testid="provider-name"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span>Wire protocol</span>
          <Select<Wire>
            value={draft.wire}
            aria-label="Provider wire protocol"
            data-testid="provider-wire"
            options={[
              { value: WIRE.openaiCompatible, label: 'OpenAI-compatible' },
              { value: WIRE.ollama, label: 'Ollama' },
            ]}
            onChange={(wire) => setDraft({ ...draft, wire })}
          />
        </label>
        <label className={`${styles.field} ${styles.wide}`}>
          <span>Base URL</span>
          <input
            value={draft.baseUrl}
            required
            spellCheck={false}
            data-testid="provider-base-url"
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          />
        </label>
        <div className={`${styles.field} ${styles.wide}`}>
          <span>Credential</span>
          <Select
            value={draft.credentialId}
            aria-label="Provider credential"
            data-testid="provider-credential"
            options={[
              { value: '', label: 'No credential' },
              ...(draft.credentialId &&
              !credentials.some((credential) => credential.id === draft.credentialId)
                ? [
                    {
                      value: draft.credentialId,
                      label: 'Current credential — load more to identify',
                    },
                  ]
                : []),
              ...credentials.map((credential) => ({
                value: credential.id,
                label: credential.name,
              })),
            ]}
            onChange={(credentialId) => setDraft({ ...draft, credentialId })}
          />
          {credentialContinuationError && (
            <span className={styles.error}>{credentialContinuationError}</span>
          )}
          {credentialsNextCursor && (
            <Button
              type="button"
              disabled={loadingMoreCredentials}
              data-testid="provider-credential-load-more"
              onClick={() => void onLoadMoreCredentials()}
            >
              {loadingMoreCredentials ? 'Loading…' : 'Load more credentials'}
            </Button>
          )}
        </div>
        <label className={`${styles.field} ${styles.wide}`}>
          <span>Models — one name per line</span>
          <textarea
            rows={4}
            value={draft.modelNames}
            data-testid="provider-models"
            onChange={(event) => setDraft({ ...draft, modelNames: event.target.value })}
          />
        </label>
      </div>
      <DisclosureCard
        header={
          <>
            <strong className={styles.disclosureTitle}>Advanced settings</strong>
            <span className={styles.disclosureSummary}>{resourceAdvancedSummary(draft)}</span>
          </>
        }
        open={advancedOpen}
        onToggle={onAdvancedToggle}
        testId="provider-advanced"
        headerTestId="provider-advanced-toggle"
      >
        <div className={styles.disclosureBody} data-testid="provider-advanced-content">
          <div className={styles.grid}>
            <div className={`${styles.field} ${styles.wide}`}>
              <span>Purposes</span>
              <div className={styles.inline}>
                <Checkbox
                  checked={draft.purposes.includes(PURPOSE.chat)}
                  label="Chat"
                  onChange={(checked) => setPurpose(PURPOSE.chat, checked)}
                />
                <Checkbox
                  checked={draft.purposes.includes(PURPOSE.embedding)}
                  label="Embeddings"
                  onChange={(checked) => setPurpose(PURPOSE.embedding, checked)}
                />
              </div>
            </div>
            <label className={styles.field}>
              <span>Default model</span>
              <input
                value={draft.defaultModel}
                placeholder="must be listed above"
                onChange={(event) => setDraft({ ...draft, defaultModel: event.target.value })}
              />
            </label>
            <div className={styles.field}>
              <span>Private network</span>
              <Switch
                checked={draft.allowPrivateNetwork}
                label="Allow this exact private origin"
                data-testid="provider-private-opt-in"
                onChange={(allowPrivateNetwork) => setDraft({ ...draft, allowPrivateNetwork })}
              />
              <span className={styles.hint}>
                The operator must separately admit {recipientOf(draft.baseUrl)}. Other internal
                origins are never disclosed here.
              </span>
            </div>
            <label className={styles.field}>
              <span>First byte timeout, ms</span>
              <input
                type="number"
                min="100"
                value={draft.firstByteTimeoutMs}
                placeholder="automatic"
                onChange={(event) => setDraft({ ...draft, firstByteTimeoutMs: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span>Call timeout, ms</span>
              <input
                type="number"
                min="100"
                value={draft.callTimeoutMs}
                placeholder="automatic"
                onChange={(event) => setDraft({ ...draft, callTimeoutMs: event.target.value })}
              />
            </label>
            {!creating && (
              <div className={`${styles.field} ${styles.wide}`}>
                <span>Availability</span>
                <Switch
                  checked={!draft.disabled}
                  label={draft.disabled ? 'Disabled' : 'Enabled'}
                  onChange={(enabled) => setDraft({ ...draft, disabled: !enabled })}
                />
              </div>
            )}
          </div>
          <div className={styles.stack}>
            <div className={styles.inline}>
              <strong>Custom headers</strong>
              <Button type="button" onClick={addHeader}>
                <IconPlus size={13} /> Add header
              </Button>
            </div>
            <p className={styles.hint}>
              Values are encrypted and never shown again. A blank existing value keeps it unchanged.
            </p>
            <div className={styles.headerList} data-testid="provider-headers">
              {draft.headers.map((header) => (
                <div className={styles.headerRow} key={header.key}>
                  <label className={styles.field}>
                    <span>Header name</span>
                    <input
                      value={header.name}
                      disabled={header.originalName != null}
                      onChange={(event) => changeHeader(header.key, { name: event.target.value })}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>{header.originalName ? 'New value — value is set' : 'Value'}</span>
                    <input
                      type="password"
                      value={header.value}
                      disabled={header.remove}
                      autoComplete="new-password"
                      onChange={(event) => changeHeader(header.key, { value: event.target.value })}
                    />
                  </label>
                  <Checkbox
                    checked={header.remove}
                    label={header.originalName ? 'Remove' : 'Discard'}
                    onChange={(remove) => changeHeader(header.key, { remove })}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </DisclosureCard>
      <Notice variant="warning" data-testid="provider-disclosure">
        <span className={styles.disclosure}>
          Calls to <strong>{recipientOf(draft.baseUrl)}</strong> may send note content, agent
          memory, the owner profile and role prompts. Saving does not call the provider; Validate
          does.
        </span>
      </Notice>
    </>
  )
}

export const ProviderResources = ({
  entries,
  hasMore,
  credentials,
  credentialsNextCursor,
  spaces,
  selected,
  loading,
  loadingMore,
  loadingMoreCredentials,
  error,
  continuationError,
  credentialContinuationError,
  statusError,
  detailError,
  selectingId,
  onSelect,
  onLoadMore,
  onLoadMoreCredentials,
  onCreate,
  onPatch,
  onDelete,
  onValidate,
  onOffer,
  onClose,
}: ProviderResourcesProps) => {
  const { confirm } = useDialog()
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<ResourceDraft>(draftOf())
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [message, setMessage] = useState<{
    area: 'checks' | 'sharing'
    text: string
  } | null>(null)
  const [targetSpace, setTargetSpace] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [checksOpen, setChecksOpen] = useState(false)
  const [sharingOpen, setSharingOpen] = useState(false)

  useEffect(() => {
    if (selected) {
      setDraft(draftOf(selected.resource))
    }
  }, [selected])
  useEffect(() => {
    if (!targetSpace && spaces[0]) {
      setTargetSpace(spaces[0].id)
    }
  }, [spaces, targetSpace])

  const selectedOwner = selected?.resource.owner.mine ?? false
  const statuses = useMemo(
    () =>
      selected
        ? selected.resource.purposes.map((purpose) => ({
            purpose,
            check: selected.resource.lastCheck[purpose],
          }))
        : [],
    [selected],
  )

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await onCreate(createInput(draft))
      setCreating(false)
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
    const patch = providerResourcePatchOf(selected.resource, draft)

    if (!Object.keys(patch).length) {
      setAdvancedOpen(false)
      setChecksOpen(false)
      setSharingOpen(false)
      onClose()
      return
    }
    setBusy(true)
    try {
      await onPatch(selected.resource.id, patch)
      setAdvancedOpen(false)
      setChecksOpen(false)
      setSharingOpen(false)
      setActionError(null)
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (resource: ProviderResourceListItem) => {
    const ok = await confirm({
      title: `Delete “${resource.name}”?`,
      message: 'Its Space attachments will be removed with it. The credential, if any, stays.',
      confirmLabel: 'Delete',
      danger: true,
    })

    if (!ok) {
      return
    }
    try {
      await onDelete(resource.id)
      setActionError(null)
    } catch (cause) {
      setActionError(errorText(cause))
    }
  }

  const validate = async (purpose: Purpose) => {
    if (!selected) {
      return
    }
    setBusy(true)
    try {
      const result = await onValidate(selected.resource.id, purpose)
      setMessage({
        area: 'checks',
        text: result.saved
          ? 'Validation result saved.'
          : 'The resource changed during validation; the result was not saved.',
      })
      setActionError(null)
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const offer = async () => {
    if (!selected || !targetSpace) {
      return
    }
    setBusy(true)
    try {
      await onOffer(selected.resource.id, targetSpace)
      setMessage({ area: 'sharing', text: 'Attachment offer sent to the Space owner.' })
      setActionError(null)
    } catch (cause) {
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
      title="Model providers"
      description="Resources name an exact recipient, protocol, models and an optional credential."
      testId="provider-resources"
      action={
        !creating && !selected ? (
          <Button
            data-testid="provider-new"
            onClick={() => {
              onClose()
              setCreating(true)
              setDraft(draftOf())
              setAdvancedOpen(false)
              setChecksOpen(false)
              setSharingOpen(false)
              setMessage(null)
              setActionError(null)
            }}
          >
            <IconPlus size={14} /> New resource
          </Button>
        ) : undefined
      }
    >
      <div className={styles.stack}>
        {error && <Notice variant="error">{error}</Notice>}
        {statusError && <Notice variant="error">{statusError}</Notice>}
        {detailError && <Notice variant="error">{detailError}</Notice>}
        {selectingId && (
          <p className={styles.meta} aria-live="polite">
            Loading model provider…
          </p>
        )}
        {actionError && !creating && !selected && <p className={styles.error}>{actionError}</p>}
        {creating && (
          <form
            className={styles.form}
            data-testid="provider-create-form"
            onSubmit={(event) => void submitCreate(event)}
          >
            <div className={styles.formHeader}>New model provider</div>
            <ResourceFields
              draft={draft}
              setDraft={setDraft}
              credentials={credentials}
              creating
              advancedOpen={advancedOpen}
              onAdvancedToggle={setAdvancedOpen}
              credentialsNextCursor={credentialsNextCursor}
              loadingMoreCredentials={loadingMoreCredentials}
              credentialContinuationError={credentialContinuationError}
              onLoadMoreCredentials={onLoadMoreCredentials}
            />
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
              <Button
                type="submit"
                variant="primary"
                disabled={busy || draft.purposes.length === 0}
              >
                Create
              </Button>
            </div>
          </form>
        )}
        {selected && selectedOwner && (
          <form
            className={styles.form}
            data-testid="provider-edit-form"
            onSubmit={(event) => void submitEdit(event)}
          >
            <div className={styles.formHeader}>Edit model provider</div>
            <ResourceFields
              draft={draft}
              setDraft={setDraft}
              credentials={credentials}
              creating={false}
              advancedOpen={advancedOpen}
              onAdvancedToggle={setAdvancedOpen}
              credentialsNextCursor={credentialsNextCursor}
              loadingMoreCredentials={loadingMoreCredentials}
              credentialContinuationError={credentialContinuationError}
              onLoadMoreCredentials={onLoadMoreCredentials}
            />
            {selected.warnings.length > 0 && (
              <ul className={styles.warningList}>
                {selected.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            )}
            {actionError && <p className={styles.error}>{actionError}</p>}
            <div className={styles.actions}>
              <Button type="button" onClick={onClose}>
                Close
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || draft.purposes.length === 0}
              >
                Save
              </Button>
            </div>
            <DisclosureCard
              header={
                <>
                  <strong className={styles.disclosureTitle}>Connection checks</strong>
                  <span className={styles.disclosureSummary}>
                    {statuses.length
                      ? statuses
                          .map(
                            ({ purpose, check }) =>
                              `${purpose} ${check?.status ?? PROVIDER_STATUS.unverified}`,
                          )
                          .join(' · ')
                      : 'No configured purposes'}
                  </span>
                </>
              }
              open={checksOpen}
              onToggle={setChecksOpen}
              testId="provider-checks"
              headerTestId="provider-checks-toggle"
            >
              <div className={styles.disclosureBody}>
                {message?.area === 'checks' && <Notice>{message.text}</Notice>}
                <div className={styles.statusList} data-testid="provider-statuses">
                  {statuses.map(({ purpose, check }) => (
                    <div className={styles.statusRow} key={purpose}>
                      <strong>{purpose}</strong>
                      <span>
                        {check?.status ?? PROVIDER_STATUS.unverified}
                        {check?.diagnostic ? ` — ${check.diagnostic}` : ''}
                        {draft.wire === WIRE.ollama &&
                        check?.status === PROVIDER_STATUS.ready &&
                        !check.credentialProven
                          ? ' — reachability checked; credentials were not verified'
                          : ''}
                      </span>
                      <Button type="button" disabled={busy} onClick={() => void validate(purpose)}>
                        <IconRefresh size={13} /> Validate
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </DisclosureCard>
            <DisclosureCard
              header={
                <>
                  <strong className={styles.disclosureTitle}>Share with a Space</strong>
                  <span className={styles.disclosureSummary}>
                    {spaces.length
                      ? `${spaces.length} available Space${spaces.length === 1 ? '' : 's'}`
                      : 'No eligible Spaces'}
                  </span>
                </>
              }
              open={sharingOpen}
              onToggle={setSharingOpen}
              testId="provider-sharing"
              headerTestId="provider-sharing-toggle"
            >
              <div className={styles.disclosureBody}>
                {message?.area === 'sharing' && <Notice>{message.text}</Notice>}
                <div className={styles.grid}>
                  <div className={styles.field}>
                    <span>Target Space</span>
                    <Select
                      value={targetSpace}
                      aria-label="Target Space"
                      options={spaces.map((space) => ({
                        value: space.id,
                        label: space.displayName,
                      }))}
                      onChange={setTargetSpace}
                    />
                  </div>
                  <div className={styles.field}>
                    <span>Offer</span>
                    <Button
                      type="button"
                      disabled={busy || !targetSpace}
                      onClick={() => void offer()}
                    >
                      <IconLink size={13} /> Ask for consent
                    </Button>
                  </div>
                </div>
              </div>
            </DisclosureCard>
          </form>
        )}
        {selected && !selectedOwner && (
          <div className={styles.form}>
            <strong>{selected.resource.name}</strong>
            <p className={styles.meta}>
              Owned by {authorLabel(selected.resource.owner).text}. Recipient details are
              intentionally hidden.
            </p>
            <Button onClick={onClose}>Close</Button>
          </div>
        )}
        {entries && entries.length === 0 && !creating && (
          <EmptyState
            icon={<IconLink size={22} />}
            title="No model providers yet"
            hint="Create a resource or accept one from a Space member."
          />
        )}
        {entries && entries.length > 0 && (
          <table className={styles.table} data-testid="provider-list">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Wire</th>
                <th>Purposes</th>
                <th>Models</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map(({ resource, owned, unusableBecause, statusState }) => (
                <tr key={resource.id} data-testid="provider-row">
                  <td className={styles.cellName}>
                    {resource.name}
                    <div className={styles.cellSub}>
                      {owned ? resource.baseUrl : `Owned by ${authorLabel(resource.owner).text}`}
                      {!owned && (
                        <span data-testid="provider-foreign-safe-details">
                          {' '}
                          · {resource.hasCredentials
                            ? 'credential configured'
                            : 'no credential'} ·{' '}
                          {resource.addressIsPrivate ? 'private network' : 'external service'}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className={styles.badge}>{resource.wire}</span>
                  </td>
                  <td>{resource.purposes.join(', ')}</td>
                  <td>{resource.modelCount}</td>
                  <td>
                    {statusState === 'checking'
                      ? 'Checking…'
                      : statusState === 'error'
                        ? 'Status unavailable'
                        : (unusableBecause ?? (resource.disabledAt ? 'disabled' : 'available'))}
                  </td>
                  <td className={styles.cellActions}>
                    {owned && (
                      <Button
                        icon
                        variant="ghost"
                        disabled={selectingId === resource.id}
                        aria-busy={selectingId === resource.id}
                        title={`Edit ${resource.name}`}
                        onClick={() => {
                          setAdvancedOpen(false)
                          setChecksOpen(false)
                          setSharingOpen(false)
                          setMessage(null)
                          setActionError(null)
                          void select(resource.id)
                        }}
                      >
                        <IconEdit size={14} />
                      </Button>
                    )}
                    {owned && (
                      <Button
                        icon
                        variant="ghost"
                        title={`Delete ${resource.name}`}
                        onClick={() => void remove(resource)}
                      >
                        <IconTrash size={14} />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {loading && entries == null && <p className={styles.empty}>Loading providers…</p>}
        {continuationError && <Notice variant="error">{continuationError}</Notice>}
        {hasMore && (
          <div className={styles.actions}>
            <Button
              type="button"
              disabled={loadingMore}
              data-testid="provider-load-more"
              onClick={() => void onLoadMore()}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  )
}
