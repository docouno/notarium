const CLAIM_COMMAND: &str =
    "INSERT INTO account_catalog_receipts (owner_id,actor_id,command_key,request_hash)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT DO NOTHING
    RETURNING command_key";
const READ_RECEIPT: &str = "SELECT request_hash,result_msgpack
    FROM account_catalog_receipts
    WHERE owner_id=$1 AND actor_id=$2 AND command_key=$3";
const SET_SPACE_SETTINGS: &str = "UPDATE spaces
    SET settings_json=$1
    WHERE space_id=$2
    RETURNING space_id";
const SET_LIFECYCLE: &str = "UPDATE spaces
    SET lifecycle_state=$1
    WHERE space_id=$2
    RETURNING space_id";
const CONFIRM_RECEIPT: &str = "UPDATE account_catalog_receipts
    SET result_msgpack=$1
    WHERE owner_id=$2 AND actor_id=$3 AND command_key=$4
    RETURNING command_key";

use super::*;
use crate::{
    CreateSpaceSpec,
    codec::{csprng_16, decode_msgpack_bounded, encode_msgpack, unknown_commit_outcome},
    runtime::{create_space_tx, load_space_record_for_update_opt},
};
use std::time::Instant;

// Each command claims its account-scoped key inside the same transaction as
// the effect. Concurrent PostgreSQL requests wait on the unique index.
enum Command {
    Provision {
        owner: PrincipalId,
        space: CreateSpace,
    },
    Lifecycle {
        scope: HistoryScope,
        lifecycle: SpaceLifecycle,
    },
}

impl Command {
    fn fingerprint(&self, id: &AccountCommandIdentity) -> Result<Vec<u8>, PortError> {
        let bytes = match self {
            Self::Provision { owner, space } => encode_msgpack(&(
                "provision-v1",
                &id.hash,
                id.expected,
                owner,
                &space.id,
                space.kind,
                &space.name,
            ))?,
            Self::Lifecycle { scope, lifecycle } => {
                encode_msgpack(&("lifecycle-v1", &id.hash, id.expected, scope, lifecycle))?
            }
        };
        Ok(blake3::hash(&bytes).as_bytes().to_vec())
    }
}

fn check_budget(budget: &CallBudget, started: Instant) -> Result<(), PortError> {
    if budget.cancellation.is_cancelled() {
        return Err(crate::codec::cancelled_not_committed(
            "catalog_write_cancelled",
            "catalog request cancelled",
        ));
    }
    if started.elapsed() >= budget.remaining {
        return Err(crate::codec::deadline_not_committed(
            "catalog_write_deadline",
            "catalog request expired",
        ));
    }
    Ok(())
}

