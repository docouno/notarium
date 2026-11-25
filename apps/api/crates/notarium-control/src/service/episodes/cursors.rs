use super::*;
use notarium_core::{model::HistoryScope, receipt::AcknowledgedCursor};
use std::collections::BTreeMap;

#[derive(sqlx::FromRow)]
struct CursorRow {
    history_incarnation: Vec<u8>,
    acked_space_seq: i64,
}
#[derive(sqlx::FromRow)]
struct Count {
    count: i64,
}
#[derive(Serialize, Deserialize)]
struct SavedAck {
    scope: HistoryScope,
    seq: SpaceSeq,
}
impl ControlService {
    pub(super) async fn fork_acknowledgements(
        &self,
        tx: &mut Transaction,
        parent: &str,
        child: &EpisodeId,
    ) -> Result<(), PortError> {
        let count = rows!(tx,Count,fetch_one,"SELECT count(*) AS count FROM mcp_delta_session_cursors WHERE episode_id=$1","SELECT count(*) AS count FROM v1_control.mcp_delta_session_cursors WHERE episode_id=$1";parent)?.count;
        if count > 4096 {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        execute!(tx,"INSERT INTO mcp_delta_session_cursors(episode_id,space_id,history_incarnation,acked_space_seq,updated_at) SELECT $1,space_id,history_incarnation,acked_space_seq,updated_at FROM mcp_delta_session_cursors WHERE episode_id=$2",
            "INSERT INTO v1_control.mcp_delta_session_cursors(episode_id,space_id,history_incarnation,acked_space_seq,updated_at) SELECT $1,space_id,history_incarnation,acked_space_seq,updated_at FROM v1_control.mcp_delta_session_cursors WHERE episode_id=$2";child.as_str(),parent)?;
        Ok(())
    }
    pub(in super::super) async fn acknowledgement_rows(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        episode: Option<&EpisodeId>,
    ) -> Result<Vec<(SpaceId, Vec<u8>, i64)>, PortError> {
        #[derive(sqlx::FromRow)]
        struct ScopedCursorRow {
            space_id: String,
            history_incarnation: Vec<u8>,
            acked_space_seq: i64,
        }
        let fetched = match episode {
            Some(id) => rows!(
                tx,
                ScopedCursorRow,
                fetch_all,
                "SELECT space_id, history_incarnation, acked_space_seq FROM mcp_delta_session_cursors WHERE episode_id=$1 ORDER BY space_id",
                "SELECT space_id, history_incarnation, acked_space_seq FROM v1_control.mcp_delta_session_cursors WHERE episode_id=$1 ORDER BY space_id";
                id.as_str()
            )?,
            None => rows!(
                tx,
                ScopedCursorRow,
                fetch_all,
                "SELECT space_id, history_incarnation, acked_space_seq FROM mcp_delta_owner_cursors WHERE owner_id=$1 ORDER BY space_id",
                "SELECT space_id, history_incarnation, acked_space_seq FROM v1_control.mcp_delta_owner_cursors WHERE owner_id=$1 ORDER BY space_id";
                ctx.auth().principal().as_str()
            )?,
        };
        let mut rows_out = Vec::with_capacity(fetched.len());
        for row in fetched {
            let space = SpaceId::parse(&row.space_id)?;
            if ctx
                .auth()
                .spaces()
                .get(&space)
                .is_some_and(|grant| !grant.read_classes.is_empty())
            {
                rows_out.push((space, row.history_incarnation, row.acked_space_seq));
            }
        }
        Ok(rows_out)
    }
    pub(in super::super) async fn resolve_acknowledgements_cached(
        &self,
        ctx: &AccountContext,
        rows_in: Vec<(SpaceId, Vec<u8>, i64)>,
        space_cache: &mut BTreeMap<SpaceId, Option<CatalogSpace>>,
    ) -> Result<BTreeMap<SpaceId, AcknowledgedCursor>, PortError> {
        let mut result = BTreeMap::new();
        for (space, history_incarnation, acked_space_seq) in rows_in {
            let current = if let Some(cached) = space_cache.get(&space) {
                let Some(value) = cached else {
                    continue;
                };
                value.clone()
            } else {
                match self.catalog_space(ctx, &space).await {
                    Ok(value) => {
                        space_cache.insert(space.clone(), Some(value.clone()));
                        value
                    }
                    Err(error) if hidden(&error) => {
                        space_cache.insert(space.clone(), None);
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            };
            let scope = HistoryScope {
                space_id: space.clone(),
                incarnation: HistoryIncarnation::from_bytes(
                    history_incarnation
                        .try_into()
                        .map_err(|_| invalid(ValidationReason::InvalidState))?,
                ),
            };
            current.history.check(&scope)?;
            let seq = SpaceSeq::new(acked_space_seq as u64)?;
            if seq > current.last_seq {
                return Err(invalid(ValidationReason::InvalidState));
            }
            result.insert(space, AcknowledgedCursor { scope, seq });
        }
        Ok(result)
    }
    /// Called only after trusted response delivery; never expose as a caller-selected cursor endpoint.
    pub async fn acknowledge_delta(
        &self,
        ctx: AccountContext,
        request: AccountMutation<AcknowledgeDelta>,
    ) -> Result<ControlCommit<AcknowledgedCursor>, PortError> {
        let command = Command::new(
            request.identity,
            "acknowledge-delta",
            (
                &request.input.owner,
                &request.input.delivered.scope,
                request.input.delivered.after,
            ),
        )?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        if matches!(
            ctx.auth().kind(),
            PrincipalKind::Keeper(_) | PrincipalKind::AgentRun(_)
        ) {
            return Err(DomainError::AccessDenied.into());
        }
        if ctx.auth().taint().is_tainted() {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        if matches!(request.input.owner, AckOwner::Account)
            && ctx.auth().bearer_scope() == Some(BearerScope::Read)
        {
            return Err(DomainError::SpaceReadOnly.into());
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let delivered = &request.input.delivered;
        let current_pre = self.current_account(&ctx, &budget).await?;
        if matches!(
            current_pre.auth().kind(),
            PrincipalKind::Keeper(_) | PrincipalKind::AgentRun(_)
        ) {
            return Err(DomainError::AccessDenied.into());
        }
        if current_pre.auth().taint().is_tainted() {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        if matches!(request.input.owner, AckOwner::Account)
            && current_pre.auth().bearer_scope() == Some(BearerScope::Read)
        {
            return Err(DomainError::SpaceReadOnly.into());
        }
        if current_pre
            .auth()
            .spaces()
            .get(&delivered.scope.space_id)
            .is_none_or(|g| g.read_classes.is_empty())
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        let catalog = budget
            .run(
                self.catalog_space(&current_pre, &delivered.scope.space_id),
                CommitEffect::NotCommitted,
            )
            .await?;
        catalog.history.check(&delivered.scope)?;
        if delivered.after > catalog.last_seq {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        let keeper = self
            .precheck_keeper_catalog(ctx.auth(), &budget, &ctx.budget.request)
            .await?;
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, saved) = budget.run(async {
            let auth = self.revalidate_with_keeper(tx.inner_mut(), ctx.auth(), keeper.as_ref()).await?;
            if matches!(auth.kind(), PrincipalKind::Keeper(_) | PrincipalKind::AgentRun(_)) {
                return Err(DomainError::AccessDenied.into());
            }
            if auth.taint().is_tainted() {
                return Err(DomainError::CrossSpaceTainted.into());
            }
            if matches!(request.input.owner, AckOwner::Account)
                && auth.bearer_scope() == Some(BearerScope::Read)
            {
                return Err(DomainError::SpaceReadOnly.into());
            }
            if auth.spaces().get(&delivered.scope.space_id).is_none_or(|g| g.read_classes.is_empty()) {
                return Err(DomainError::ResourceNotFound.into());
            }
            if let AckOwner::Episode(id) = &request.input.owner {
                let row = episode(tx.inner_mut(), auth.principal(), id).await?;
                if row.lifecycle == "closed" {
                    return Err(invalid(ValidationReason::InvalidState));
                }
            }
            if let Some(replay) = command.replay::<SavedAck>(tx.inner_mut()).await? { return Ok(replay); }
            let owner = user(tx.inner_mut(), auth.principal().as_str()).await?;
            let space = delivered.scope.space_id.as_str();
            let existing = match &request.input.owner {
                AckOwner::Account => rows!(tx.inner_mut(),CursorRow,fetch_optional,"SELECT history_incarnation,acked_space_seq FROM mcp_delta_owner_cursors WHERE owner_id=$1 AND space_id=$2","SELECT history_incarnation,acked_space_seq FROM v1_control.mcp_delta_owner_cursors WHERE owner_id=$1 AND space_id=$2";&owner.user_id,space)?,
                AckOwner::Episode(id) => rows!(tx.inner_mut(),CursorRow,fetch_optional,"SELECT history_incarnation,acked_space_seq FROM mcp_delta_session_cursors WHERE episode_id=$1 AND space_id=$2","SELECT history_incarnation,acked_space_seq FROM v1_control.mcp_delta_session_cursors WHERE episode_id=$1 AND space_id=$2";id.as_str(),space)?,
            };
            let seq = if let Some(existing) = existing {
                let scope = HistoryScope { space_id: delivered.scope.space_id.clone(), incarnation: HistoryIncarnation::from_bytes(existing.history_incarnation.try_into().map_err(|_| invalid(ValidationReason::InvalidState))?) };
                delivered.scope.check(&scope)?;
                delivered.after.max(SpaceSeq::new(existing.acked_space_seq as u64)?)
            } else {
                let count = match &request.input.owner {
                    AckOwner::Account => rows!(tx.inner_mut(),Count,fetch_one,"SELECT count(*) AS count FROM mcp_delta_owner_cursors WHERE owner_id=$1","SELECT count(*) AS count FROM v1_control.mcp_delta_owner_cursors WHERE owner_id=$1";&owner.user_id)?.count,
                    AckOwner::Episode(id) => rows!(tx.inner_mut(),Count,fetch_one,"SELECT count(*) AS count FROM mcp_delta_session_cursors WHERE episode_id=$1","SELECT count(*) AS count FROM v1_control.mcp_delta_session_cursors WHERE episode_id=$1";id.as_str())?.count,
                };
                if count >= 4096 { return Err(invalid(ValidationReason::BudgetExceeded)); }
                delivered.after
            };
            let now = self.clock.now_ms()?;
            let history = delivered.scope.incarnation.as_bytes().as_slice();
            match &request.input.owner {
                AckOwner::Account => { execute!(tx.inner_mut(),
                    "INSERT INTO mcp_delta_owner_cursors(owner_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,space_id) DO UPDATE SET acked_space_seq=excluded.acked_space_seq,updated_at=excluded.updated_at",
                    "INSERT INTO v1_control.mcp_delta_owner_cursors(owner_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,space_id) DO UPDATE SET acked_space_seq=excluded.acked_space_seq,updated_at=excluded.updated_at";&owner.user_id,space,history,seq.get() as i64,now)?; },
                AckOwner::Episode(id) => { execute!(tx.inner_mut(),
                    "INSERT INTO mcp_delta_session_cursors(episode_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(episode_id,space_id) DO UPDATE SET acked_space_seq=excluded.acked_space_seq,updated_at=excluded.updated_at",
                    "INSERT INTO v1_control.mcp_delta_session_cursors(episode_id,space_id,history_incarnation,acked_space_seq,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(episode_id,space_id) DO UPDATE SET acked_space_seq=excluded.acked_space_seq,updated_at=excluded.updated_at";id.as_str(),space,history,seq.get() as i64,now)?; },
            }
            // MAX acknowledgements commute. The command's old owner revision is
            // fingerprinted, but is not a CAS precondition for this operation.
            let revision = bump_owner(tx.inner_mut(), &owner).await?;
            let saved = SavedResult { value: SavedAck { scope: delivered.scope.clone(), seq }, events: vec![] };
            command.save(tx.inner_mut(), revision, &saved, now).await?;
            Ok((revision, saved))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit {
            revision,
            value: AcknowledgedCursor {
                scope: saved.value.scope,
                seq: saved.value.seq,
            },
        })
    }
    pub async fn lookup_mcp_dedup(
        &self,
        ctx: AccountContext,
        key: McpDedupKey,
    ) -> Result<Option<McpDedupHit>, PortError> {
        validate_dedup_key(&key)?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut rtx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let hit = budget
            .run(
                async {
                    if key.actor != expected_dedup_actor(&auth) {
                        return Err(DomainError::AccessDenied.into());
                    }
                    if auth.principal().as_str().len() + key.actor.len() + key.request_key.as_str().len()
                        > 2048
                    {
                        return Err(invalid(ValidationReason::InvalidLimit));
                    }
                    let row = rows!(
                        rtx.inner_mut(),
                        McpDedupRow,
                        fetch_optional,
                        "SELECT * FROM mcp_dedup WHERE owner=$1 AND actor=$2 AND request_key=$3",
                        "SELECT * FROM v1_control.mcp_dedup WHERE owner=$1 AND actor=$2 AND request_key=$3";
                        auth.principal().as_str(),
                        &key.actor,
                        key.request_key.as_str()
                    )?;
                    let Some(row) = row else {
                        return Ok(None);
                    };
                    if row.expires_at <= self.clock.now_ms()? {
                        return Ok(None);
                    }
                    if row.request_hash != key.request_hash.as_bytes()
                        || row.operation != key.operation
                    {
                        return Err(DomainError::IdempotencyKeyReused.into());
                    }
                    let effect: AgentEffect = serde_json::from_value(serde_json::Value::String(
                        row.effect,
                    ))
                    .map_err(|_| invalid(ValidationReason::InvalidState))?;
                    Ok(Some(McpDedupHit {
                        operation: row.operation,
                        safe_result: row.safe_result,
                        effect,
                    }))
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget
            .run(rtx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(hit)
    }
    pub async fn record_mcp_dedup(
        &self,
        ctx: AccountContext,
        record: McpDedupRecord,
    ) -> Result<McpDedupHit, PortError> {
        validate_dedup_key(&record.key)?;
        if ctx.auth().taint().is_tainted() {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        if record.safe_result.len() > 65536
            || record.safe_result.contains('\0')
            || record.ttl_ms == 0
            || record.ttl_ms > 7 * 86_400_000
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let effect = match serde_json::to_value(record.effect)
            .map_err(|_| invalid(ValidationReason::InvalidState))?
        {
            serde_json::Value::String(s) => s,
            _ => return Err(invalid(ValidationReason::InvalidState)),
        };
        let budget = OperationBudget::new(ctx.budget.clone());
        let keeper = self
            .precheck_keeper_catalog(ctx.auth(), &budget, &ctx.budget.request)
            .await?;
        let mut tx = self.store.write(budget.clone()).await?;
        let hit = budget
            .run(
                async {
                    let auth = self
                        .revalidate_with_keeper(tx.inner_mut(), ctx.auth(), keeper.as_ref())
                        .await?;
                    if auth.taint().is_tainted() {
                        return Err(DomainError::CrossSpaceTainted.into());
                    }
                    if record.key.actor != expected_dedup_actor(&auth) {
                        return Err(DomainError::AccessDenied.into());
                    }
                    if auth.bearer_scope() == Some(BearerScope::Read)
                        && record.effect == AgentEffect::Write
                    {
                        return Err(DomainError::SpaceReadOnly.into());
                    }
                    let owner = auth.principal().as_str();
                    if owner.len() + record.key.actor.len() + record.key.request_key.as_str().len()
                        > 2048
                    {
                        return Err(invalid(ValidationReason::InvalidLimit));
                    }
                    let now = self.clock.now_ms()?;
                    let expires_at = now
                        .checked_add(record.ttl_ms as i64)
                        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
                    let existing = rows!(
                        tx.inner_mut(),
                        McpDedupRow,
                        fetch_optional,
                        "SELECT * FROM mcp_dedup WHERE owner=$1 AND actor=$2 AND request_key=$3",
                        "SELECT * FROM v1_control.mcp_dedup WHERE owner=$1 AND actor=$2 AND request_key=$3 FOR UPDATE";
                        owner,
                        &record.key.actor,
                        record.key.request_key.as_str()
                    )?;
                    if let Some(existing) = existing {
                        if existing.expires_at > now {
                            if existing.request_hash != record.key.request_hash.as_bytes()
                                || existing.operation != record.key.operation
                            {
                                return Err(DomainError::IdempotencyKeyReused.into());
                            }
                            let effect: AgentEffect = serde_json::from_value(
                                serde_json::Value::String(existing.effect),
                            )
                            .map_err(|_| invalid(ValidationReason::InvalidState))?;
                            return Ok(McpDedupHit {
                                operation: existing.operation,
                                safe_result: existing.safe_result,
                                effect,
                            });
                        }
                        execute!(
                            tx.inner_mut(),
                            "DELETE FROM mcp_dedup WHERE owner=$1 AND actor=$2 AND request_key=$3",
                            "DELETE FROM v1_control.mcp_dedup WHERE owner=$1 AND actor=$2 AND request_key=$3";
                            owner,
                            &record.key.actor,
                            record.key.request_key.as_str()
                        )?;
                    }
                    let raw_row = McpDedupRow {
                        owner: owner.to_owned(),
                        actor: record.key.actor.clone(),
                        request_key: record.key.request_key.to_string(),
                        request_hash: record.key.request_hash.as_bytes().to_vec(),
                        operation: record.key.operation.clone(),
                        safe_result: record.safe_result,
                        effect,
                        expires_at,
                    };
                    TargetRecord::from(raw_row.clone()).validate()?;
                    let inserted = execute!(
                        tx.inner_mut(),
                        "INSERT INTO mcp_dedup(owner,actor,request_key,request_hash,operation,safe_result,effect,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner,actor,request_key) DO NOTHING",
                        "INSERT INTO v1_control.mcp_dedup(owner,actor,request_key,request_hash,operation,safe_result,effect,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner,actor,request_key) DO NOTHING";
                        &raw_row.owner,
                        &raw_row.actor,
                        &raw_row.request_key,
                        &raw_row.request_hash,
                        &raw_row.operation,
                        &raw_row.safe_result,
                        &raw_row.effect,
                        raw_row.expires_at
                    )?;
                    if inserted == 0 {
                        let raced = rows!(
                            tx.inner_mut(),
                            McpDedupRow,
                            fetch_optional,
                            "SELECT * FROM mcp_dedup WHERE owner=$1 AND actor=$2 AND request_key=$3",
                            "SELECT * FROM v1_control.mcp_dedup WHERE owner=$1 AND actor=$2 AND request_key=$3";
                            owner,
                            &record.key.actor,
                            record.key.request_key.as_str()
                        )?
                        .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                        if raced.request_hash != record.key.request_hash.as_bytes()
                            || raced.operation != record.key.operation
                        {
                            return Err(DomainError::IdempotencyKeyReused.into());
                        }
                        let effect: AgentEffect =
                            serde_json::from_value(serde_json::Value::String(raced.effect))
                                .map_err(|_| invalid(ValidationReason::InvalidState))?;
                        return Ok(McpDedupHit {
                            operation: raced.operation,
                            safe_result: raced.safe_result,
                            effect,
                        });
                    }
                    Ok(McpDedupHit {
                        operation: raw_row.operation,
                        safe_result: raw_row.safe_result,
                        effect: record.effect,
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(hit)
    }
}

fn expected_dedup_actor(auth: &notarium_core::auth::EngineAuthContext) -> &str {
    match auth.kind() {
        PrincipalKind::AgentRun(run) | PrincipalKind::Keeper(run) => run.as_str(),
        _ => auth.grant().as_str(),
    }
}

fn validate_dedup_key(key: &McpDedupKey) -> Result<(), PortError> {
    if key.actor.is_empty()
        || key.actor.len() > 512
        || key.actor.contains('\0')
        || key.operation.is_empty()
        || key.operation.len() > 128
        || key.operation.contains('\0')
    {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(())
}
