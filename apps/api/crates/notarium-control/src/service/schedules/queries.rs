use super::*;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    scope: ContentDigest,
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
impl ControlService {
    async fn readable_schedule(
        &self,
        ctx: &AccountContext,
        row: &AgentSchedulesRow,
    ) -> Result<AgentSchedule, PortError> {
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
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let (current, scope, rows) = budget.run(async {
            let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
            let scope = digest(current.auth(), ("schedules", ctx.scope()))?;
            let cursor = cursor(&page, scope)?;
            let after = cursor.as_ref().map_or("", |c| c.last.as_str());
            let rows = rows!(tx.inner_mut(),AgentSchedulesRow,fetch_all,"SELECT * FROM agent_schedules WHERE owner_id=$1 AND space_id=$2 AND deleted_at IS NULL AND schedule_id>$3 ORDER BY schedule_id LIMIT $4","SELECT * FROM v1_control.agent_schedules WHERE owner_id=$1 AND space_id=$2 AND deleted_at IS NULL AND schedule_id COLLATE \"C\">$3 ORDER BY schedule_id COLLATE \"C\" LIMIT $4";current.auth().principal().as_str(),ctx.scope().space_id.as_str(),after,i64::from(page.limit())+1)?;
            Ok((current, scope, rows))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        budget
            .run(
                async {
                    self.catalog_space(&current, &ctx.scope().space_id)
                        .await?
                        .history
                        .check(ctx.scope())?;
                    let has_more = rows.len() > usize::from(page.limit());
                    let mut items = Vec::new();
                    let mut last = None;
                    for row in rows.into_iter().take(usize::from(page.limit())) {
                        last = Some(row.schedule_id.clone());
                        match self.readable_schedule(&current, &row).await {
                            Ok(value) => items.push(value),
                            Err(e) if hidden(&e) => (),
                            Err(e) => return Err(e),
                        }
                    }
                    let continuation = if has_more {
                        Some(json(&Cursor {
                            version: 1,
                            scope,
                            last: last.expect("positive page"),
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
        let at = floor_ms(now)?;
        if at > self.clock.now_ms()? {
            return Err(invalid(ValidationReason::InvalidTimestamp));
        }
        let scope = ContentDigest::from_bytes(
            *blake3::hash(json(&(1, "due", &self.installation, at))?.as_bytes()).as_bytes(),
        );
        let cursor = cursor(&page, scope)?;
        let slot = cursor.as_ref().map_or(i64::MIN, |c| c.slot);
        let id = cursor.as_ref().map_or("", |c| c.last.as_str());
        let budget = OperationBudget::new(ctx.budget);
        let rows = budget.run(async { read_rows!(&self.store.backend,AgentSchedulesRow,fetch_all,
            "SELECT * FROM agent_schedules WHERE deleted_at IS NULL AND paused_reason IS NULL AND next_slot_utc_ms<=$1 AND (next_slot_utc_ms>$2 OR (next_slot_utc_ms=$2 AND schedule_id>$3)) ORDER BY next_slot_utc_ms,schedule_id LIMIT $4",
            "SELECT * FROM v1_control.agent_schedules WHERE deleted_at IS NULL AND paused_reason IS NULL AND next_slot_utc_ms<=$1 AND (next_slot_utc_ms>$2 OR (next_slot_utc_ms=$2 AND schedule_id COLLATE \"C\">$3)) ORDER BY next_slot_utc_ms,schedule_id COLLATE \"C\" LIMIT $4";at,slot,id,i64::from(page.limit())+1)
        },CommitEffect::NotCommitted).await?;
        let has_more = rows.len() > usize::from(page.limit());
        let selected: Vec<_> = rows.into_iter().take(usize::from(page.limit())).collect();
        let continuation = if has_more {
            let last = selected.last().expect("positive page");
            Some(json(&Cursor {
                version: 1,
                scope,
                last: last.schedule_id.clone(),
                slot: last.next_slot_utc_ms,
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
    async fn run_reader(
        &self,
        tx: &mut Transaction,
        ctx: &ScheduleRunContext,
        schedule_id: &ScheduleId,
    ) -> Result<(), PortError> {
        match ctx {
            ScheduleRunContext::Scheduler(ctx) => {
                ctx.authority.require(ServicePurpose::Scheduler)?
            }
            ScheduleRunContext::Owner(ctx) => {
                let auth = self.revalidate_read(tx, ctx.auth()).await?;
                let row = schedule_read(tx, schedule_id).await?;
                if row.owner_id != auth.principal().as_str() {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
        };
        Ok(())
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
        let mut tx = self.store.read(budget.clone()).await?;
        let result=budget.run(async {
            self.run_reader(tx.inner_mut(),&ctx,&schedule_id).await?;
            let row=rows!(tx.inner_mut(),AgentScheduleRunsRow,fetch_optional,"SELECT * FROM agent_schedule_runs WHERE schedule_id=$1 AND run_id=$2","SELECT * FROM v1_control.agent_schedule_runs WHERE schedule_id=$1 AND run_id=$2";schedule_id.as_str(),run.as_str())?.ok_or(DomainError::ResourceNotFound)?;
            receipt(&row)
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        Ok(result)
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
        let mut tx = self.store.read(budget.clone()).await?;
        let result=budget.run(async {
            self.run_reader(tx.inner_mut(),&ctx,&schedule_id).await?;
            let owner=match &ctx {ScheduleRunContext::Owner(c)=>Some(c.auth().principal()),ScheduleRunContext::Scheduler(_)=>None};
            let scope=ContentDigest::from_bytes(*blake3::hash(json(&(1,"runs",&self.installation,&schedule_id,owner))?.as_bytes()).as_bytes());
            let cursor=cursor(&page,scope)?;let slot=cursor.as_ref().map_or(i64::MIN,|c|c.slot);
            let rows=rows!(tx.inner_mut(),AgentScheduleRunsRow,fetch_all,"SELECT * FROM agent_schedule_runs WHERE schedule_id=$1 AND slot_utc_ms>$2 ORDER BY slot_utc_ms LIMIT $3","SELECT * FROM v1_control.agent_schedule_runs WHERE schedule_id=$1 AND slot_utc_ms>$2 ORDER BY slot_utc_ms LIMIT $3";schedule_id.as_str(),slot,i64::from(page.limit())+1)?;
            let has_more=rows.len()>usize::from(page.limit());
            let selected:Vec<_>=rows.into_iter().take(usize::from(page.limit())).collect();
            let continuation=if has_more {let last=selected.last().expect("positive page");Some(json(&Cursor{version:1,scope,last:last.run_id.clone(),slot:last.slot_utc_ms})?)} else {None};
            Ok(ControlPage{items:selected.iter().map(receipt).collect::<Result<_,_>>()?,continuation})
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        Ok(result)
    }
}
