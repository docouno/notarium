import {
  AUTH_MODE,
  type AuthMode,
  type ModelCapability,
  PROVIDER_STATUS,
  type ProviderLastCheck,
  type ProviderStatus,
} from '@notarium/contract'

/** Statuses derived from what the ADDRESS answered. Everything else in the
 *  dictionary is a local fact of the configuration — the owner disabled the
 *  record, the secret will not decrypt — and says nothing about the address, so
 *  coarsening it would only make the interface dumber without closing an oracle. */
const ADDRESS_DERIVED: ReadonlySet<ProviderStatus> = new Set<ProviderStatus>([
  PROVIDER_STATUS.credentialRejected,
  PROVIDER_STATUS.quotaExhausted,
  PROVIDER_STATUS.providerRateLimited,
  PROVIDER_STATUS.parametersRejected,
  PROVIDER_STATUS.policyDenied,
  PROVIDER_STATUS.unreachable,
])

export type ProviderDisclosureContext = {
  authMode: AuthMode
  /** Exact addressee/status reach. Includes a Space consent manager. */
  canReadAddress: boolean
  /** Provider prose about the owner's account. Owner/host-admin only. */
  canReadDiagnostic: boolean
  addressIsPrivate: boolean
}

/** Whether the ADDRESS-derived outcomes additionally collapse into one word. That is
 *  a narrower question than "may this viewer read the detail": it protects the STATE
 *  of a private address, and on the intersection with `policy-denied` it wins, because
 *  telling those apart is a sharper DNS oracle than timing. canon: #387 design/10 */
export const coarsensProviderDisclosure = (context: ProviderDisclosureContext): boolean =>
  context.authMode === AUTH_MODE.password && !context.canReadAddress && context.addressIsPrivate

const collapsed = (check: ProviderLastCheck): ProviderLastCheck =>
  ADDRESS_DERIVED.has(check.status)
    ? { ...check, status: PROVIDER_STATUS.unreachable, diagnostic: null }
    : check

const withoutDiagnostic = (check: ProviderLastCheck): ProviderLastCheck =>
  check.diagnostic === null ? check : { ...check, diagnostic: null }

/** Projection is applied on READ and depends on who is looking. Producing the outcome
 *  projected would be too late: `lastCheck` is persisted and handed to everyone who
 *  sees the resource, so the verbatim text would already be in the meta-DB.
 *
 *  Two rules, and they answer different questions. The free text is the PROVIDER's
 *  prose about the OWNER's account — remaining credit, the requesting organization —
 *  so only the owner and a host admin read it, whatever the address. The collapse of
 *  address-derived statuses is about a private address's state and applies on top.
 *  canon: #387 design/10 · design/11 */
export const projectProviderLastCheck = (
  lastCheck: Partial<Record<ModelCapability, ProviderLastCheck>>,
  context: ProviderDisclosureContext,
): Partial<Record<ModelCapability, ProviderLastCheck>> => {
  if (context.canReadDiagnostic) {
    return { ...lastCheck }
  }
  const collapse = coarsensProviderDisclosure(context)

  return Object.fromEntries(
    Object.entries(lastCheck).map(([capability, check]) => [
      capability,
      withoutDiagnostic(collapse ? collapsed(check) : check),
    ]),
  )
}
