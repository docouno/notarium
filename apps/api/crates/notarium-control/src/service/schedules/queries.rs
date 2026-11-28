use super::*;

pub(crate) const DUE_SCHEDULES_SQLITE_SQL: &str = "SELECT * FROM agent_schedules WHERE deleted_at IS NULL AND paused_reason IS NULL AND next_slot_utc_ms<=$1 AND (next_slot_utc_ms,schedule_id)>($2,$3) ORDER BY next_slot_utc_ms,schedule_id LIMIT $4";
pub(crate) const EXPIRED_SCHEDULE_RUNS_SQLITE_SQL: &str = "SELECT * FROM agent_schedule_runs WHERE status IN ('claimed','running') AND expires_at<=$1 AND (expires_at,run_id)>($2,$3) ORDER BY expires_at,run_id LIMIT $4";
pub(crate) const LIST_SCHEDULES_LIVE_SQLITE_SQL: &str = "SELECT * FROM agent_schedules WHERE owner_id=$1 AND space_id=$2 AND deleted_at IS NULL AND schedule_id>$3 ORDER BY schedule_id LIMIT $4";
pub(crate) const LIST_SCHEDULES_PROJECT_LIVE_SQLITE_SQL: &str = "SELECT * FROM agent_schedules WHERE owner_id=$1 AND space_id=$2 AND deleted_at IS NULL AND project_folder_id=$3 AND schedule_id>$4 ORDER BY schedule_id LIMIT $5";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    scope: ContentDigest,
    last: String,
    slot: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TimedCursor {
    version: u8,
    scope: ContentDigest,
    at: i64,
    last: String,
    slot: i64,
}
fn cursor(page: &ControlPageRequest, scope: ContentDigest) -> Result<Option<Cursor>, PortError> {
    let cursor: Option<Cursor> = page.continuation().map(parse).transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|v| v.version != 1 || v.scope != scope)
    {
        return Err(invalid(ValidationReason::CursorStale));
    }
    Ok(cursor)
}
fn timed_cursor(
    page: &ControlPageRequest,
    scope: ContentDigest,
    requested: i64,
    control_now: i64,
) -> Result<Option<TimedCursor>, PortError> {
    let cursor: Option<TimedCursor> = page.continuation().map(parse).transpose()?;
    if cursor.as_ref().is_some_and(|v| {
        v.version != 1
            || v.scope != scope
            || v.at > requested
            || v.at > control_now
            || v.slot > v.at
    }) {
        return Err(invalid(ValidationReason::CursorStale));
    }
    Ok(cursor)
}
impl ControlService {
    fn authorize_schedule_reader(
        auth: &EngineAuthContext,
        schedule_id: &str,
    ) -> Result<(), PortError> {
        match auth.kind() {
            PrincipalKind::AgentRun(_) | PrincipalKind::SearchIndexing => {
                Err(DomainError::ResourceNotFound.into())
            }
            PrincipalKind::Keeper(run) => match auth.credential() {
                Some(AuthenticatedCredential::ScheduledRun {
                    schedule,
                    run: verified,
                    ..
                }) if verified == run && schedule.as_str() == schedule_id => Ok(()),
                _ => Err(DomainError::ResourceNotFound.into()),
            },
            PrincipalKind::DirectHuman | PrincipalKind::Pat | PrincipalKind::OAuth { .. } => Ok(()),
        }
    }
    fn readable_schedule_in_space(
        ctx: &AccountContext,
        row: &AgentSchedulesRow,
    ) -> Result<AgentSchedule, PortError> {
        Self::authorize_schedule_reader(ctx.auth(), &row.schedule_id)?;
        if row.owner_id != ctx.auth().principal().as_str() || row.deleted_at.is_some() {
            return Err(DomainError::ResourceNotFound.into());
        }
        let value = schedule_info(row)?;
        let grant = ctx
            .auth()
            .spaces()
            .get(&value.definition.space)
            .ok_or(DomainError::ResourceNotFound)?;
        if grant.read_classes.is_empty()
            || grant.project_root.as_ref().is_some_and(|root| {
                value.definition.project.as_ref().map(|p| &p.folder_id) != Some(root)
            })
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        Ok(value)
    }
    async fn readable_schedule(
        &self,
        ctx: &AccountContext,
        row: &AgentSchedulesRow,
    ) -> Result<AgentSchedule, PortError> {
        let value = Self::readable_schedule_in_space(ctx, row)?;
        self.catalog_space(ctx, &value.definition.space).await?;
        // Stored owner configuration remains editable after its target project
        // disappears. It does not expose canonical titles or package content.
        Ok(value)
    }
    pub(super) async fn account_schedule(
        &self,
        ctx: AccountContext,
        id: ScheduleId,
    ) -> Result<AgentSchedule, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let row = budget
            .run(
                schedule_read(tx.inner_mut(), &id),
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        budget
            .run(
                self.readable_schedule(
                    &AccountContext::new(auth, budget.context(ctx.budget.request.clone())),
                    &row,
                ),
                CommitEffect::NotCommitted,
            )
            .await
    }
    pub async fn get_schedule(
        &self,
        ctx: SpaceContext,
        id: ScheduleId,
    ) -> Result<AgentSchedule, PortError> {
        let account = AccountContext::new(ctx.auth().clone(), ctx.budget.clone());
        let result = self.account_schedule(account.clone(), id).await?;
        if result.definition.space != ctx.scope().space_id {
            return Err(DomainError::ResourceNotFound.into());
        }
        self.catalog_space(&account, &result.definition.space)
            .await?
            .history
            .check(ctx.scope())?;
        Ok(result)
    }
    pub async fn list_schedules(
        &self,
        ctx: SpaceContext,
        page: ControlPageRequest,
    ) -> Result<ControlPage<AgentSchedule>, PortError> {
        const MAX_SCAN: usize = 4096;
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let (current, scope, items, has_more) = budget
            .run(
                async {
                    let current =
                        AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
                    let scope = digest(current.auth(), ("schedules", ctx.scope()))?;
                    let cursor = cursor(&page, scope)?;
                    let mut after = cursor.map_or_else(String::new, |c| c.last);
                    let target = usize::from(page.limit());
                    let batch_limit = i64::from(page.limit()).saturating_add(1).max(16);
                    let mut items = Vec::with_capacity(target);
                    let mut has_more = false;
                    let mut scanned = 0usize;
                    let grant = current.auth().spaces().get(&ctx.scope().space_id);
                    let space_readable =
                        grant.is_some_and(|grant| !grant.read_classes.is_empty());
                    let pinned_project = grant.and_then(|grant| grant.project_root.as_ref());
                    let keeper_schedule_filter = match current.auth().kind() {
                        PrincipalKind::AgentRun(_) | PrincipalKind::SearchIndexing => {
                            return Ok((current, scope, items, has_more));
                        }
                        PrincipalKind::Keeper(run) => match current.auth().credential() {
                            Some(AuthenticatedCredential::ScheduledRun {
                                schedule,
                                run: verified,
                                ..
                            }) if verified == run => Some(schedule.as_str()),
                            _ => return Ok((current, scope, items, has_more)),
                        },
                        PrincipalKind::DirectHuman
                        | PrincipalKind::Pat
                        | PrincipalKind::OAuth { .. } => None,
                    };
                    if !space_readable {
                        return Ok((current, scope, items, has_more));
                    }
                    loop {
                        let fetch_limit = batch_limit.min(
                            i64::try_from((MAX_SCAN + 1).saturating_sub(scanned))
                                .unwrap_or(1)
                                .max(1),
                        );
                        let batch = if let Some(exact_schedule) = keeper_schedule_filter {
                            if !after.is_empty() && exact_schedule <= after.as_str() {
                                Vec::new()
                            } else {
                                rows!(
                                    tx.inner_mut(),
                                    AgentSchedulesRow,
                                    fetch_all,
                                    "SELECT * FROM agent_schedules WHERE owner_id=$1 AND space_id=$2 AND deleted_at IS NULL AND schedule_id=$3",
                                    "SELECT * FROM v1_control.agent_schedules WHERE owner_id=$1 AND space_id=$2 AND deleted_at IS NULL AND schedule_id=$3";
                                    current.auth().principal().as_str(),
                                    ctx.scope().space_id.as_str(),
                                    exact_schedule
                                )?
                            }
                        } else if let Some(project_root) = pinned_project {
                            rows!(
                                tx.inner_mut(),
                                AgentSchedulesRow,
                                fetch_all,
                                LIST_SCHEDULES_PROJECT_LIVE_SQLITE_SQL,
                                "SELECT * FROM v1_control.agent_schedules WHERE owner_id=$1 AND space_id=$2 AND deleted_at IS NULL AND project_folder_id=$3 AND schedule_id COLLATE \"C\">$4 ORDER BY schedule_id COLLATE \"C\" LIMIT $5";
                                current.auth().principal().as_str(),
                                ctx.scope().space_id.as_str(),
                                project_root.as_str(),
                                &after,
                                fetch_limit
                            )?
                        } else {
                            rows!(
                                tx.inner_mut(),
                                AgentSchedulesRow,
                                fetch_all,
                                LIST_SCHEDULES_LIVE_SQLITE_SQL,
                                "SELECT * FROM v1_control.agent_schedules WHERE owner_id=$1 AND space_id=$2 AND deleted_at IS NULL AND schedule_id COLLATE \"C\">$3 ORDER BY schedule_id COLLATE \"C\" LIMIT $4";
                                current.auth().principal().as_str(),
                                ctx.scope().space_id.as_str(),
                                &after,
                                fetch_limit
                            )?
                        };
                        let batch_len = batch.len();
                        for row in batch {
                            scanned = scanned.saturating_add(1);
                            if scanned > MAX_SCAN {
                                return Err(invalid(ValidationReason::BudgetExceeded));
                            }
                            after = row.schedule_id.clone();
                            match Self::readable_schedule_in_space(&current, &row) {
                                Ok(value) => {
                                    if items.len() == target {
                                        has_more = true;
                                        break;
                                    }
                                    items.push(value);
                                }
                                Err(e) if hidden(&e) => (),
                                Err(e) => return Err(e),
                            }
                        }
                        if keeper_schedule_filter.is_some()
                            || has_more
                            || batch_len < usize::try_from(fetch_limit).unwrap_or(usize::MAX)
                        {
                            break;
                        }
                    }
                    Ok((current, scope, items, has_more))
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        budget
            .run(
                async {
                    self.catalog_space(&current, &ctx.scope().space_id)
                        .await?
                        .history
                        .check(ctx.scope())?;
                    let continuation = if has_more {
                        let last = items.last().expect("positive page").id.to_string();
                        Some(json(&Cursor {
                            version: 1,
                            scope,
                            last,
                            slot: 0,
                        })?)
                    } else {
                        None
                    };
                    Ok(ControlPage {
                        items,
                        continuation,
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await
    }
    pub async fn list_due_schedules(
        &self,
        ctx: MaintenanceContext,
        now: Timestamp,
        page: ControlPageRequest,
    ) -> Result<ControlPage<AgentSchedule>, PortError> {
        ctx.authority.require(ServicePurpose::Scheduler)?;
        let requested = floor_ms(now)?;
        let control_now = self.clock.now_ms()?;
        let scope = ContentDigest::from_bytes(
            *blake3::hash(json(&(1, "due", &self.installation, requested))?.as_bytes()).as_bytes(),
        );
        let cursor = timed_cursor(&page, scope, requested, control_now)?;
        let at = cursor
            .as_ref()
            .map_or_else(|| requested.min(control_now), |c| c.at);
        let slot = cursor.as_ref().map_or(i64::MIN, |c| c.slot);
        let id = cursor.as_ref().map_or("", |c| c.last.as_str());
        let budget = OperationBudget::new(ctx.budget);
        let rows = budget.run(async { read_rows!(&self.store.backend,AgentSchedulesRow,fetch_all,
            DUE_SCHEDULES_SQLITE_SQL,
            "SELECT * FROM v1_control.agent_schedules WHERE deleted_at IS NULL AND paused_reason IS NULL AND next_slot_utc_ms<=$1 AND (next_slot_utc_ms,schedule_id COLLATE \"C\")>($2,$3) ORDER BY next_slot_utc_ms,schedule_id COLLATE \"C\" LIMIT $4";at,slot,id,i64::from(page.limit())+1)
        },CommitEffect::NotCommitted).await?;
        let has_more = rows.len() > usize::from(page.limit());
        let selected: Vec<_> = rows.into_iter().take(usize::from(page.limit())).collect();
        let continuation = if has_more {
            let last = selected.last().expect("positive page");
            Some(json(&TimedCursor {
                version: 1,
                scope,
                at,
                last: last.schedule_id.clone(),
                slot: last
                    .next_slot_utc_ms
                    .ok_or_else(|| invalid(ValidationReason::InvalidState))?,
            })?)
        } else {
            None
        };
        Ok(ControlPage {
            items: selected
                .iter()
                .map(schedule_info)
                .collect::<Result<_, _>>()?,
            continuation,
        })
    }
    pub async fn list_expired_schedule_runs(
        &self,
        ctx: MaintenanceContext,
        now: Timestamp,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ScheduleRunReceipt>, PortError> {
        ctx.authority.require(ServicePurpose::Scheduler)?;
        let requested = floor_ms(now)?;
        let control_now = self.clock.now_ms()?;
        let scope = ContentDigest::from_bytes(
            *blake3::hash(
                json(&(1, "expired-schedule-runs", &self.installation, requested))?.as_bytes(),
            )
            .as_bytes(),
        );
        let cursor = timed_cursor(&page, scope, requested, control_now)?;
        let at = cursor
            .as_ref()
            .map_or_else(|| requested.min(control_now), |c| c.at);
        let expires = cursor.as_ref().map_or(i64::MIN, |value| value.slot);
        let id = cursor.as_ref().map_or("", |value| value.last.as_str());
        let budget = OperationBudget::new(ctx.budget);
        let mut rows = budget.run(async {
            read_rows!(&self.store.backend,AgentScheduleRunsRow,fetch_all,
                EXPIRED_SCHEDULE_RUNS_SQLITE_SQL,
                "SELECT * FROM v1_control.agent_schedule_runs WHERE status IN ('claimed','running') AND expires_at<=$1 AND (expires_at,run_id COLLATE \"C\")>($2,$3) ORDER BY expires_at,run_id COLLATE \"C\" LIMIT $4";
                at,expires,id,i64::from(page.limit())+1)
        }, CommitEffect::NotCommitted).await?;
        let continuation = if rows.len() > usize::from(page.limit()) {
            rows.pop();
            let last = rows.last().expect("positive page");
            Some(json(&TimedCursor {
                version: 1,
                scope,
                at,
                last: last.run_id.clone(),
                slot: last.expires_at,
            })?)
        } else {
            None
        };
        Ok(ControlPage {
            items: rows.iter().map(receipt).collect::<Result<_, _>>()?,
            continuation,
        })
    }
    async fn open_run_reader(
        &self,
        budget: &OperationBudget,
        ctx: &ScheduleRunContext,
        schedule_id: &ScheduleId,
    ) -> Result<
        (
            crate::store::ReadTransaction,
            Option<(EngineAuthContext, SpaceId)>,
        ),
        PortError,
    > {
        match ctx {
            ScheduleRunContext::Scheduler(ctx) => {
                ctx.authority.require(ServicePurpose::Scheduler)?;
                let tx = self.store.read(budget.clone()).await?;
                Ok((tx, None))
            }
            ScheduleRunContext::Owner(ctx) => {
                let (mut tx, auth) = self
                    .open_revalidated_read(budget, &ctx.budget.request, ctx.auth())
                    .await?;
                let check = budget
                    .run(
                        async {
                            Self::authorize_schedule_reader(&auth, schedule_id.as_str())?;
                            let row = schedule_read(tx.inner_mut(), schedule_id).await?;
                            if row.owner_id != auth.principal().as_str() {
                                return Err(DomainError::ResourceNotFound.into());
                            }
                            let space = SpaceId::parse(&row.space_id)?;
                            let project = row
                                .project_folder_id
                                .as_deref()
                                .map(FolderId::parse)
                                .transpose()?;
                            let grant = auth
                                .spaces()
                                .get(&space)
                                .ok_or(DomainError::ResourceNotFound)?;
                            if grant.read_classes.is_empty()
                                || grant
                                    .project_root
                                    .as_ref()
                                    .is_some_and(|root| project.as_ref() != Some(root))
                            {
                                return Err(DomainError::ResourceNotFound.into());
                            }
                            Ok::<_, PortError>(space)
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await;
                match check {
                    Ok(space) => Ok((tx, Some((auth, space)))),
                    Err(err) => {
                        let _ = tx.finish().await;
                        Err(err)
                    }
                }
            }
        }
    }
    pub async fn get_schedule_run(
        &self,
        ctx: ScheduleRunContext,
        schedule_id: ScheduleId,
        run: AgentRunId,
    ) -> Result<ScheduleRunReceipt, PortError> {
        let budget = OperationBudget::new(match &ctx {
            ScheduleRunContext::Owner(c) => c.budget.clone(),
            ScheduleRunContext::Scheduler(c) => c.budget.clone(),
        });
        let (mut tx, owner) = self.open_run_reader(&budget, &ctx, &schedule_id).await?;
        let result = budget
            .run(
                async {
                    if let Some((auth, _)) = &owner
                        && matches!(auth.kind(), PrincipalKind::Keeper(current) if current != &run)
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let row = rows!(tx.inner_mut(),AgentScheduleRunsRow,fetch_optional,"SELECT * FROM agent_schedule_runs WHERE schedule_id=$1 AND run_id=$2","SELECT * FROM v1_control.agent_schedule_runs WHERE schedule_id=$1 AND run_id=$2";schedule_id.as_str(),run.as_str())?
                        .ok_or(DomainError::ResourceNotFound)?;
                    match &owner {
                        Some((auth, space)) => scoped_receipt(&row, auth, space),
                        None => receipt(&row),
                    }
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        result
    }
    pub async fn ensure_run_inactive(
        &self,
        ctx: AccountContext,
        space: SpaceId,
        run: AgentRunId,
    ) -> Result<(), PortError> {
        ctx.auth().authorize_human_management()?;
        if ctx.auth().taint().is_tainted() {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let result = budget
            .run(
                async {
                    auth.authorize_human_management()?;
                    if auth.taint().is_tainted() {
                        return Err(DomainError::CrossSpaceTainted.into());
                    }
                    let grant = auth
                        .spaces()
                        .get(&space)
                        .ok_or(DomainError::ResourceNotFound)?;
                    if grant.role == SpaceRole::Viewer || grant.project_root.is_some() {
                        return Err(DomainError::AccessDenied.into());
                    }
                    let row = rows!(
                        tx.inner_mut(),
                        (String, String),
                        fetch_optional,
                        "SELECT r.status, s.owner_id FROM agent_schedule_runs r JOIN agent_schedules s ON s.schedule_id=r.schedule_id WHERE r.run_id=$1 AND s.space_id=$2",
                        "SELECT r.status, s.owner_id FROM v1_control.agent_schedule_runs r JOIN v1_control.agent_schedules s ON s.schedule_id=r.schedule_id WHERE r.run_id=$1 AND s.space_id=$2";
                        run.as_str(),
                        space.as_str()
                    )?;
                    Ok(row.and_then(|(status, owner_id)| {
                        matches!(status.as_str(), "claimed" | "running")
                            .then_some(owner_id == auth.principal().as_str())
                    }))
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        let active_owner_match = result?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        self.catalog_space(&current, &space).await?;
        match active_owner_match {
            Some(true) => Err(invalid(ValidationReason::InvalidState)),
            Some(false) => {
                // Schedule runs are owner-private; only report an active foreign Keeper
                // when it has already recorded canonical edits in this Space so callers
                // cannot roll back in-flight edits or probe zero-edit foreign schedules.
                let has_edits = self
                    .catalog
                    .agent_run_has_head(budget.context(ctx.budget.request), space, run)
                    .await?;
                if has_edits {
                    Err(invalid(ValidationReason::InvalidState))
                } else {
                    Ok(())
                }
            }
            None => Ok(()),
        }
    }
    pub async fn list_schedule_runs(
        &self,
        ctx: ScheduleRunContext,
        schedule_id: ScheduleId,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ScheduleRunReceipt>, PortError> {
        let budget = OperationBudget::new(match &ctx {
            ScheduleRunContext::Owner(c) => c.budget.clone(),
            ScheduleRunContext::Scheduler(c) => c.budget.clone(),
        });
        let (mut tx, revalidated_owner) = self.open_run_reader(&budget, &ctx, &schedule_id).await?;
        let result = budget
            .run(
                async {
                    let scope = match &revalidated_owner {
                        Some((auth, _)) => digest(auth, ("runs", &self.installation, &schedule_id))?,
                        None => ContentDigest::from_bytes(
                            *blake3::hash(
                                json(&(
                                    1,
                                    "runs",
                                    &self.installation,
                                    &schedule_id,
                                    Option::<&PrincipalId>::None,
                                ))?
                                .as_bytes(),
                            )
                            .as_bytes(),
                        ),
                    };
                    let cursor = cursor(&page, scope)?;
                    let slot = cursor.as_ref().map_or(i64::MIN, |c| c.slot);
                    let rows = if let Some((auth, _)) = &revalidated_owner
                        && let PrincipalKind::Keeper(current) = auth.kind()
                    {
                        rows!(tx.inner_mut(),AgentScheduleRunsRow,fetch_all,"SELECT * FROM agent_schedule_runs WHERE schedule_id=$1 AND run_id=$2 AND slot_utc_ms>$3 ORDER BY slot_utc_ms LIMIT $4","SELECT * FROM v1_control.agent_schedule_runs WHERE schedule_id=$1 AND run_id=$2 AND slot_utc_ms>$3 ORDER BY slot_utc_ms LIMIT $4";schedule_id.as_str(),current.as_str(),slot,i64::from(page.limit())+1)?
                    } else {
                        rows!(tx.inner_mut(),AgentScheduleRunsRow,fetch_all,"SELECT * FROM agent_schedule_runs WHERE schedule_id=$1 AND slot_utc_ms>$2 ORDER BY slot_utc_ms LIMIT $3","SELECT * FROM v1_control.agent_schedule_runs WHERE schedule_id=$1 AND slot_utc_ms>$2 ORDER BY slot_utc_ms LIMIT $3";schedule_id.as_str(),slot,i64::from(page.limit())+1)?
                    };
                    let has_more = rows.len() > usize::from(page.limit());
                    let selected: Vec<_> =
                        rows.into_iter().take(usize::from(page.limit())).collect();
                    let continuation = if has_more {
                        let last = selected.last().expect("positive page");
                        Some(json(&Cursor {
                            version: 1,
                            scope,
                            last: last.run_id.clone(),
                            slot: last.slot_utc_ms,
                        })?)
                    } else {
                        None
                    };
                    Ok(ControlPage {
                        items: selected.iter().map(|row| match &revalidated_owner {
                            Some((auth, space)) => scoped_receipt(row, auth, space),
                            None => receipt(row),
                        }).collect::<Result<_, _>>()?,
                        continuation,
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        result
    }
}
