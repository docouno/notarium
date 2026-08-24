DROP INDEX idx_ability_create_operations_replay;

CREATE UNIQUE INDEX idx_ability_create_operations_replay
  ON ability_create_operations(actor_digest, idempotency_digest)
  WHERE idempotency_digest IS NOT NULL AND phase <> 'rejected';
