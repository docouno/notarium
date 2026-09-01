import {
  type Dispatch,
  type FormEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  CredentialListItem,
  ModelCapability,
  ProviderModelWrite,
  ProviderResource,
  ProviderResourceCreateRequest,
  ProviderResourceHeaderPatch,
  ProviderResourceListItem,
  ProviderResourcePatchRequest,
  Wire,
} from '@notarium/contract'
import { MODEL_CAPABILITY, PROVIDER_STATUS, WIRE } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { Checkbox } from '../../core/Checkbox'
import { useDialog } from '../../core/Dialog'
import { DisclosureCard } from '../../core/DisclosureCard'
import { EmptyState } from '../../core/EmptyState'
import {
  IconEdit,
  IconLink,
  IconPlus,
  IconRefresh,
  IconStar,
  IconStarFilled,
  IconTrash,
} from '../../core/Icons'
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
  models: ModelDraft[]
  defaultModelKey: string | null
  credentialId: string
  firstByteTimeoutMs: string
  callTimeoutMs: string
  disabled: boolean
  headers: HeaderDraft[]
}

type ModelDraft = ProviderModelWrite & { key: string }

let nextHeaderKey = 0
let nextModelKey = 0
const headerRow = (name = '', originalName: string | null = null): HeaderDraft => ({
  key: `header-${++nextHeaderKey}`,
  originalName,
  name,
  value: '',
  remove: false,
})

const capabilityOrder = [MODEL_CAPABILITY.completion, MODEL_CAPABILITY.embedding] as const
const canonicalCapabilities = (capabilities: readonly ModelCapability[]): ModelCapability[] =>
  capabilityOrder.filter((capability) => capabilities.includes(capability))

const modelRow = (model?: ProviderModelWrite): ModelDraft => ({
  key: `model-${++nextModelKey}`,
  name: model?.name ?? '',
  capabilities: canonicalCapabilities(model?.capabilities ?? [MODEL_CAPABILITY.completion]),
})

const modelsOf = (draft: ResourceDraft): ProviderModelWrite[] =>
  draft.models.map(({ name, capabilities }) => ({
    name,
    capabilities: canonicalCapabilities(capabilities),
  }))

const defaultModelOf = (draft: ResourceDraft): string | null =>
  draft.models.find((model) => model.key === draft.defaultModelKey)?.name ?? null

const modelDraftError = (draft: ResourceDraft): string | null => {
  const models = modelsOf(draft)

  if (models.some(({ name }) => name.trim().length === 0)) {
    return 'Every model name must contain a non-whitespace character.'
  }
  if (new Set(models.map(({ name }) => name)).size !== models.length) {
    return 'Model names must be unique exactly as entered.'
  }
  if (models.some(({ capabilities }) => capabilities.length === 0)) {
    return 'Every model needs at least one capability.'
  }
  if (draft.defaultModelKey && defaultModelOf(draft) === null) {
    return 'The default must name one exact model row.'
  }

  return null
}

const comparableDraft = (draft: ResourceDraft) => ({
  ...draft,
  models: modelsOf(draft),
  defaultModel: defaultModelOf(draft),
  defaultModelKey: undefined,
  headers: draft.headers.map(({ name, originalName, remove, value }) => ({
    name,
    originalName,
    remove,
    value,
  })),
})
const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const authoredModelsOf = (resource: ProviderResource): ProviderModelWrite[] =>
  resource.models.map(({ name, capabilities }) => ({
    name,
    capabilities: canonicalCapabilities(capabilities),
  }))

const timeoutOf = (value: string): number | null => (value.trim() ? Number(value) : null)

const draftOf = (resource?: ProviderResource): ResourceDraft => {
  const models = resource?.models.map((model) => modelRow(model)) ?? []

  return {
    name: resource?.name ?? '',
    wire: resource?.wire ?? WIRE.openaiCompatible,
    baseUrl: resource?.baseUrl ?? 'https://openrouter.ai/api/v1',
    allowPrivateNetwork: resource?.allowPrivateNetwork ?? false,
    models,
    defaultModelKey: models.find((model) => model.name === resource?.defaultModel)?.key ?? null,
    credentialId: resource?.credentialId ?? '',
    firstByteTimeoutMs:
      resource?.firstByteTimeoutMs == null ? '' : String(resource.firstByteTimeoutMs),
    callTimeoutMs: resource?.callTimeoutMs == null ? '' : String(resource.callTimeoutMs),
    disabled: resource?.disabledAt != null,
    headers: resource?.headerNames?.map((name) => headerRow(name, name)) ?? [],
  }
}

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
  models: modelsOf(draft),
  defaultModel: defaultModelOf(draft),
  credentialId: draft.credentialId || null,
  firstByteTimeoutMs: timeoutOf(draft.firstByteTimeoutMs),
  callTimeoutMs: timeoutOf(draft.callTimeoutMs),
})

