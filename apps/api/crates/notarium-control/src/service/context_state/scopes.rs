use super::*;

enum Change {
    Attachment(ContextSetId, ControlRevision, bool),
    Pin(NoteRef, bool),
    Order(Vec<ContextRank>),
}
fn entry_key(entry: &ContextEntry) -> Result<(&'static str, String), PortError> {
    match entry {
        ContextEntry::Set(id) => Ok(("set", id.to_string())),
        ContextEntry::Note(note) => Ok((
            "note",
            serde_json::to_string(note).map_err(|_| invalid(ValidationReason::InvalidState))?,
        )),
    }
}
impl ControlService {
    pub async fn set_context_attachment(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetContextAttachment>,
    ) -> Result<ControlCommit<ContextScopeInfo>, PortError> {
        let command = Command::new(request.identity, "set-context-attachment", &request.input)?;
        self.mutate_context_scope(
            ctx,
            command,
            request.input.scope,
            request.input.expected,
            Change::Attachment(
                request.input.set,
                request.input.set_revision,
                request.input.attached,
            ),
        )
        .await
    }
    pub async fn set_context_pin(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetContextPin>,
    ) -> Result<ControlCommit<ContextScopeInfo>, PortError> {
        let command = Command::new(request.identity, "set-context-pin", &request.input)?;
        self.mutate_context_scope(
            ctx,
            command,
            request.input.scope,
            request.input.expected,
            Change::Pin(request.input.note, request.input.pinned),
        )
        .await
    }
    pub async fn set_context_order(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetContextOrder>,
    ) -> Result<ControlCommit<ContextScopeInfo>, PortError> {
        if request.input.entries.len() > 200 {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let mut seen = std::collections::BTreeSet::new();
        for entry in &request.input.entries {
            let (kind, reference) = entry_key(&entry.entry)?;
            if !seen.insert((kind, reference)) {
                return Err(invalid(ValidationReason::InvalidQuery));
            }
        }
        let command = Command::new(request.identity, "set-context-order", &request.input)?;
        self.mutate_context_scope(
            ctx,
            command,
            request.input.scope,
            request.input.expected,
            Change::Order(request.input.entries),
        )
        .await
    }
    async fn mutate_context_scope(
        &self,
        ctx: AccountContext,
        command: Command,
        scope: ContextScope,
        expected: ControlRevision,
        change: Change,
    ) -> Result<ControlCommit<ContextScopeInfo>, PortError> {
        Box::pin(self.mutate_context_scope_inner(ctx, command, scope, expected, change)).await
    }

    async fn mutate_context_scope_inner(
        &self,
        ctx: AccountContext,
        command: Command,
        scope: ContextScope,
        expected: ControlRevision,
        change: Change,
    ) -> Result<ControlCommit<ContextScopeInfo>, PortError> {
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        ctx.auth().authorize_human_management()?;
        require_unpinned_human(ctx.auth())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let (pre_key, home, order_sets_precheck, space_kinds_precheck) = {
            let (mut rtx, auth) = self
                .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
                .await?;
            let (current, owner, home, order_sets) = budget
                .run(
                    async {
                        let owner = user_read(rtx.inner_mut(), auth.principal().as_str()).await?;
                        let current =
                            AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
                        let home = if let Change::Attachment(id, _, true) = &change {
                            sets::bundle(rtx.inner_mut(), id, false)
                                .await?
                                .map(|row| SpaceId::parse(&row.home_space))
                                .transpose()?
                                .filter(|space| {
                                    current
                                        .auth()
                                        .spaces()
                                        .get(space)
                                        .is_some_and(|grant| !grant.read_classes.is_empty())
                                })
                        } else {
                            None
                        };
                        let order_sets: Result<
                            BTreeMap<ContextSetId, (SpaceId, String)>,
                            PortError,
                        > = if let Change::Order(entries) = &change {
                            let mut map = BTreeMap::new();
                            let mut check = Ok(());
                            for entry in entries {
                                if let ContextEntry::Set(id) = &entry.entry {
                                    let Some(row) =
                                        sets::bundle(rtx.inner_mut(), id, false).await?
                                    else {
                                        check = Err(DomainError::ResourceNotFound.into());
                                        break;
                                    };
                                    if let Err(err) = self
                                        .check_bundle_attachment_db(rtx.inner_mut(), &current, &row)
                                        .await
                                    {
                                        check = Err(err);
                                        break;
                                    }
                                    let home_space = SpaceId::parse(&row.home_space)?;
                                    map.insert(id.clone(), (home_space, row.owner_id));
                                }
                            }
                            check.map(|()| map)
                        } else {
                            Ok(BTreeMap::new())
                        };
                        Ok((current, owner, home, order_sets))
                    },
                    CommitEffect::NotCommitted,
                )
                .await?;
            budget
                .run(rtx.rollback(), CommitEffect::NotCommitted)
                .await?;
            let key = scope_key(&owner, &scope)?;
            let mut spaces = BTreeMap::from([(key.space.clone(), true)]);
            if let Some(home) = &home {
                spaces.entry(home.clone()).or_insert(false);
            }
            let mut order_sets_out: Option<BTreeMap<ContextSetId, (SpaceId, String)>> = None;
            let precheck: Result<BTreeMap<SpaceId, SpaceKind>, PortError> = async {
                if let Change::Pin(note, true) = &change {
                    spaces.entry(note.space_id.clone()).or_insert(false);
                    budget
                        .run(
                            self.catalog_note(&current, note),
                            CommitEffect::NotCommitted,
                        )
                        .await?;
                }
                budget
                    .run(
                        self.context_scope_read(&current, &scope, &key),
                        CommitEffect::NotCommitted,
                    )
                    .await?;
                if let Change::Order(entries) = &change {
                    let sets_map = order_sets?;
                    let mut set_home_kinds: BTreeMap<SpaceId, SpaceKind> = BTreeMap::new();
                    for (home_space, set_owner) in sets_map.values() {
                        let kind = if let Some(&k) = set_home_kinds.get(home_space) {
                            k
                        } else {
                            let info = budget
                                .run(
                                    self.catalog_space(&current, home_space),
                                    CommitEffect::NotCommitted,
                                )
                                .await?;
                            set_home_kinds.insert(home_space.clone(), info.space.kind);
                            info.space.kind
                        };
                        if kind == SpaceKind::Personal
                            && set_owner != current.auth().principal().as_str()
                        {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                    }
                    for entry in entries {
                        if let ContextEntry::Note(note) = &entry.entry {
                            budget
                                .run(
                                    self.catalog_note(&current, note),
                                    CommitEffect::NotCommitted,
                                )
                                .await?;
                        }
                    }
                    order_sets_out = Some(sets_map);
                }
                budget
                    .run(
                        self.context_precheck_spaces(&current, &spaces),
                        CommitEffect::NotCommitted,
                    )
                    .await
            }
            .await;
            (key, home, order_sets_out, precheck)
        };
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision, saved) = budget.run(async {
            let owner = self.context_manager(tx.inner_mut(), &ctx).await?;
            if let Some(replay) = command.replay::<ContextScopeInfo>(tx.inner_mut()).await? {
                let _ = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
                return Ok(replay);
            }
            let key = scope_key(&owner, &scope)?;
            if key != pre_key {
                return Err(invalid(ValidationReason::CursorStale));
            }
            let space_kinds = space_kinds_precheck?;
            expect_revision(&owner, command.identity.expected)?;
            let mut spaces = BTreeMap::from([(key.space.clone(), true)]);
            if let Some(home) = &home { spaces.entry(home.clone()).or_insert(false); }
            if let Change::Pin(note, true) = &change { spaces.entry(note.space_id.clone()).or_insert(false); }
            self.context_write_spaces(tx.inner_mut(), &ctx, &owner, &spaces, &spaces, &space_kinds).await?;
            let previous = self.context_scope_revision(tx.inner_mut(), &owner, &key).await?;
            if previous != expected { return Err(DomainError::ControlRevisionConflict { current: previous }.into()); }
            let changed = previous.checked_next()?;
            match change {
                Change::Attachment(id, expected_set, attached) => {
                    let old = rows!(tx.inner_mut(),ContextSetAttachmentsRow,fetch_optional,"SELECT * FROM context_set_attachments WHERE set_id=$1 AND target_kind=$2 AND target_id=$3","SELECT * FROM v1_control.context_set_attachments WHERE set_id=$1 AND target_kind=$2 AND target_id=$3";id.as_str(),&key.kind,&key.id)?;
                    if attached {
                        let expected_home = home.as_ref().ok_or(DomainError::ResourceNotFound)?;
                        let row = sets::bundle(tx.inner_mut(), &id, true).await?.ok_or(DomainError::ResourceNotFound)?;
                        if expected_home.as_str() != row.home_space { return Err(invalid(ValidationReason::CursorStale)); }
                        if row.revision as u64 != expected_set.get() { return Err(DomainError::ControlRevisionConflict { current: ControlRevision::new(row.revision as u64)? }.into()); }
                        if old.is_none() {
                            if sets::attachments(tx.inner_mut(), &id).await?.len() >= 64 { return Err(invalid(ValidationReason::BudgetExceeded)); }
                            let record = TargetRecord::from(ContextSetAttachmentsRow { set_id: id.to_string(), target_kind: key.kind.clone(), target_id: key.id.clone(), target_space: key.space.to_string(), owner_id: owner.user_id.clone(), revision: changed.get() as i64 });
                            record.validate()?; record.insert(tx.inner_mut()).await?;
                        }
                    } else {
                        // No source metadata is disclosed or required to remove
                        // an unavailable bundle from an authorized target.
                        sets::bundle(tx.inner_mut(), &id, true).await?;
                        execute!(tx.inner_mut(),"DELETE FROM context_set_attachments WHERE set_id=$1 AND target_kind=$2 AND target_id=$3","DELETE FROM v1_control.context_set_attachments WHERE set_id=$1 AND target_kind=$2 AND target_id=$3";id.as_str(),&key.kind,&key.id)?;
                        execute!(tx.inner_mut(),"DELETE FROM context_order WHERE target_kind=$1 AND target_id=$2 AND entry_kind='set' AND entry_ref=$3","DELETE FROM v1_control.context_order WHERE target_kind=$1 AND target_id=$2 AND entry_kind='set' AND entry_ref=$3";&key.kind,&key.id,id.as_str())?;
                    }
                },
                Change::Pin(note, pinned) => {
                    if pinned {
                        let existing = rows!(tx.inner_mut(),ContextScopePinsRow,fetch_optional,"SELECT * FROM context_scope_pins WHERE target_kind=$1 AND target_id=$2 AND note_space=$3 AND note_id=$4","SELECT * FROM v1_control.context_scope_pins WHERE target_kind=$1 AND target_id=$2 AND note_space=$3 AND note_id=$4";&key.kind,&key.id,note.space_id.as_str(),note.note_id.as_str())?;
                        if existing.is_none() {
                            let record = TargetRecord::from(ContextScopePinsRow { owner_id: owner.user_id.clone(), target_kind: key.kind.clone(), target_id: key.id.clone(), target_space: key.space.to_string(), note_space: note.space_id.to_string(), note_id: note.note_id.to_string(), revision: changed.get() as i64, created_at: self.clock.now_ms()? });
                            record.validate()?; record.insert(tx.inner_mut()).await?;
                        }
                    } else {
                        execute!(tx.inner_mut(),"DELETE FROM context_scope_pins WHERE target_kind=$1 AND target_id=$2 AND note_space=$3 AND note_id=$4","DELETE FROM v1_control.context_scope_pins WHERE target_kind=$1 AND target_id=$2 AND note_space=$3 AND note_id=$4";&key.kind,&key.id,note.space_id.as_str(),note.note_id.as_str())?;
                        let (_, reference) = entry_key(&ContextEntry::Note(note))?;
                        execute!(tx.inner_mut(),"DELETE FROM context_order WHERE target_kind=$1 AND target_id=$2 AND entry_kind='note' AND entry_ref=$3","DELETE FROM v1_control.context_order WHERE target_kind=$1 AND target_id=$2 AND entry_kind='note' AND entry_ref=$3";&key.kind,&key.id,&reference)?;
                    }
                },
                Change::Order(entries) => {
                    let pre_sets = order_sets_precheck.unwrap_or_default();
                    let mut seen = std::collections::BTreeSet::new();
                    for entry in entries {
                        let (kind, reference) = entry_key(&entry.entry)?;
                        if !seen.insert((kind, reference.clone())) { return Err(invalid(ValidationReason::InvalidQuery)); }
                        let exists = match &entry.entry {
                            ContextEntry::Set(id) => {
                                let row = sets::bundle(tx.inner_mut(), id, false).await?.ok_or(DomainError::ResourceNotFound)?;
                                self.check_bundle_attachment_db(tx.inner_mut(), &ctx, &row).await?;
                                let Some((pre_home, pre_owner)) = pre_sets.get(id) else {
                                    return Err(DomainError::ResourceNotFound.into());
                                };
                                if pre_home.as_str() != row.home_space || pre_owner != &row.owner_id {
                                    return Err(invalid(ValidationReason::CursorStale));
                                }
                                rows!(tx.inner_mut(),ContextSetAttachmentsRow,fetch_optional,"SELECT * FROM context_set_attachments WHERE set_id=$1 AND target_kind=$2 AND target_id=$3","SELECT * FROM v1_control.context_set_attachments WHERE set_id=$1 AND target_kind=$2 AND target_id=$3";id.as_str(),&key.kind,&key.id)?.is_some()
                            }
                            ContextEntry::Note(note) => {
                                if ctx.auth().spaces().get(&note.space_id).is_none_or(|g| g.read_classes.is_empty()) {
                                    return Err(DomainError::ResourceNotFound.into());
                                }
                                rows!(tx.inner_mut(),ContextScopePinsRow,fetch_optional,"SELECT * FROM context_scope_pins WHERE target_kind=$1 AND target_id=$2 AND note_space=$3 AND note_id=$4","SELECT * FROM v1_control.context_scope_pins WHERE target_kind=$1 AND target_id=$2 AND note_space=$3 AND note_id=$4";&key.kind,&key.id,note.space_id.as_str(),note.note_id.as_str())?.is_some()
                            }
                        };
                        if !exists { return Err(DomainError::ResourceNotFound.into()); }
                        execute!(tx.inner_mut(),"DELETE FROM context_order WHERE target_kind=$1 AND target_id=$2 AND entry_kind=$3 AND entry_ref=$4","DELETE FROM v1_control.context_order WHERE target_kind=$1 AND target_id=$2 AND entry_kind=$3 AND entry_ref=$4";&key.kind,&key.id,kind,&reference)?;
                        let record = TargetRecord::from(ContextOrderRow { owner_id: owner.user_id.clone(), target_kind: key.kind.clone(), target_id: key.id.clone(), target_space: key.space.to_string(), entry_kind: kind.into(), entry_ref: reference, rank: entry.rank, revision: changed.get() as i64 });
                        record.validate()?; record.insert(tx.inner_mut()).await?;
                    }
                },
            }
            let revision = self.bump_context_spaces(tx.inner_mut(), &owner, &spaces).await?;
            let saved = SavedResult { value: ContextScopeInfo { scope, revision: changed }, events: vec![] };
            command.save(tx.inner_mut(), revision, &saved, self.clock.now_ms()?).await?;
            Ok((revision, saved))
        }, CommitEffect::NotCommitted).await?;
        budget.run_commit(tx.commit()).await?;
        Ok(ControlCommit {
            revision,
            value: saved.value,
        })
    }
}