async fn execute(
    store: &CanonicalStore,
    budget: CallBudget,
    id: AccountCommandIdentity,
    command: Command,
) -> Result<CatalogSpace, PortError> {
    let started = Instant::now();
    check_budget(&budget, started)?;
    let hash = command.fingerprint(&id)?;
    let inner = store.inner.clone();
    let owned = store.clone();
    let work_budget = budget.clone();
    // A lost response can race COMMIT. Keep ownership through the initial writer
    // grant; replaying a receipt must never reissue a lease after takeover.
    let work = tokio::spawn(async move {
        let (result, grant) = owned
            .with_write_tx(move |tx| {
                Box::pin(async move {
                    check_budget(&work_budget, started)?;
                    if let BackendConn::Postgres(conn) = tx {
                        let remaining = work_budget.remaining.saturating_sub(started.elapsed());
                        let millis = remaining.as_millis().clamp(1, i32::MAX as u128);
                        sqlx::query("SELECT set_config('statement_timeout', $1, true)")
                            .bind(format!("{millis}ms"))
                            .execute(&mut **conn)
                            .await
                            .map_err(|e| {
                                internal_not_committed("catalog_statement_timeout", e.to_string())
                            })?;
                    }

                    let inserted: Option<String> = db!(
                        tx,
                        sqlx::query_scalar(CLAIM_COMMAND),
                        fetch_optional,
                        id.owner.as_str(),
                        id.actor.as_str(),
                        id.key.as_str(),
                        &hash
                    )?;
                    if inserted.is_none() {
                        let (old, bytes): (Vec<u8>, Vec<u8>) = db!(
                            tx,
                            sqlx::query_as(READ_RECEIPT),
                            fetch_one,
                            id.owner.as_str(),
                            id.actor.as_str(),
                            id.key.as_str()
                        )?;
                        if old != hash {
                            return Err(DomainError::IdempotencyKeyReused.into());
                        }
                        let (space, history, last_seq): (Space, HistoryScope, SpaceSeq) =
                            decode_msgpack_bounded(&bytes, 4096)?;
                        let current = load_space_record(tx, &space.id).await?;
                        current.scope.check(&history)?;
                        return Ok((
                            CatalogSpace {
                                space,
                                history,
                                last_seq,
                            },
                            None,
                        ));
                    }
                    let (record, grant) = match command {
                        Command::Provision { space, owner } => {
                            let spec = CreateSpaceSpec {
                                slug: space.id.to_string(),
                                space_id: space.id.clone(),
                                incarnation: HistoryIncarnation::from_bytes(csprng_16()?),
                                root_folder_id: FolderId::from_bytes(csprng_16()?),
                                kind: space.kind,
                                owner,
                                active_epoch: LeaseEpoch::new(1)?,
                                initial_last_seq: SpaceSeq::ZERO,
                                created_at: None,
                            };
                            let rec = create_space_tx(tx, spec).await?;
                            let settings = serde_json::json!({"name":space.name}).to_string();
                            let _: String = db!(
                                tx,
                                sqlx::query_scalar(SET_SPACE_SETTINGS),
                                fetch_one,
                                settings,
                                space.id.as_str()
                            )?;
                            let grant = Some((rec.space.id.clone(), rec.active_epoch));
                            (rec, grant)
                        }
                        Command::Lifecycle { scope, lifecycle } => {
                            let mut rec = load_space_record_for_update_opt(tx, &scope.space_id)
                                .await?
                                .ok_or(DomainError::ResourceNotFound)?;
                            rec.scope.check(&scope)?;
                            inner.check_writer_epoch(&scope.space_id, rec.active_epoch)?;
                            if rec.space.kind == SpaceKind::Personal
                                && lifecycle != SpaceLifecycle::Active
                            {
                                return Err(DomainError::AccessDenied.into());
                            }
                            let state = match lifecycle {
                                SpaceLifecycle::Active => "active",
                                SpaceLifecycle::Archived => "archived",
                                SpaceLifecycle::Closing => {
                                    return Err(DomainError::validation(
                                        ValidationReason::InvalidState,
                                    )
                                    .into());
                                }
                            };
                            let _: String = db!(
                                tx,
                                sqlx::query_scalar(SET_LIFECYCLE),
                                fetch_one,
                                state,
                                scope.space_id.as_str()
                            )?;
                            rec.space.lifecycle = lifecycle;
                            (rec, None)
                        }
                    };
                    let bytes = encode_msgpack(&(&record.space, &record.scope, record.last_seq))?;
                    let _: String = db!(
                        tx,
                        sqlx::query_scalar(CONFIRM_RECEIPT),
                        fetch_one,
                        &bytes,
                        id.owner.as_str(),
                        id.actor.as_str(),
                        id.key.as_str()
                    )?;
                    Ok((catalog_space(record), grant))
                })
            })
            .await?;
        if let Some((space, epoch)) = grant {
            owned.inner.grant_writer_epoch(&space, epoch);
        }
        Ok(result)
    });
    let remaining = budget.remaining.saturating_sub(started.elapsed());
    tokio::select! {
        result = work => result.map_err(|err| unknown_commit_outcome("catalog_worker", err.to_string()))?,
        _ = budget.cancellation.cancelled() => {
            Err(unknown_commit_outcome("catalog_cancelled", "catalog worker accepted the operation"))
        }
        _ = tokio::time::sleep(remaining) => {
            Err(unknown_commit_outcome("catalog_deadline", "catalog worker accepted the operation"))
        }
    }
}

pub(super) async fn ensure(
    store: &CanonicalStore,
    budget: CallBudget,
    r: EnsureCatalogSpace,
) -> Result<CatalogSpace, PortError> {
    if r.space.name.is_empty() || r.space.name.len() > 256 || r.space.name.contains('\0') {
        return Err(DomainError::validation(ValidationReason::InvalidQuery).into());
    }
    if r.owner != r.identity.owner {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    execute(
        store,
        budget,
        r.identity,
        Command::Provision {
            owner: r.owner,
            space: r.space,
        },
    )
    .await
}
pub(super) async fn lifecycle(
    store: &CanonicalStore,
    budget: CallBudget,
    id: AccountCommandIdentity,
    scope: HistoryScope,
    lifecycle: SpaceLifecycle,
) -> Result<CatalogSpace, PortError> {
    execute(store, budget, id, Command::Lifecycle { scope, lifecycle }).await
}
