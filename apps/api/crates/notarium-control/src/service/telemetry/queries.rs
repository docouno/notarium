use super::*;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    scope: ContentDigest,
    started: i64,
    last: RequestId,
}
impl ControlService {
    async fn call_info(
        &self,
        ctx: &AccountContext,
        row: AgentCallsRow,
        record: Option<AgentCallDetailsRow>,
    ) -> Result<AgentCallInfo, PortError> {
        if row.owner_id != ctx.auth().principal().as_str() {
            return Err(DomainError::ResourceNotFound.into());
        }
        let detail = if let Some(record) = record {
            let mut value: AgentCallDetail = parse(&record.payload)?;
            let mut resources = Vec::new();
            for resource in value.resources {
                let permitted = match &resource {
                    TelemetryResource::Note(note) => self.catalog_note(ctx, note).await.map(|_| ()),
                    TelemetryResource::Folder(folder) => {
                        self.catalog_folder(ctx, folder).await.map(|_| ())
                    }
                    TelemetryResource::Space(space) => {
                        self.catalog_space(ctx, space).await.map(|_| ())
                    }
                };
                match permitted {
                    Ok(()) => resources.push(resource),
                    Err(e) if hidden(&e) => (),
                    Err(e) => return Err(e),
                }
            }
            value.resources = resources;
            Some(value)
        } else {
            None
        };
        Ok(AgentCallInfo {
            start: BeginAgentCall {
                call: RequestId::parse(&row.call_id)?,
                request: RequestId::parse(&row.request_id)?,
                episode: row
                    .episode_id
                    .as_deref()
                    .map(EpisodeId::parse)
                    .transpose()?,
                operation: parse(&json(&row.tool)?)?,
                transport: parse(&json(&row.transport)?)?,
                effect: parse(&json(&row.effect)?)?,
                input_bytes: row.input_bytes as u64,
            },
            started_at_ms: row.started_at,
            finished_at_ms: row.finished_at,
            outcome: row.outcome.as_ref().map(|v| parse(&json(v)?)).transpose()?,
            failure: row.reason.as_ref().map(|v| parse(&json(v)?)).transpose()?,
            output_bytes: row.output_bytes.map(|v| v as u64),
            detail,
        })
    }
    pub async fn get_agent_call(
        &self,
        ctx: AccountContext,
        call: RequestId,
    ) -> Result<AgentCallInfo, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let (current, row, record) = budget.run(async{
            let current=AccountContext::new(auth,budget.context(ctx.budget.request.clone()));
            let row=rows!(tx.inner_mut(),AgentCallsRow,fetch_optional,"SELECT * FROM agent_calls WHERE call_id=$1 AND owner_id=$2","SELECT * FROM v1_control.agent_calls WHERE call_id=$1 AND owner_id=$2";call.as_str(),current.auth().principal().as_str())?.ok_or(DomainError::ResourceNotFound)?;
            let record=rows!(tx.inner_mut(),AgentCallDetailsRow,fetch_optional,"SELECT * FROM agent_call_details WHERE call_id=$1 AND expires_at>$2","SELECT * FROM v1_control.agent_call_details WHERE call_id=$1 AND expires_at>$2";&row.call_id,self.clock.now_ms()?)?;
            Ok((current, row, record))
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        budget
            .run(
                self.call_info(&current, row, record),
                CommitEffect::NotCommitted,
            )
            .await
    }
    pub async fn list_agent_calls(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> Result<ControlPage<AgentCallInfo>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let (current, scope, rows) = budget.run(async{
            let current=AccountContext::new(auth,budget.context(ctx.budget.request.clone()));
            let scope=digest(current.auth(),"agent-calls")?;
            let cursor:Option<Cursor>=page.continuation().map(parse).transpose()?;
            if cursor.as_ref().is_some_and(|v|v.version!=1 || v.scope!=scope){return Err(invalid(ValidationReason::CursorStale));}
            let started=cursor.as_ref().map_or(i64::MIN,|c|c.started);let last=cursor.as_ref().map_or("",|c|c.last.as_str());
            let rows=rows!(tx.inner_mut(),AgentCallsRow,fetch_all,"SELECT * FROM agent_calls WHERE owner_id=$1 AND (started_at>$2 OR (started_at=$2 AND call_id>$3)) ORDER BY started_at,call_id LIMIT $4","SELECT * FROM v1_control.agent_calls WHERE owner_id=$1 AND (started_at>$2 OR (started_at=$2 AND call_id COLLATE \"C\">$3)) ORDER BY started_at,call_id COLLATE \"C\" LIMIT $4";current.auth().principal().as_str(),started,last,i64::from(page.limit())+1)?;
            Ok((current, scope, rows))
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.finish(), CommitEffect::NotCommitted).await?;
        budget
            .run(
                async {
                    let has_more = rows.len() > usize::from(page.limit());
                    let mut items = Vec::new();
                    for row in rows.into_iter().take(usize::from(page.limit())) {
                        items.push(self.call_info(&current, row, None).await?);
                    }
                    let continuation = if has_more {
                        let last = items.last().expect("positive page");
                        Some(json(&Cursor {
                            version: 1,
                            scope,
                            started: last.started_at_ms,
                            last: last.start.call.clone(),
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
}
