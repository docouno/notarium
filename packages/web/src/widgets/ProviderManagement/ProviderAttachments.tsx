import { Fragment, useEffect, useRef, useState } from 'react'
import type { ProviderDisclosureSnapshot } from '@notarium/contract'
import { ATTACHMENT_STATE } from '@notarium/contract/enums'
import { Button } from '../../core/Button'
import { useDialog } from '../../core/Dialog'
import { EmptyState } from '../../core/EmptyState'
import { IconCheck, IconLink, IconTrash } from '../../core/Icons'
import { Notice } from '../../core/Notice'
import { SettingsSection } from '../../core/SettingsSection'
import { authorLabel } from '../../libs/author'
import { errorText } from '../../libs/errors'
import type { ProviderAttachmentsProps } from './types'
import styles from './ProviderManagement.module.scss'

const DISPLAY_LIMIT = 120

/** Provider discovery names are hostile durable input. React escapes markup, but
 *  the consent sentence also needs bounded, single-line labels so an addressee
 *  cannot visually impersonate the surrounding UI or drown the actual recipient. */
export const providerDisclosureLabel = (value: string): string => {
  /* eslint-disable no-control-regex -- provider labels are hostile wire text */
  const clean = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  /* eslint-enable no-control-regex */

  return clean.length > DISPLAY_LIMIT ? `${clean.slice(0, DISPLAY_LIMIT - 1)}…` : clean
}

const listText = (values: string[]): string =>
  values.length ? values.map(providerDisclosureLabel).join(', ') : 'none'

const disclosureRows = (snapshot: ProviderDisclosureSnapshot) =>
  [
    ['Recipient', snapshot.baseUrl],
    ['Resource owner', snapshot.resourceOwner],
    ['What may leave', 'note content, agent memory, owner profile, role prompts'],
    ['Purposes', listText(snapshot.purposes)],
    ['Models', listText(snapshot.models.map((model) => model.name))],
    ['Header names', listText(snapshot.headerNames)],
    ['Private network opt-in', snapshot.allowPrivateNetwork ? 'yes' : 'no'],
  ] as const

const diffValue = (snapshot: ProviderDisclosureSnapshot, key: string): string => {
  switch (key) {
    case 'baseUrl':
      return snapshot.baseUrl
    case 'purposes':
      return listText(snapshot.purposes)
    case 'models':
      return listText(snapshot.models.map((model) => model.name))
    case 'headerNames':
      return listText(snapshot.headerNames)
    case 'allowPrivateNetwork':
      return snapshot.allowPrivateNetwork ? 'yes' : 'no'
    default:
      return ''
  }
}

const DIFF_FIELDS = [
  ['Recipient', 'baseUrl'],
  ['Purposes', 'purposes'],
  ['Models', 'models'],
  ['Header names', 'headerNames'],
  ['Private network opt-in', 'allowPrivateNetwork'],
] as const

