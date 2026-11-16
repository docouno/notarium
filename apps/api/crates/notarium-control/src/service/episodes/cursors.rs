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
    pub(in super::super) async fn acknowledgements(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        episode: Option<&EpisodeId>,
    ) -> Result<BTreeMap<SpaceId, AcknowledgedCursor>, PortError> {
        let mut result = BTreeMap::new();
        for (space, grant) in ctx.auth().spaces() {
            if grant.read_classes.is_empty() {
                continue;
            }
            let row = match episode {
                Some(id) => {
                    rows!(tx,CursorRow,fetch_optional,"SELECT history_incarnation,acked_space_seq FROM mcp_delta_session_cursors WHERE episode_id=$1 AND space_id=$2","SELECT history_incarnation,acked_space_seq FROM v1_control.mcp_delta_session_cursors WHERE episode_id=$1 AND space_id=$2";id.as_str(),space.as_str())?
                }
                None => {
                    rows!(tx,CursorRow,fetch_optional,"SELECT history_incarnation,acked_space_seq FROM mcp_delta_owner_cursors WHERE owner_id=$1 AND space_id=$2","SELECT history_incarnation,acked_space_seq FROM v1_control.mcp_delta_owner_cursors WHERE owner_id=$1 AND space_id=$2";ctx.auth().principal().as_str(),space.as_str())?
                }
            };
            if let Some(row) = row {
                let current = match self.catalog_space(ctx, space).await {
                    Ok(value) => value,
                    Err(error) if hidden(&error) => continue,
                    Err(error) => return Err(error),
                };
                let scope = HistoryScope {
                    space_id: space.clone(),
                    incarnation: HistoryIncarnation::from_bytes(
                        row.history_incarnation
                            .try_into()
                            .map_err(|_| invalid(ValidationReason::InvalidState))?,
                    ),
                };
                current.history.check(&scope)?;
                let seq = SpaceSeq::new(row.acked_space_seq as u64)?;
                if seq > current.last_seq {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                result.insert(space.clone(), AcknowledgedCursor { scope, seq });
            }
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
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, saved) = budget.run(async {
            let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
            let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
            let delivered = &request.input.delivered;
            if current.auth().spaces().get(&delivered.scope.space_id).is_none_or(|g| g.read_classes.is_empty()) {
                return Err(DomainError::ResourceNotFound.into());
            }
            if let AckOwner::Episode(id) = &request.input.owner { episode(tx.inner_mut(), current.auth().principal(), id).await?; }
            let catalog = self.catalog_space(&current, &delivered.scope.space_id).await?;
            catalog.history.check(&delivered.scope)?;
            if delivered.after > catalog.last_seq { return Err(invalid(ValidationReason::InvalidQuery)); }
            if let Some(replay) = command.replay::<SavedAck>(tx.inner_mut()).await? { return Ok(replay); }
            let owner = user(tx.inner_mut(), current.auth().principal().as_str()).await?;
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
}
