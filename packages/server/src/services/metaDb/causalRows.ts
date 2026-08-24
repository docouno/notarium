import type {
  BackupGenerationFreezeRecord,
  CausalOutboxRecord,
  InstallationGenerationRecord,
  OwnerProofBindingRecord,
  RestoreOperationRecord,
  SpaceLifecycleRecord,
} from '@notarium/core'
import type { AbilityCreateOperationRecord } from './types'

export type AbilityCreateOperationRow = {
  id: string
  actor_digest: string
  idempotency_digest: string | null
  request_fingerprint: string
  space: string
  package_id: string
  note_id: string
  target_path: string
  availability_required: number | boolean
  stage_binding: string
  phase: string
  prepared_evidence: string
  physical_receipt: string | null
  terminal_result: string | null
  failure_code: string | null
  created_at: string
  updated_at: string
}

export const abilityCreateOperationOfRow = (
  row: AbilityCreateOperationRow,
): AbilityCreateOperationRecord => ({
  id: row.id,
  actorDigest: row.actor_digest,
  idempotencyDigest: row.idempotency_digest,
  requestFingerprint: row.request_fingerprint,
  space: row.space,
  packageId: row.package_id,
  noteId: row.note_id,
  targetPath: row.target_path,
  availabilityRequired: Boolean(row.availability_required),
  stageBinding: row.stage_binding,
  phase: row.phase as AbilityCreateOperationRecord['phase'],
  preparedEvidence: row.prepared_evidence,
  physicalReceipt: row.physical_receipt,
  terminalResult: row.terminal_result,
  failureCode: row.failure_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export type RestoreOperationRow = {
  id: string
  space: string
  note_id: string
  endpoint: string
  actor_digest: string
  idempotency_digest: string
  request_fingerprint: string
  stage_binding: string
  phase: string
  source_revision_id: string | null
  expected_head_revision_id: string | null
  target_path: string | null
  prepared_evidence: string | null
  physical_receipt: string | null
  terminal_result: string | null
  failure_code: string | null
  created_at: string
  updated_at: string
}

export const restoreOperationOfRow = (row: RestoreOperationRow): RestoreOperationRecord => ({
  id: row.id,
  space: row.space,
  noteId: row.note_id,
  endpoint: row.endpoint,
  actorDigest: row.actor_digest,
  idempotencyDigest: row.idempotency_digest,
  requestFingerprint: row.request_fingerprint,
  stageBinding: row.stage_binding,
  phase: row.phase as RestoreOperationRecord['phase'],
  sourceRevisionId: row.source_revision_id,
  expectedHeadRevisionId: row.expected_head_revision_id,
  targetPath: row.target_path,
  preparedEvidence: row.prepared_evidence,
  physicalReceipt: row.physical_receipt,
  terminalResult: row.terminal_result,
  failureCode: row.failure_code,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export type SpaceLifecycleRow = {
  space: string
  phase: string
  generation: number | bigint | string
  cleanup_manifest: string | null
  changed_at: string
  changed_by: string | null
}

export const spaceLifecycleOfRow = (row: SpaceLifecycleRow): SpaceLifecycleRecord => ({
  space: row.space,
  phase: row.phase as SpaceLifecycleRecord['phase'],
  generation: Number(row.generation),
  cleanupManifest: row.cleanup_manifest,
  changedAt: row.changed_at,
  changedBy: row.changed_by,
})

export type CausalOutboxRow = {
  id: number | bigint | string
  space: string
  generation: number | bigint | string
  kind: string
  operation_id: string | null
  resource_id: string
  created_at: string
  acknowledged_at: string | null
}

export const causalOutboxOfRow = (row: CausalOutboxRow): CausalOutboxRecord => ({
  id: String(row.id),
  space: row.space,
  generation: Number(row.generation),
  kind: row.kind,
  operationId: row.operation_id,
  resourceId: row.resource_id,
  createdAt: row.created_at,
  acknowledgedAt: row.acknowledged_at,
})

export type InstallationGenerationRow = {
  generation: number | bigint | string
  phase: string
  active_key_id: string | null
  active_hash: string | null
  candidate_key_id: string | null
  candidate_hash: string | null
  changed_at: string
}

export const installationGenerationOfRow = (
  row: InstallationGenerationRow,
): InstallationGenerationRecord => ({
  generation: Number(row.generation),
  phase: row.phase as InstallationGenerationRecord['phase'],
  activeKeyId: row.active_key_id,
  activeHash: row.active_hash,
  candidateKeyId: row.candidate_key_id,
  candidateHash: row.candidate_hash,
  changedAt: row.changed_at,
})

export const sameInstallationGeneration = (
  left: InstallationGenerationRecord | null,
  right: InstallationGenerationRecord | null,
): boolean =>
  left?.generation === right?.generation &&
  left?.phase === right?.phase &&
  left?.activeKeyId === right?.activeKeyId &&
  left?.activeHash === right?.activeHash &&
  left?.candidateKeyId === right?.candidateKeyId &&
  left?.candidateHash === right?.candidateHash &&
  left?.changedAt === right?.changedAt

export type BackupGenerationFreezeRow = {
  owner: string
  generation: number | bigint | string
  key_id: string
  active_hash: string
  candidate_key_id: string | null
  candidate_hash: string | null
  acquired_at: string
  heartbeat_at: string
  expires_at: string
}

export const backupGenerationFreezeOfRow = (
  row: BackupGenerationFreezeRow,
): BackupGenerationFreezeRecord => ({
  owner: row.owner,
  generation: Number(row.generation),
  keyId: row.key_id,
  activeHash: row.active_hash,
  candidateKeyId: row.candidate_key_id,
  candidateHash: row.candidate_hash,
  acquiredAt: row.acquired_at,
  heartbeatAt: row.heartbeat_at,
  expiresAt: row.expires_at,
})

export type OwnerProofRow = {
  note_id: string
  space: string
  address_revision: number | bigint | string
  proof_revision: number | bigint | string
  source_hash: string
  proof_json: string
  receipt_id: string
  updated_at: string
}

export const ownerProofOfRow = (row: OwnerProofRow): OwnerProofBindingRecord => ({
  noteId: row.note_id,
  space: row.space,
  addressRevision: Number(row.address_revision),
  proofRevision: Number(row.proof_revision),
  sourceHash: row.source_hash,
  proofJson: row.proof_json,
  receiptId: row.receipt_id,
  updatedAt: row.updated_at,
})
