use notarium_core::{
    DomainError,
    auth::EngineAuthContext,
    error::PortError,
    ids::{ContentDigest, RequestId},
    model::HistoryScope,
    ports::{SpaceContext, StagedChatBlob},
};

use crate::{
    CanonicalStore,
    blobs::{RetirementHandoff, RetirementReason},
    codec::internal_not_committed,
    domain::common::CommandDeadline,
    runtime::{SpaceRecord, load_space_record, load_space_record_for_update_opt},
    sql_exec::BackendConn,
};

pub(super) fn request_key(auth: &EngineAuthContext, request: &RequestId) -> String {
    format!("{}:{}", auth.grant().as_str(), request.as_str())
}

impl CanonicalStore {
    /// Finds the next outstanding grant from one staging request, even when the
    /// process lost the reply. Use the last returned lease as the exclusive cursor.
    pub async fn next_staged_chat_blob(
        &self,
        ctx: SpaceContext,
        original: RequestId,
        digest: ContentDigest,
        after: Option<[u8; 16]>,
    ) -> Result<Option<StagedChatBlob>, PortError> {
        let deadline = CommandDeadline::start(&ctx.budget, "recover_chat_stage");
        let budget = ctx.budget.clone();
        let provenance = ctx.auth().taint().clone();
        let tainted = provenance.is_tainted();
        let found = deadline
            .prepare(&budget, || {
                self.with_read_tx_budget(Some(&budget), |tx| {
                    Box::pin(next_lease_tx(tx, ctx, original, digest, after, tainted))
                })
            })
            .await?;
        // Sibling contexts can acquire external provenance while SQL is pending.
        if provenance.is_tainted() != tainted {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        Ok(found)
    }

    /// Relinquishes one exact outstanding lease. Repeating a release is safe.
    pub async fn discard_staged_chat_blob(
        &self,
        ctx: SpaceContext,
        staged: StagedChatBlob,
    ) -> Result<(), PortError> {
        let deadline = CommandDeadline::start(&ctx.budget, "discard_chat_stage");
        if staged.lease().is_none()
            || staged.space() != &ctx.scope().space_id
            || staged.owner() != ctx.auth().principal()
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        let budget = ctx.budget.clone();
        let store = self.clone();
        let result = self
            .with_auxiliary_command(
                ctx.scope().space_id.clone(),
                Some((&budget, deadline)),
                |handoff| {
                    drop(handoff);
                    Ok(())
                },
                move |tx| {
                    Box::pin(async move {
                        let space = load_space_record_for_update_opt(tx, &ctx.scope().space_id)
                            .await?
                            .ok_or(DomainError::ResourceNotFound)?;
                        space.scope.check(ctx.scope())?;
                        super::authorize_chat_write_on_space(ctx.auth(), &space.space)?;
                        store
                            .inner
                            .check_writer_epoch(&space.scope.space_id, space.active_epoch)?;
                        let key = match super::lookup_staged_chat_lease_tx(
                            tx,
                            &space.scope.space_id,
                            &staged,
                        )
                        .await
                        {
                            Ok(key) => key,
                            Err(PortError::Domain(DomainError::ResourceNotFound)) => {
                                return Ok(None);
                            }
                            Err(error) => return Err(error),
                        };
                        release_tx(&store, tx, &space, &staged, &key).await
                    })
                },
            )
            .await;
        result.map_err(|err| crate::codec::retry_unknown_commit("discard_chat_stage", err))
    }
}

async fn next_lease_tx(
    tx: &mut BackendConn<'_>,
    ctx: SpaceContext,
    original: RequestId,
    digest: ContentDigest,
    after: Option<[u8; 16]>,
    tainted: bool,
) -> Result<Option<StagedChatBlob>, PortError> {
    let space = load_space_record(tx, &ctx.scope().space_id).await?;
    space.scope.check(ctx.scope())?;
    super::authorize_chat_write_on_space(ctx.auth(), &space.space)?;
    let prefix = if tainted { "st2t_" } else { "st2c_" };
    let start = after
        .map(|v| super::staged_chat_lease_key(v, tainted))
        .unwrap_or_else(|| prefix.into());
    let end = format!("{prefix}~");
    let key = request_key(ctx.auth(), &original);
    // The cursor is an opaque hexadecimal ID. Its bounds and ordering must
    // use the same byte ordering in every database locale.
    macro_rules! outstanding {
        ($conn:expr, $collation:literal) => {
            sqlx::query_as::<_, (String, i64)>(concat!(
                "SELECT lease_key, raw_size FROM (
                   SELECT r.owner_rev_id COLLATE ", $collation, " AS lease_key, c.raw_size
                   FROM blob_references r JOIN blob_catalog c
                     ON c.space_id=r.space_id AND c.content_blake3=r.content_blake3
                   WHERE r.space_id=$1 AND r.owner_kind='staged_chat' AND r.owner_id=$2
                     AND r.resource_key=$3 AND r.content_blake3=$4
                     AND c.blob_state='active' AND c.admission_state='open'
                 ) AS grants WHERE lease_key>$5 AND lease_key<$6 ORDER BY lease_key LIMIT 1"
            ))
                .bind(space.scope.space_id.as_str())
                .bind(ctx.auth().principal().as_str())
                .bind(&key)
                .bind(digest.as_bytes().as_slice())
                .bind(&start)
                .bind(&end)
                .fetch_optional(&mut **$conn)
                .await
        };
    }
    let row = match tx {
        BackendConn::Sqlite(c) => outstanding!(c, "BINARY"),
        BackendConn::Postgres(c) => outstanding!(c, r#""C""#),
    }
    .map_err(|err| internal_not_committed("recover_chat_stage", err.to_string()))?;
    let Some((key, bytes)) = row else {
        return Ok(None);
    };
    let lease = key
        .strip_prefix(prefix)
        .filter(|s| s.len() == 32)
        .and_then(|s| u128::from_str_radix(s, 16).ok())
        .ok_or_else(|| internal_not_committed("corrupt_chat_stage", "invalid lease key"))?;
    let bytes = u64::try_from(bytes)
        .map_err(|e| internal_not_committed("corrupt_chat_stage", e.to_string()))?;
    Ok(Some(
        StagedChatBlob::attest_canonical(
            space.scope.space_id,
            ctx.auth().principal().clone(),
            digest,
            bytes,
        )?
        .with_lease(lease.to_be_bytes()),
    ))
}

async fn release_tx(
    store: &CanonicalStore,
    tx: &mut BackendConn<'_>,
    space: &SpaceRecord,
    staged: &StagedChatBlob,
    key: &str,
) -> Result<Option<RetirementHandoff>, PortError> {
    let Some(count) =
        super::remove_staging_lease_tx(tx, &space.scope.space_id, staged, key).await?
    else {
        return Ok(None);
    };
    if count > 0 {
        return Ok(None);
    }
    let retirement = crate::blobs::initiate_digest_retirement_tx(
        tx,
        &space.scope,
        space.active_epoch,
        staged.digest(),
        RetirementReason::Gc,
        None,
        None,
    )
    .await?;
    Ok(retirement
        .map(|id| store.retirement_handoff(&space.scope, space.active_epoch, vec![id], None)))
}

/// A joined task may finish COMMIT after the public future leaves. Its result
/// owns this precise lease until the public future takes the capability.
pub(super) struct UndeliveredLease {
    store: CanonicalStore,
    scope: HistoryScope,
    staged: Option<StagedChatBlob>,
    owner_lease: String,
}

impl UndeliveredLease {
    pub(super) fn new(
        store: CanonicalStore,
        scope: HistoryScope,
        staged: StagedChatBlob,
        owner_lease: String,
    ) -> Self {
        Self {
            store,
            scope,
            staged: Some(staged),
            owner_lease,
        }
    }
    pub(super) fn deliver(mut self) -> StagedChatBlob {
        self.staged.take().expect("staged result delivered once")
    }
}

impl Drop for UndeliveredLease {
    fn drop(&mut self) {
        let Some(staged) = self.staged.take() else {
            return;
        };
        let store = self.store.clone();
        let scope = self.scope.clone();
        let lease = std::mem::take(&mut self.owner_lease);
        let task = self.store.inner.backup_executor.spawn(async move {
            let mut delay = std::time::Duration::from_millis(25);
            loop {
                let cleanup = store.with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
                    let scope = scope.clone();
                    let staged = staged.clone();
                    let lease = lease.clone();
                    let owner = store.clone();
                    Box::pin(async move {
                        let Some(space) =
                            load_space_record_for_update_opt(tx, &scope.space_id).await?
                        else {
                            return Ok(None);
                        };
                        if space.scope != scope
                            || owner
                                .inner
                                .check_writer_epoch(&scope.space_id, space.active_epoch)
                                .is_err()
                        {
                            // A new owner can resolve the same durable request/lease.
                            return Ok(None);
                        }
                        release_tx(&owner, tx, &space, &staged, &lease).await
                    })
                });
                let result = tokio::select! {
                    biased;
                    result = cleanup => result,
                    () = store.inner.backup_shutdown.cancelled() => return,
                };
                match result {
                    Ok(handoff) => {
                        drop(handoff);
                        return;
                    }
                    Err(error) => tracing::warn!(?error, "retrying undelivered chat lease cleanup"),
                }
                tokio::select! {
                    ()=store.inner.backup_shutdown.cancelled()=>return,
                    ()=tokio::time::sleep(delay)=>{},
                }
                delay = (delay * 2).min(std::time::Duration::from_secs(2));
            }
        });
        crate::backup::register_cleanup_task(&self.store.inner, task);
    }
}
