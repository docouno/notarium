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
    async fn context_bundle_info(
        &self,
        tx: &mut Transaction,
        ctx: &AccountContext,
        row: ContextSetsRow,
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
        let current = self.catalog_space(ctx, &home).await?;
        if current.space.kind == SpaceKind::Personal
            && row.owner_id != ctx.auth().principal().as_str()
        {
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
        let mut visible = Vec::new();
        let mut unavailable = 0;
        for note in notes(&row)? {
            match self.catalog_note(ctx, &note).await {
                Ok(_) => visible.push(note),
                Err(error) if hidden(&error) => unavailable += 1,
                Err(error) => return Err(error),
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
        let mut tx = self.store.write(budget.clone()).await?;
        let result = budget
            .run(
                async {
                    let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
                    let row = bundle(tx.inner_mut(), &id, false)
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                    self.context_bundle_info(
                        tx.inner_mut(),
                        &AccountContext::new(auth, budget.context(ctx.budget.request.clone())),
                        row,
                    )
                    .await
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(result)
    }
    pub async fn list_context_sets(
        &self,
        ctx: AccountContext,
        home: SpaceId,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ContextSetInfo>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let result = budget.run(async {
            let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
            let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
            self.catalog_space(&current, &home).await?;
            let scope = self.context_digest(tx.inner_mut(), &current, ("context-sets", &home)).await?;
            let cursor: Option<Cursor> = page.continuation().map(|value| serde_json::from_str(value).map_err(|_| invalid(ValidationReason::InvalidQuery))).transpose()?;
            if cursor.as_ref().is_some_and(|cursor| cursor.version != 1 || cursor.scope != scope) { return Err(invalid(ValidationReason::CursorStale)); }
            let after = cursor.as_ref().map_or("", |cursor| cursor.last.as_str());
            let mut values = rows!(tx.inner_mut(),ContextSetsRow,fetch_all,"SELECT * FROM context_sets WHERE home_space=$1 AND set_id>$2 ORDER BY set_id LIMIT $3","SELECT * FROM v1_control.context_sets WHERE home_space=$1 AND set_id>$2 ORDER BY set_id LIMIT $3";home.as_str(),after,i64::from(page.limit())+1)?;
            let continuation = if values.len() > usize::from(page.limit()) {
                values.pop(); Some(serde_json::to_string(&Cursor { version: 1, scope, last: ContextSetId::parse(&values.last().expect("positive page limit").set_id)? }).map_err(|_| invalid(ValidationReason::InvalidState))?)
            } else { None };
            let mut items = Vec::with_capacity(values.len());
            for row in values {
                match self.context_bundle_info(tx.inner_mut(), &current, row).await {
                    Ok(value) => items.push(value), Err(error) if hidden(&error) => (), Err(error) => return Err(error),
                }
            }
            Ok(ControlPage { items, continuation })
        }, CommitEffect::NotCommitted).await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(result)
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
        let budget = OperationBudget::new(ctx.budget.clone());
        let observed = self
            .observe_context_attachments(&budget, &request.input.id)
            .await?;
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, value) = budget.run(async {
            let owner = self.context_manager(tx.inner_mut(), &ctx).await?;
            if let Some((revision, saved)) = command.replay::<ContextSetId>(tx.inner_mut()).await? {
                let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
                let row = bundle(tx.inner_mut(), &saved.value, false).await?.ok_or(DomainError::ResourceNotFound)?;
                return Ok((revision, self.context_bundle_info(tx.inner_mut(), &AccountContext::new(auth, budget.context(ctx.budget.request.clone())), row).await?));
            }
            expect_revision(&owner, command.identity.expected)?;
            let mut spaces = BTreeMap::from([(request.input.home.clone(), true)]);
            for row in &observed { spaces.insert(SpaceId::parse(&row.target_space)?, true); }
            let mut required = BTreeMap::from([(request.input.home.clone(), true)]);
            for note in &request.input.notes { spaces.entry(note.space_id.clone()).or_insert(false); required.entry(note.space_id.clone()).or_insert(false); }
            self.context_write_spaces(tx.inner_mut(), &ctx, &owner, &required, &spaces).await?;
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
            for note in &request.input.notes { self.catalog_note(&ctx, note).await?; }
            let row = ContextSetsRow { set_id: request.input.id.to_string(), owner_id: old.as_ref().map_or_else(|| owner.user_id.clone(), |row| row.owner_id.clone()), home_space: request.input.home.to_string(), name: request.input.name.clone(), note_refs: encoded.clone(), revision: next(old.as_ref().map_or(0, |row| row.revision))?, created_at: old.as_ref().map_or(self.clock.now_ms()?, |row| row.created_at) };
            let record = TargetRecord::ContextSets(row.clone()); record.validate()?;
            if old.is_none() { record.insert(tx.inner_mut()).await?; }
            else { execute!(tx.inner_mut(),"UPDATE context_sets SET name=$1,note_refs=$2,revision=$3 WHERE set_id=$4","UPDATE v1_control.context_sets SET name=$1,note_refs=$2,revision=$3 WHERE set_id=$4";&row.name,&row.note_refs,row.revision,&row.set_id)?; }
            let revision = self.bump_context_spaces(tx.inner_mut(), &owner, &spaces).await?;
            command.save(tx.inner_mut(), revision, &SavedResult { value: request.input.id.clone(), events: vec![] }, self.clock.now_ms()?).await?;
            Ok((revision, self.context_bundle_info(tx.inner_mut(), &ctx, row).await?))
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit { revision, value })
    }
    pub async fn delete_context_set(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteContextSet>,
    ) -> Result<ControlCommit<()>, PortError> {
        let command = Command::new(request.identity, "delete-context-set", &request.input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let observed = self
            .observe_context_attachments(&budget, &request.input.id)
            .await?;
        let observed_home = budget.run(async { read_rows!(&self.store.backend,ContextSetsRow,fetch_optional,"SELECT * FROM context_sets WHERE set_id=$1","SELECT * FROM v1_control.context_sets WHERE set_id=$1";request.input.id.as_str()) }, CommitEffect::NotCommitted).await?;
        let mut tx = self.store.write(budget.clone()).await?;
        let revision = budget.run(async {
            let owner = self.context_manager(tx.inner_mut(), &ctx).await?;
            if let Some((revision, _)) = command.replay::<()>(tx.inner_mut()).await? { return Ok(revision); }
            expect_revision(&owner, command.identity.expected)?;
            let home = SpaceId::parse(&observed_home.as_ref().ok_or(DomainError::ResourceNotFound)?.home_space)?;
            let mut spaces = BTreeMap::from([(home.clone(), true)]);
            for row in &observed { spaces.insert(SpaceId::parse(&row.target_space)?, true); }
            self.context_write_spaces(tx.inner_mut(), &ctx, &owner, &BTreeMap::from([(home.clone(), true)]), &spaces).await?;
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
