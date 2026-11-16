use super::*;
use crate::store::statements::read_rows;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    scope: ContentDigest,
    last: ContextSetId,
}
fn notes(row: &ContextSetsRow) -> Result<Vec<NoteRef>, PortError> {
    if row.note_refs.len() > 65536 {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let notes: Vec<NoteRef> = serde_json::from_str(&row.note_refs)
        .map_err(|_| invalid(ValidationReason::InvalidState))?;
    if notes.len() > 200 {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(notes)
}
pub(super) async fn bundle(
    tx: &mut Transaction,
    id: &ContextSetId,
    lock: bool,
) -> Result<Option<ContextSetsRow>, PortError> {
    if lock {
        rows!(tx,ContextSetsRow,fetch_optional,"SELECT * FROM context_sets WHERE set_id=$1","SELECT * FROM v1_control.context_sets WHERE set_id=$1 FOR UPDATE";id.as_str())
    } else {
        rows!(tx,ContextSetsRow,fetch_optional,"SELECT * FROM context_sets WHERE set_id=$1","SELECT * FROM v1_control.context_sets WHERE set_id=$1";id.as_str())
    }
}
pub(super) async fn attachments(
    tx: &mut Transaction,
    id: &ContextSetId,
) -> Result<Vec<ContextSetAttachmentsRow>, PortError> {
    let result = rows!(tx,ContextSetAttachmentsRow,fetch_all,"SELECT * FROM context_set_attachments WHERE set_id=$1 ORDER BY target_space,target_kind,target_id LIMIT 65","SELECT * FROM v1_control.context_set_attachments WHERE set_id=$1 ORDER BY target_space,target_kind,target_id LIMIT 65";id.as_str())?;
    if result.len() > 64 {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    Ok(result)
}
fn attachment_keys(values: &[ContextSetAttachmentsRow]) -> Vec<(&str, &str, &str, &str, i64)> {
    values
        .iter()
        .map(|row| {
            (
                row.target_space.as_str(),
                row.target_kind.as_str(),
                row.target_id.as_str(),
                row.owner_id.as_str(),
                row.revision,
            )
        })
        .collect()
}
impl ControlService {
    async fn observe_context_attachments(
        &self,
        budget: &OperationBudget,
        id: &ContextSetId,
    ) -> Result<Vec<ContextSetAttachmentsRow>, PortError> {
        let values = budget.run(async { read_rows!(&self.store.backend,ContextSetAttachmentsRow,fetch_all,
            "SELECT * FROM context_set_attachments WHERE set_id=$1 ORDER BY target_space,target_kind,target_id LIMIT 65",
            "SELECT * FROM v1_control.context_set_attachments WHERE set_id=$1 ORDER BY target_space,target_kind,target_id LIMIT 65";id.as_str()) }, CommitEffect::NotCommitted).await?;
        if values.len() > 64 {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        Ok(values)
    }
    async fn check_bundle_attachment_db(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        row: &ContextSetsRow,
    ) -> Result<(), PortError> {
        let home = SpaceId::parse(&row.home_space)?;
        let grant = ctx
            .auth()
            .spaces()
            .get(&home)
            .ok_or(DomainError::ResourceNotFound)?;
        if grant.read_classes.is_empty() {
            return Err(DomainError::ResourceNotFound.into());
        }
        if let Some(root) = &grant.project_root {
            let target = serde_json::to_string(&FolderRef {
                space_id: home.clone(),
                folder_id: root.clone(),
            })
            .map_err(|_| invalid(ValidationReason::InvalidState))?;
            let allowed = rows!(tx,ContextSetAttachmentsRow,fetch_optional,"SELECT * FROM context_set_attachments WHERE set_id=$1 AND target_kind='project' AND target_id=$2 AND target_space=$3","SELECT * FROM v1_control.context_set_attachments WHERE set_id=$1 AND target_kind='project' AND target_id=$2 AND target_space=$3";&row.set_id,&target,home.as_str())?;
            if allowed.is_none() {
                return Err(DomainError::ResourceNotFound.into());
            }
        }
        Ok(())
    }
    async fn context_bundle_info(
        &self,
        ctx: &AccountContext,
        row: ContextSetsRow,
        preloaded_home: Option<&CatalogSpace>,
        note_cache: &mut BTreeMap<(SpaceId, NoteId), bool>,
    ) -> Result<ContextSetInfo, PortError> {
        let home = SpaceId::parse(&row.home_space)?;
        let grant = ctx
            .auth()
            .spaces()
            .get(&home)
            .ok_or(DomainError::ResourceNotFound)?;
        if grant.read_classes.is_empty() {
            return Err(DomainError::ResourceNotFound.into());
        }
        let kind = if let Some(space) = preloaded_home.filter(|s| s.space.id == home) {
            space.space.kind
        } else {
            self.catalog_space(ctx, &home).await?.space.kind
        };
        if kind == SpaceKind::Personal && row.owner_id != ctx.auth().principal().as_str() {
            return Err(DomainError::ResourceNotFound.into());
        }
        let mut visible = Vec::new();
        let mut unavailable = 0;
        for note in notes(&row)? {
            let key = (note.space_id.clone(), note.note_id.clone());
            let is_visible = if let Some(&cached) = note_cache.get(&key) {
                cached
            } else {
                let checked = match self.catalog_note(ctx, &note).await {
                    Ok(_) => true,
                    Err(error) if hidden(&error) => false,
                    Err(error) => return Err(error),
                };
                note_cache.insert(key, checked);
                checked
            };
            if is_visible {
                visible.push(note);
            } else {
                unavailable += 1;
            }
        }
        Ok(ContextSetInfo {
            id: ContextSetId::parse(&row.set_id)?,
            owner: PrincipalId::parse(&row.owner_id)?,
            home,
            name: row.name,
            notes: visible,
            unavailable,
            revision: ControlRevision::new(row.revision as u64)?,
        })
    }
    pub async fn get_context_set(
        &self,
        ctx: AccountContext,
        id: ContextSetId,
    ) -> Result<ContextSetInfo, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let db_result = budget
            .run(
                async {
                    let row = bundle(tx.inner_mut(), &id, false)
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                    self.check_bundle_attachment_db(tx.inner_mut(), &current, &row)
                        .await?;
                    Ok::<_, PortError>(row)
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        let row = db_result?;
        budget
            .run(
                async {
                    let mut cache = BTreeMap::new();
                    self.context_bundle_info(&current, row, None, &mut cache)
                        .await
                },
                CommitEffect::NotCommitted,
            )
            .await
    }
    pub async fn list_context_sets(
        &self,
        ctx: AccountContext,
        home: SpaceId,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ContextSetInfo>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let db_result = budget.run(async {
            let scope = self.context_digest(tx.inner_mut(), &current, ("context-sets", &home)).await?;
            let cursor: Option<Cursor> = page.continuation().map(|value| serde_json::from_str(value).map_err(|_| invalid(ValidationReason::InvalidQuery))).transpose()?;
            if cursor.as_ref().is_some_and(|cursor| cursor.version != 1 || cursor.scope != scope) { return Err(invalid(ValidationReason::CursorStale)); }
            let after = cursor.as_ref().map_or("", |cursor| cursor.last.as_str());
            let mut values = rows!(tx.inner_mut(),ContextSetsRow,fetch_all,"SELECT * FROM context_sets WHERE home_space=$1 AND set_id>$2 ORDER BY set_id LIMIT $3","SELECT * FROM v1_control.context_sets WHERE home_space=$1 AND set_id>$2 ORDER BY set_id LIMIT $3";home.as_str(),after,i64::from(page.limit())+1)?;
            let continuation = if values.len() > usize::from(page.limit()) {
                values.pop(); Some(serde_json::to_string(&Cursor { version: 1, scope, last: ContextSetId::parse(&values.last().expect("positive page limit").set_id)? }).map_err(|_| invalid(ValidationReason::InvalidState))?)
            } else { None };
            let mut allowed_rows = Vec::with_capacity(values.len());
            for row in values {
                match self.check_bundle_attachment_db(tx.inner_mut(), &current, &row).await {
                    Ok(()) => allowed_rows.push(row),
                    Err(error) if hidden(&error) => (),
                    Err(error) => return Err(error),
                }
            }
            Ok::<_, PortError>((allowed_rows, continuation))
        }, CommitEffect::NotCommitted).await;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        let (allowed_rows, continuation) = db_result?;
        budget
            .run(
                async {
                    let home_space = self.catalog_space(&current, &home).await?;
                    let mut items = Vec::with_capacity(allowed_rows.len());
                    let mut note_cache = BTreeMap::new();
                    for row in allowed_rows {
                        match self
                            .context_bundle_info(&current, row, Some(&home_space), &mut note_cache)
                            .await
                        {
                            Ok(value) => items.push(value),
                            Err(error) if hidden(&error) => (),
                            Err(error) => return Err(error),
                        }
                    }
                    Ok(ControlPage {
                        items,
                        continuation,
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await
    }
    pub async fn put_context_set(
        &self,
        ctx: AccountContext,
        request: AccountMutation<PutContextSet>,
    ) -> Result<ControlCommit<ContextSetInfo>, PortError> {
        if request.input.name.is_empty()
            || request.input.name.chars().count() > 128
            || request.input.name.contains('\0')
            || request.input.notes.len() > 200
        {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let encoded = serde_json::to_string(&request.input.notes)
            .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
        if encoded.len() > 65536 {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let command = Command::new(request.identity, "put-context-set", &request.input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        ctx.auth().authorize_human_management()?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let observed = self
            .observe_context_attachments(&budget, &request.input.id)
            .await?;
        let space_kinds = {
            let current = self.current_account(&ctx, &budget).await?;
            let mut required = BTreeMap::from([(request.input.home.clone(), true)]);
            for note in &request.input.notes {
                required.entry(note.space_id.clone()).or_insert(false);
                budget
                    .run(
                        self.catalog_note(&current, note),
                        CommitEffect::NotCommitted,
                    )
                    .await?;
            }
            budget
                .run(
                    self.context_precheck_spaces(&current, &required),
                    CommitEffect::NotCommitted,
                )
                .await?
        };
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, current_ctx, saved_id) = budget.run(async {
            let owner = self.context_manager(tx.inner_mut(), &ctx).await?;
            if let Some((revision, saved)) = command.replay::<ContextSetId>(tx.inner_mut()).await? {
                let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
                return Ok((revision, AccountContext::new(auth, budget.context(ctx.budget.request.clone())), saved.value));
            }
            expect_revision(&owner, command.identity.expected)?;
            let mut spaces = BTreeMap::from([(request.input.home.clone(), true)]);
            for row in &observed { spaces.insert(SpaceId::parse(&row.target_space)?, true); }
            let mut required = BTreeMap::from([(request.input.home.clone(), true)]);
            for note in &request.input.notes { spaces.entry(note.space_id.clone()).or_insert(false); required.entry(note.space_id.clone()).or_insert(false); }
            self.context_write_spaces(tx.inner_mut(), &ctx, &owner, &required, &spaces, &space_kinds).await?;
            let old = bundle(tx.inner_mut(), &request.input.id, true).await?;
            if old.as_ref().is_some_and(|row| row.home_space != request.input.home.as_str()) { return Err(DomainError::ResourceNotFound.into()); }
            let actual = old.as_ref().map(|row| ControlRevision::new(row.revision as u64)).transpose()?;
            if actual != request.input.expected { return Err(DomainError::ControlRevisionConflict { current: actual.unwrap_or(ControlRevision::ZERO) }.into()); }
            let current_attachments = attachments(tx.inner_mut(), &request.input.id).await?;
            if attachment_keys(&current_attachments) != attachment_keys(&observed) { return Err(invalid(ValidationReason::CursorStale)); }
            for row in &current_attachments {
                let key = ScopeKey { kind: row.target_kind.clone(), id: row.target_id.clone(), space: SpaceId::parse(&row.target_space)? };
                // Editing a referenced bundle invalidates consumer cursors. It
                // does not edit their attachment or acquire their content rights.
                decode_scope(&key, &row.owner_id)?;
            }
            let row = ContextSetsRow { set_id: request.input.id.to_string(), owner_id: old.as_ref().map_or_else(|| owner.user_id.clone(), |row| row.owner_id.clone()), home_space: request.input.home.to_string(), name: request.input.name.clone(), note_refs: encoded.clone(), revision: next(old.as_ref().map_or(0, |row| row.revision))?, created_at: old.as_ref().map_or(self.clock.now_ms()?, |row| row.created_at) };
            let record = TargetRecord::from(row.clone());
            record.validate()?;
            if old.is_none() {
                record.insert_or_conflict(tx.inner_mut()).await?;
            } else { execute!(tx.inner_mut(),"UPDATE context_sets SET name=$1,note_refs=$2,revision=$3 WHERE set_id=$4","UPDATE v1_control.context_sets SET name=$1,note_refs=$2,revision=$3 WHERE set_id=$4";&row.name,&row.note_refs,row.revision,&row.set_id)?; }
            let revision = self.bump_context_spaces(tx.inner_mut(), &owner, &spaces).await?;
            command.save(tx.inner_mut(), revision, &SavedResult { value: request.input.id.clone(), events: vec![] }, self.clock.now_ms()?).await?;
            Ok((revision, ctx.clone(), request.input.id.clone()))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        let mut rtx = self.store.read(budget.clone()).await?;
        let db_result = budget
            .run(
                async {
                    let row = bundle(rtx.inner_mut(), &saved_id, false)
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                    self.check_bundle_attachment_db(rtx.inner_mut(), &current_ctx, &row)
                        .await?;
                    Ok::<_, PortError>(row)
                },
                CommitEffect::Unknown,
            )
            .await;
        budget.run(rtx.rollback(), CommitEffect::Unknown).await?;
        let row = db_result?;
        let value = budget
            .run(
                async {
                    let mut cache = BTreeMap::new();
                    self.context_bundle_info(&current_ctx, row, None, &mut cache)
                        .await
                },
                CommitEffect::Unknown,
            )
            .await?;
        Ok(ControlCommit { revision, value })
    }
    pub async fn delete_context_set(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteContextSet>,
    ) -> Result<ControlCommit<()>, PortError> {
        let command = Command::new(request.identity, "delete-context-set", &request.input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        ctx.auth().authorize_human_management()?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let observed = self
            .observe_context_attachments(&budget, &request.input.id)
            .await?;
        let observed_home = budget.run(async { read_rows!(&self.store.backend,ContextSetsRow,fetch_optional,"SELECT * FROM context_sets WHERE set_id=$1","SELECT * FROM v1_control.context_sets WHERE set_id=$1";request.input.id.as_str()) }, CommitEffect::NotCommitted).await?;
        let space_kinds = if let Some(home_row) = &observed_home {
            let home = SpaceId::parse(&home_row.home_space)?;
            let current = self.current_account(&ctx, &budget).await?;
            budget
                .run(
                    self.context_precheck_spaces(&current, &BTreeMap::from([(home, true)])),
                    CommitEffect::NotCommitted,
                )
                .await?
        } else {
            BTreeMap::new()
        };
        let mut tx = self.store.write(budget.clone()).await?;
        let revision = budget.run(async {
            let owner = self.context_manager(tx.inner_mut(), &ctx).await?;
            if let Some((revision, _)) = command.replay::<()>(tx.inner_mut()).await? { return Ok(revision); }
            expect_revision(&owner, command.identity.expected)?;
            let home = SpaceId::parse(&observed_home.as_ref().ok_or(DomainError::ResourceNotFound)?.home_space)?;
            let mut spaces = BTreeMap::from([(home.clone(), true)]);
            for row in &observed { spaces.insert(SpaceId::parse(&row.target_space)?, true); }
            self.context_write_spaces(tx.inner_mut(), &ctx, &owner, &BTreeMap::from([(home.clone(), true)]), &spaces, &space_kinds).await?;
            let row = bundle(tx.inner_mut(), &request.input.id, true).await?.ok_or(DomainError::ResourceNotFound)?;
            if row.home_space != home.as_str() { return Err(invalid(ValidationReason::CursorStale)); }
            if row.revision as u64 != request.input.expected.get() { return Err(DomainError::ControlRevisionConflict { current: ControlRevision::new(row.revision as u64)? }.into()); }
            let current = attachments(tx.inner_mut(), &request.input.id).await?;
            if attachment_keys(&current) != attachment_keys(&observed) { return Err(invalid(ValidationReason::CursorStale)); }
            for attachment in current {
                let key = ScopeKey { kind: attachment.target_kind, id: attachment.target_id, space: SpaceId::parse(&attachment.target_space)? };
                decode_scope(&key, &attachment.owner_id)?;
                execute!(tx.inner_mut(),"DELETE FROM context_order WHERE target_kind=$1 AND target_id=$2 AND entry_kind='set' AND entry_ref=$3","DELETE FROM v1_control.context_order WHERE target_kind=$1 AND target_id=$2 AND entry_kind='set' AND entry_ref=$3";&key.kind,&key.id,request.input.id.as_str())?;
            }
            execute!(tx.inner_mut(),"DELETE FROM context_sets WHERE set_id=$1","DELETE FROM v1_control.context_sets WHERE set_id=$1";request.input.id.as_str())?;
            let revision = self.bump_context_spaces(tx.inner_mut(), &owner, &spaces).await?;
            command.save(tx.inner_mut(), revision, &SavedResult { value: (), events: vec![] }, self.clock.now_ms()?).await?;
            Ok(revision)
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit {
            revision,
            value: (),
        })
    }
}