export const providerResourcePatchOf = (
  current: ProviderResource,
  draft: ResourceDraft,
): ProviderResourcePatchRequest => {
  const patch: ProviderResourcePatchRequest = {}
  const models = modelsOf(draft)
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
  if (JSON.stringify(models) !== JSON.stringify(authoredModelsOf(current))) {
    patch.models = models
  }
  const defaultModel = defaultModelOf(draft)

  if (defaultModel !== current.defaultModel) {
    patch.defaultModel = defaultModel
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
  const capabilities = capabilityOrder.filter((capability) =>
    draft.models.some((model) => model.capabilities.includes(capability)),
  )
  const modelSummary = `${draft.models.length} model${draft.models.length === 1 ? '' : 's'}`
  const capabilitySummary = capabilities.length ? capabilities.join(' + ') : 'no capabilities'
  const network = draft.allowPrivateNetwork ? 'private opt-in' : 'external only'
  const timeouts =
    draft.firstByteTimeoutMs || draft.callTimeoutMs ? 'custom timeouts' : 'automatic timeouts'
  const headers = draft.headers.length
    ? `${draft.headers.length} custom header${draft.headers.length === 1 ? '' : 's'}`
    : 'no custom headers'
  return `${modelSummary}, ${capabilitySummary} · ${network} · ${timeouts} · ${headers}${draft.disabled ? ' · disabled' : ''}`
}

const ResourceFields = ({
  draft,
  setDraft,
  credentials,
  creating,
  disabled,
  advancedOpen,
  onAdvancedToggle,
  credentialsNextCursor,
  loadingMoreCredentials,
  credentialContinuationError,
  onLoadMoreCredentials,
}: {
  draft: ResourceDraft
  setDraft: Dispatch<SetStateAction<ResourceDraft>>
  credentials: CredentialListItem[]
  creating: boolean
  disabled: boolean
  advancedOpen: boolean
  onAdvancedToggle: (open: boolean) => void
  credentialsNextCursor: string | null
  loadingMoreCredentials: boolean
  credentialContinuationError: string | null
  onLoadMoreCredentials: () => Promise<void>
}) => {
  const addModel = () => setDraft({ ...draft, models: [...draft.models, modelRow()] })

  const changeModel = (key: string, change: Partial<ProviderModelWrite>) => {
    setDraft({
      ...draft,
      models: draft.models.map((model) => {
        if (model.key !== key) {
          return model
        }
        const next = { ...model, ...change }

        return { ...next, capabilities: canonicalCapabilities(next.capabilities) }
      }),
    })
  }

  const setCapability = (key: string, capability: ModelCapability, checked: boolean) => {
    const model = draft.models.find((candidate) => candidate.key === key)

    if (!model) {
      return
    }
    changeModel(key, {
      capabilities: checked
        ? [...model.capabilities, capability]
        : model.capabilities.filter((candidate) => candidate !== capability),
    })
  }

  const removeModel = (key: string) => {
    setDraft({
      ...draft,
      models: draft.models.filter((model) => model.key !== key),
      defaultModelKey: key === draft.defaultModelKey ? null : draft.defaultModelKey,
    })
  }

  const toggleDefaultModel = (key: string) =>
    setDraft((current) => {
      const model = current.models.find((candidate) => candidate.key === key)

      if (!model?.name.length) {
        return current
      }

      return {
        ...current,
        defaultModelKey: current.defaultModelKey === key ? null : key,
      }
    })

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
            disabled={disabled}
            data-testid="provider-name"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          <span>Wire protocol</span>
          <Select<Wire>
            value={draft.wire}
            disabled={disabled}
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
            disabled={disabled}
            spellCheck={false}
            data-testid="provider-base-url"
            onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
          />
        </label>
        <div className={`${styles.field} ${styles.wide}`}>
          <span>Credential</span>
          <Select
            value={draft.credentialId}
            disabled={disabled}
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
              disabled={disabled || loadingMoreCredentials}
              data-testid="provider-credential-load-more"
              onClick={() => void onLoadMoreCredentials()}
            >
              {loadingMoreCredentials ? 'Loading…' : 'Load more credentials'}
            </Button>
          )}
        </div>
        <div className={`${styles.field} ${styles.wide}`}>
          <div className={styles.inline}>
            <strong>Models</strong>
            <Button
              type="button"
              disabled={disabled}
              data-testid="provider-model-add"
              onClick={addModel}
            >
              <IconPlus size={13} /> Add model
            </Button>
          </div>
          {draft.models.length === 0 ? (
            <p className={styles.hint}>
              No models configured. Add one when this resource is ready.
            </p>
          ) : (
            <div className={styles.modelList} data-testid="provider-models">
              {draft.models.map((model, index) => {
                const isDefault = draft.defaultModelKey === model.key

                return (
                  <div className={styles.modelRow} key={model.key} data-testid="provider-model-row">
                    <label className={styles.field}>
                      <span>Model {index + 1}</span>
                      <input
                        aria-label={`Model ${index + 1} name`}
                        value={model.name}
                        disabled={disabled}
                        spellCheck={false}
                        onChange={(event) => changeModel(model.key, { name: event.target.value })}
                      />
                    </label>
                    <div
                      className={styles.modelCapabilities}
                      role="group"
                      aria-label={`Model ${index + 1} capabilities`}
                    >
                      <Checkbox
                        checked={model.capabilities.includes(MODEL_CAPABILITY.completion)}
                        disabled={disabled}
                        label="Completion"
                        onChange={(checked) =>
                          setCapability(model.key, MODEL_CAPABILITY.completion, checked)
                        }
                      />
                      <Checkbox
                        checked={model.capabilities.includes(MODEL_CAPABILITY.embedding)}
                        disabled={disabled}
                        label="Embedding"
                        onChange={(checked) =>
                          setCapability(model.key, MODEL_CAPABILITY.embedding, checked)
                        }
                      />
                    </div>
                    <div className={styles.modelActions}>
                      <Button
                        icon
                        type="button"
                        variant="ghost"
                        active={isDefault}
                        disabled={disabled || model.name.length === 0}
                        aria-pressed={isDefault}
                        data-testid="provider-model-default"
                        title={
                          isDefault ? 'Clear default model' : `Use model ${index + 1} as default`
                        }
                        onClick={() => toggleDefaultModel(model.key)}
                      >
                        {isDefault ? <IconStarFilled size={14} /> : <IconStar size={14} />}
                      </Button>
                      <Button
                        icon
                        type="button"
                        variant="ghost"
                        disabled={disabled}
                        title={`Remove model ${index + 1}`}
                        onClick={() => removeModel(model.key)}
                      >
                        <IconTrash size={13} />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
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
            <div className={styles.field}>
              <span>Private network</span>
              <Switch
                checked={draft.allowPrivateNetwork}
                disabled={disabled}
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
                disabled={disabled}
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
                disabled={disabled}
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
                  disabled={disabled}
                  label={draft.disabled ? 'Disabled' : 'Enabled'}
                  onChange={(enabled) => setDraft({ ...draft, disabled: !enabled })}
                />
              </div>
            )}
          </div>
          <div className={styles.stack}>
            <div className={styles.inline}>
              <strong>Custom headers</strong>
              <Button type="button" disabled={disabled} onClick={addHeader}>
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
                      disabled={disabled || header.originalName != null}
                      onChange={(event) => changeHeader(header.key, { name: event.target.value })}
                    />
                  </label>
                  <label className={styles.field}>
                    <span>{header.originalName ? 'New value — value is set' : 'Value'}</span>
                    <input
                      type="password"
                      value={header.value}
                      disabled={disabled || header.remove}
                      autoComplete="new-password"
                      onChange={(event) => changeHeader(header.key, { value: event.target.value })}
                    />
                  </label>
                  <Checkbox
                    checked={header.remove}
                    disabled={disabled}
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
  const selectedId = useRef<string | null>(null)
  const selectedBaseline = useRef<ProviderResource | null>(null)
  const hydrateNextSelected = useRef(false)

  useEffect(() => {
    if (selected) {
      const sameResource = selectedId.current === selected.resource.id
      setDraft((current) => {
        const dirty =
          sameResource && selectedBaseline.current
            ? Object.keys(providerResourcePatchOf(selectedBaseline.current, current)).length > 0
            : false

        if (sameResource && dirty && !hydrateNextSelected.current) {
          return current
        }
        hydrateNextSelected.current = false
        return draftOf(selected.resource)
      })
      selectedId.current = selected.resource.id
      selectedBaseline.current = selected.resource
    } else {
      selectedId.current = null
      selectedBaseline.current = null
      hydrateNextSelected.current = false
    }
  }, [selected])
  useEffect(() => {
    if (!targetSpace && spaces[0]) {
      setTargetSpace(spaces[0].id)
    }
  }, [spaces, targetSpace])

  const selectedOwner = selected?.resource.owner.mine ?? false
  const authoredDirty = Boolean(
    selected && Object.keys(providerResourcePatchOf(selected.resource, draft)).length > 0,
  )
  const creatingDirty = !sameJson(comparableDraft(draft), comparableDraft(draftOf()))
  const draftError = modelDraftError(draft)
  const statuses = useMemo(
    () =>
      selected
        ? capabilityOrder
            .filter((capability) =>
              selected.resource.models.some((model) => model.capabilities.includes(capability)),
            )
            .map((capability) => ({
              capability,
              check: selected.resource.lastCheck[capability],
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
      hydrateNextSelected.current = true
      await onPatch(selected.resource.id, patch)
      setAdvancedOpen(false)
      setChecksOpen(false)
      setSharingOpen(false)
      setActionError(null)
    } catch (cause) {
      hydrateNextSelected.current = false
      setActionError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const confirmDiscard = (dirty: boolean) =>
    dirty
      ? confirm({
          title: 'Discard unsaved provider changes?',
          message: 'The authored model mapping and other unsaved fields will be lost.',
          confirmLabel: 'Discard',
          danger: true,
        })
      : Promise.resolve(true)

  const closeEdit = async () => {
    if (await confirmDiscard(authoredDirty)) {
      onClose()
    }
  }

  const cancelCreate = async () => {
    if (await confirmDiscard(creatingDirty)) {
      setCreating(false)
      setAdvancedOpen(false)
      setDraft(draftOf())
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
    setBusy(true)
    try {
      await onDelete(resource.id)
      setActionError(null)
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setBusy(false)
    }
  }

  const validate = async (capability: ModelCapability) => {
    if (!selected) {
      return
    }
    setBusy(true)
    try {
      const result = await onValidate(selected.resource.id, capability)
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
    const switching = creating || selected?.resource.id !== id
    const localDirty = creating ? creatingDirty : authoredDirty

    if (switching && !(await confirmDiscard(localDirty))) {
      return
    }
    setCreating(false)
    setAdvancedOpen(false)
    setChecksOpen(false)
    setSharingOpen(false)
    setMessage(null)
    setActionError(null)
    setBusy(true)
    try {
      await onSelect(id)
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setBusy(false)
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
              disabled={busy}
              advancedOpen={advancedOpen}
              onAdvancedToggle={setAdvancedOpen}
              credentialsNextCursor={credentialsNextCursor}
              loadingMoreCredentials={loadingMoreCredentials}
              credentialContinuationError={credentialContinuationError}
              onLoadMoreCredentials={onLoadMoreCredentials}
            />
            {actionError && <p className={styles.error}>{actionError}</p>}
            <div className={styles.actions}>
              <Button type="button" disabled={busy} onClick={() => void cancelCreate()}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={busy || draftError !== null}>
                Create
              </Button>
            </div>
            {draftError && <p className={styles.error}>{draftError}</p>}
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
              disabled={busy}
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
            {authoredDirty && (
              <Notice variant="warning">Save changes first to Validate or Share.</Notice>
            )}
            <div className={styles.actions}>
              <Button type="button" disabled={busy} onClick={() => void closeEdit()}>
                Close
              </Button>
              <Button type="submit" variant="primary" disabled={busy || draftError !== null}>
                Save
              </Button>
            </div>
            {draftError && <p className={styles.error}>{draftError}</p>}
            <DisclosureCard
              header={
                <>
                  <strong className={styles.disclosureTitle}>Connection checks</strong>
                  <span className={styles.disclosureSummary}>
                    {statuses.length
                      ? statuses
                          .map(
                            ({ capability, check }) =>
                              `${capability} ${check?.status ?? PROVIDER_STATUS.unverified}`,
                          )
                          .join(' · ')
                      : 'No configured capabilities'}
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
                  {statuses.map(({ capability, check }) => (
                    <div className={styles.statusRow} key={capability}>
                      <strong>{capability}</strong>
                      <span>
                        {check?.status ?? PROVIDER_STATUS.unverified}
                        {check?.diagnostic ? ` — ${check.diagnostic}` : ''}
                        {draft.wire === WIRE.ollama &&
                        check?.status === PROVIDER_STATUS.ready &&
                        !check.credentialProven
                          ? ' — reachability checked; credentials were not verified'
                          : ''}
                      </span>
                      <Button
                        type="button"
                        disabled={busy || authoredDirty}
                        title={authoredDirty ? 'Save changes first' : undefined}
                        onClick={() => void validate(capability)}
                      >
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
                      disabled={busy}
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
                      disabled={busy || !targetSpace || authoredDirty}
                      title={authoredDirty ? 'Save changes first' : undefined}
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
          <div className={styles.tableScroll}>
            <table className={styles.table} data-testid="provider-list">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Wire</th>
                  <th>Capabilities</th>
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
                              : 'no credential'}{' '}
                            · {resource.addressIsPrivate ? 'private network' : 'external service'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={styles.badge}>{resource.wire}</span>
                    </td>
                    <td>{resource.capabilities.join(', ') || 'none'}</td>
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
                          disabled={busy || selectingId === resource.id}
                          aria-busy={selectingId === resource.id}
                          title={`Edit ${resource.name}`}
                          onClick={() => {
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
                          disabled={busy}
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
          </div>
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
