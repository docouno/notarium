import type { KnowledgeStore } from '../../knowledgeStore'

/** Whether the inner store can consume the reserved stable-id envelope exactly.
 *  An identity-owning engine does so natively; a path-keyed engine that accepts
 *  `setLinkIdentities` does so through the read-model's authoritative registry. */
export const supportsExactIdentityAddress = (store: KnowledgeStore): boolean =>
  store.capabilities.identity || store.setLinkIdentities !== undefined