export const ProviderAttachments = ({
  items,
  total,
  nextCursor,
  loading,
  loadingMore,
  error,
  continuationError,
  detailError,
  selectingId,
  selected,
  onSelect,
  onClose,
  onLoadMore,
  onAccept,
  onDetach,
}: ProviderAttachmentsProps) => {
  const { confirm } = useDialog()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const selectedReviewButton = useRef<HTMLButtonElement | null>(null)

  const accept = async (view: NonNullable<ProviderAttachmentsProps['selected']>) => {
    setBusyId(view.attachment.id)
    try {
      const outcome = await onAccept(view)
      setMessage(
        outcome === 'refreshed'
          ? 'The resource changed while this screen was open. Review the refreshed disclosure and accept again.'
          : outcome === 'already-active'
            ? 'This attachment was already accepted.'
            : 'Attachment accepted.',
      )
      setActionError(null)
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setBusyId(null)
    }
  }

  const detach = async (id: string, name: string) => {
    const ok = await confirm({
      title: `Detach “${name}”?`,
      message: 'Members of this Space will lose this model resource immediately.',
      confirmLabel: 'Detach',
      danger: true,
    })

    if (!ok) {
      return
    }
    setBusyId(id)
    try {
      await onDetach(id)
      setMessage('Attachment detached.')
      setActionError(null)
    } catch (cause) {
      setActionError(errorText(cause))
    } finally {
      setBusyId(null)
    }
  }

  const closeDetail = () => {
    const trigger = selectedReviewButton.current
    onClose()
    queueMicrotask(() => trigger?.focus())
  }

  return (
    <SettingsSection
      title="Model provider consent"
      description="Review the exact recipient and inventory before this Space may use another member’s resource."
      testId="provider-attachments"
    >
      <div className={styles.stack}>
        {error && <Notice variant="error">{error}</Notice>}
        {continuationError && <Notice variant="error">{continuationError}</Notice>}
        {detailError && <Notice variant="error">{detailError}</Notice>}
        {actionError && <Notice variant="error">{actionError}</Notice>}
        {message && <Notice>{message}</Notice>}
        {loading && items == null && <p className={styles.empty}>Loading attachment offers…</p>}
        {items && items.length === 0 && (
          <EmptyState
            icon={<IconLink size={22} />}
            title="No provider offers"
            hint="A resource owner who belongs to this Space can offer one from Settings → Model providers."
          />
        )}
        {items?.map(({ attachment, resource }) => {
          const open = selected?.attachment.id === attachment.id
          const detailId = `provider-attachment-detail-${attachment.id}`

          return (
            <Fragment key={attachment.id}>
              <article className={styles.card} data-testid="provider-attachment">
                <div className={styles.cardHead}>
                  <div>
                    <span className={styles.name}>{resource.name}</span>
                    <span className={styles.meta}>Owned by {authorLabel(resource.owner).text}</span>
                  </div>
                  <span className={styles.badge}>{attachment.state}</span>
                </div>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="danger"
                    disabled={busyId === attachment.id}
                    onClick={() => void detach(attachment.id, resource.name)}
                  >
                    <IconTrash size={13} /> Detach
                  </Button>
                  <Button
                    ref={open ? selectedReviewButton : undefined}
                    type="button"
                    data-testid="provider-attachment-review"
                    disabled={selectingId === attachment.id}
                    aria-expanded={open}
                    aria-controls={detailId}
                    onClick={() => void onSelect(attachment.id)}
                  >
                    {selectingId === attachment.id ? 'Loading…' : 'Review disclosure'}
                  </Button>
                </div>
              </article>
              {open && selected && (
                <AttachmentDetail
                  id={detailId}
                  view={selected}
                  busy={busyId === selected.attachment.id}
                  onAccept={accept}
                  onClose={closeDetail}
                />
              )}
            </Fragment>
          )
        })}
        {nextCursor && (
          <div className={styles.actions}>
            <Button
              type="button"
              disabled={loadingMore}
              data-testid="provider-attachment-load-more"
              onClick={() => void onLoadMore()}
            >
              {loadingMore ? 'Loading…' : `Load more (${items?.length ?? 0} of ${total})`}
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  )
}

const AttachmentDetail = ({
  id,
  view,
  busy,
  onAccept,
  onClose,
}: {
  id: string
  view: NonNullable<ProviderAttachmentsProps['selected']>
  busy: boolean
  onAccept: (view: NonNullable<ProviderAttachmentsProps['selected']>) => Promise<void>
  onClose: () => void
}) => {
  const detailRef = useRef<HTMLElement | null>(null)
  const { attachment, currentDisclosure, diff, resource } = view
  const headingId = `${id}-heading`
  const canAccept = attachment.state !== ATTACHMENT_STATE.active
  const changedFields = diff.before
    ? DIFF_FIELDS.filter(([, key]) => diffValue(diff.before!, key) !== diffValue(diff.after, key))
    : []

  useEffect(() => {
    const detail = detailRef.current

    if (detail) {
      detail.scrollIntoView({ block: 'nearest' })
      detail.focus({ preventScroll: true })
    }
  }, [attachment.id])

  return (
    <article
      ref={detailRef}
      id={id}
      className={styles.card}
      role="region"
      aria-live="polite"
      aria-labelledby={headingId}
      tabIndex={-1}
      data-testid="provider-attachment-detail"
    >
      <div className={styles.cardHead}>
        <div>
          <span className={styles.name} id={headingId}>
            {resource.name}
          </span>
          <span className={styles.meta}>Owned by {authorLabel(resource.owner).text}</span>
        </div>
        <span className={styles.badge}>{attachment.state}</span>
      </div>
      <dl className={styles.disclosureGrid} data-testid="provider-disclosure-current">
        {disclosureRows(currentDisclosure).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {attachment.state === ATTACHMENT_STATE.awaitingReconsent && !diff.changed && (
        <Notice variant="warning">
          The record changed, but the information disclosed here did not.
        </Notice>
      )}
      {diff.before && diff.changed && (
        <div data-testid="provider-disclosure-diff">
          <strong>What changed since the last consent</strong>
          <dl className={styles.diffGrid}>
            {changedFields.map(([label, key]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  <span className={styles.diffBefore}>{diffValue(diff.before!, key)}</span>
                  <span className={styles.diffArrow}>→</span>
                  <span>{diffValue(diff.after, key)}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className={styles.actions}>
        <Button type="button" disabled={busy} onClick={onClose}>
          Close
        </Button>
        {canAccept && (
          <Button
            type="button"
            variant="primary"
            data-testid="provider-attachment-accept"
            disabled={busy}
            onClick={() => void onAccept(view)}
          >
            <IconCheck size={13} />{' '}
            {attachment.state === ATTACHMENT_STATE.awaitingReconsent ? 'Accept changes' : 'Accept'}
          </Button>
        )}
      </div>
    </article>
  )
}
