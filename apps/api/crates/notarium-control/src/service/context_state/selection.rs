use super::*;

struct Candidate {
    position: i64,
    note_space: String,
    note_id: String,
    favorite: i64,
}
#[derive(sqlx::FromRow)]
struct PinCandidateRow {
    rank: i64,
    note_space: String,
    note_id: String,
}
#[derive(sqlx::FromRow)]
struct SetCandidateRow {
    rank: i64,
    set_id: String,
    note_refs: String,
}
#[derive(sqlx::FromRow)]
struct FavoriteCandidateRow {
    rank: i64,
    space_id: String,
    entity_id: String,
}
#[derive(Eq, PartialEq, Ord, PartialOrd)]
struct ScopeItem {
    level: i64,
    rank: i64,
    entry: String,
    item_index: usize,
    note_space: String,
    note_id: String,
}
async fn load_bootstrap_candidates(
    tx: &mut Transaction,
    owner_id: &str,
    project: &str,
    space: &str,
    personal: &str,
    after: i64,
    page_limit: u16,
) -> Result<Vec<Candidate>, PortError> {
    let skip = usize::try_from(after).map_err(|_| invalid(ValidationReason::InvalidQuery))?;
    let want = usize::from(page_limit) + 1;
    let needed = skip
        .checked_add(want)
        .ok_or_else(|| invalid(ValidationReason::InvalidLimit))?;
    let mut targets = Vec::with_capacity(3);
    if !project.is_empty() {
        targets.push((0_i64, "project", project));
    }
    if !space.is_empty() {
        targets.push((1_i64, "space", space));
    }
    if !personal.is_empty() {
        targets.push((2_i64, "personal", personal));
    }
    let mut scope_items = Vec::new();
    for (level, kind, target_id) in targets {
        let pins = rows!(
            tx,
            PinCandidateRow,
            fetch_all,
            "SELECT coalesce(o.rank,0) AS rank, p.note_space, p.note_id FROM context_scope_pins p LEFT JOIN context_order o ON o.target_kind=p.target_kind AND o.target_id=p.target_id AND o.entry_kind='note' AND o.entry_ref=('{\"space_id\":\"' || p.note_space || '\",\"note_id\":\"' || p.note_id || '\"}') WHERE p.target_kind=$1 AND p.target_id=$2",
            "SELECT coalesce(o.rank,0) AS rank, p.note_space, p.note_id FROM v1_control.context_scope_pins p LEFT JOIN v1_control.context_order o ON o.target_kind=p.target_kind AND o.target_id=p.target_id AND o.entry_kind='note' AND o.entry_ref=('{\"space_id\":\"' || p.note_space || '\",\"note_id\":\"' || p.note_id || '\"}') WHERE p.target_kind=$1 AND p.target_id=$2";
            kind,
            target_id
        )?;
        for pin in pins {
            scope_items.push(ScopeItem {
                level,
                rank: pin.rank,
                entry: format!("n:{}:{}", pin.note_space, pin.note_id),
                item_index: 0,
                note_space: pin.note_space,
                note_id: pin.note_id,
            });
        }
        let sets = rows!(
            tx,
            SetCandidateRow,
            fetch_all,
            "SELECT coalesce(o.rank,0) AS rank, a.set_id, s.note_refs FROM context_set_attachments a JOIN context_sets s ON s.set_id=a.set_id LEFT JOIN context_order o ON o.target_kind=a.target_kind AND o.target_id=a.target_id AND o.entry_kind='set' AND o.entry_ref=a.set_id WHERE a.target_kind=$1 AND a.target_id=$2",
            "SELECT coalesce(o.rank,0) AS rank, a.set_id, s.note_refs FROM v1_control.context_set_attachments a JOIN v1_control.context_sets s ON s.set_id=a.set_id LEFT JOIN v1_control.context_order o ON o.target_kind=a.target_kind AND o.target_id=a.target_id AND o.entry_kind='set' AND o.entry_ref=a.set_id WHERE a.target_kind=$1 AND a.target_id=$2";
            kind,
            target_id
        )?;
        for set in sets {
            if set.note_refs.len() > 65536 {
                return Err(invalid(ValidationReason::InvalidState));
            }
            let notes: Vec<NoteRef> = serde_json::from_str(&set.note_refs)
                .map_err(|_| invalid(ValidationReason::InvalidState))?;
            if notes.len() > 200 {
                return Err(invalid(ValidationReason::InvalidState));
            }
            let entry = format!("s:{}", set.set_id);
            for (idx, note) in notes.into_iter().enumerate() {
                scope_items.push(ScopeItem {
                    level,
                    rank: set.rank,
                    entry: entry.clone(),
                    item_index: idx,
                    note_space: note.space_id.to_string(),
                    note_id: note.note_id.to_string(),
                });
            }
        }
    }
    scope_items.sort();
    let mut seen = std::collections::BTreeSet::new();
    let mut deduped: Vec<(String, String, i64)> = Vec::new();
    for item in scope_items {
        if seen.insert((item.note_space.clone(), item.note_id.clone())) {
            deduped.push((item.note_space, item.note_id, 0));
        }
    }
    let mut fav_cursor: Option<(i64, String, String)> = None;
    while deduped.len() < needed {
        let batch_limit = ((needed - deduped.len())
            .saturating_add(seen.len())
            .clamp(32, 512)) as i64;
        let favs = match &fav_cursor {
            None => rows!(
                tx,
                FavoriteCandidateRow,
                fetch_all,
                "SELECT rank, space_id, entity_id FROM favorites WHERE owner_id=$1 AND entity_kind='note' ORDER BY rank,space_id,entity_id LIMIT $2",
                "SELECT rank, space_id, entity_id FROM v1_control.favorites WHERE owner_id=$1 AND entity_kind='note' ORDER BY rank,space_id,entity_id LIMIT $2";
                owner_id,
                batch_limit
            )?,
            Some((rank, space_id, entity_id)) => rows!(
                tx,
                FavoriteCandidateRow,
                fetch_all,
                "SELECT rank, space_id, entity_id FROM favorites WHERE owner_id=$1 AND entity_kind='note' AND (rank,space_id,entity_id)>($2,$3,$4) ORDER BY rank,space_id,entity_id LIMIT $5",
                "SELECT rank, space_id, entity_id FROM v1_control.favorites WHERE owner_id=$1 AND entity_kind='note' AND (rank,space_id,entity_id)>($2,$3,$4) ORDER BY rank,space_id,entity_id LIMIT $5";
                owner_id,
                *rank,
                space_id,
                entity_id,
                batch_limit
            )?,
        };
        if favs.is_empty() {
            break;
        }
        let exhausted = (favs.len() as i64) < batch_limit;
        if let Some(last) = favs.last() {
            fav_cursor = Some((last.rank, last.space_id.clone(), last.entity_id.clone()));
        }
        for fav in favs {
            if seen.insert((fav.space_id.clone(), fav.entity_id.clone())) {
                deduped.push((fav.space_id, fav.entity_id, 1));
                if deduped.len() >= needed {
                    break;
                }
            }
        }
        if exhausted {
            break;
        }
    }
    Ok(deduped
        .into_iter()
        .enumerate()
        .skip(skip)
        .take(want)
        .map(|(idx, (note_space, note_id, favorite))| Candidate {
            position: (idx + 1) as i64,
            note_space,
            note_id,
            favorite,
        })
        .collect())
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BootstrapCursor {
    version: u8,
    scope: ContentDigest,
    after: i64,
}
#[derive(sqlx::FromRow, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryRow {
    kind: String,
    space: String,
    entity: String,
    rank: i64,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EntryCursor {
    version: u8,
    scope: ContentDigest,
    last: EntryRow,
}

impl ControlService {
    pub async fn bootstrap_context(
        &self,
        ctx: AccountContext,
        id: EpisodeId,
        space: Option<SpaceId>,
        page: ControlPageRequest,
    ) -> Result<BootstrapContext, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut rtx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let first_db = budget
            .run(
                async {
                    let owner =
                        user_read(rtx.inner_mut(), current.auth().principal().as_str()).await?;
                    let loaded_ep = self.load_episode_db(rtx.inner_mut(), &current, &id).await?;
                    let owner_ack_rows = self
                        .acknowledgement_rows(rtx.inner_mut(), &current, None)
                        .await?;
                    Ok::<_, PortError>((owner, loaded_ep, owner_ack_rows))
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let (owner, loaded_ep, owner_ack_rows) = first_db?;
        let had_project = loaded_ep.row.project_space.is_some();
        let (mut episode, role_to_overlay, selected, personal, owner_acknowledgements) = budget
            .run(
                async {
                    let mut space_cache = std::collections::BTreeMap::new();
                    let (episode, role_to_overlay) = self
                        .resolve_episode_catalog_cached(&current, loaded_ep, &mut space_cache)
                        .await?;
                    let selected = if let Some(space) = space {
                        if current
                            .auth()
                            .spaces()
                            .get(&space)
                            .is_none_or(|grant| grant.read_classes.is_empty())
                        {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        if !matches!(space_cache.get(&space), Some(Some(_))) {
                            let info = self.catalog_space(&current, &space).await?;
                            space_cache.insert(space.clone(), Some(info));
                        }
                        if episode
                            .project_hint
                            .as_ref()
                            .is_some_and(|project| project.space_id != space)
                        {
                            return Err(invalid(ValidationReason::ScopeMismatch));
                        }
                        Some(space)
                    } else if let Some(project) = &episode.project_hint {
                        Some(project.space_id.clone())
                    } else if !had_project {
                        owner
                            .personal_space_id
                            .as_deref()
                            .map(SpaceId::parse)
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
                    if let Some(space) = &selected
                        && !matches!(space_cache.get(space), Some(Some(_)))
                    {
                        let info = self.catalog_space(&current, space).await?;
                        space_cache.insert(space.clone(), Some(info));
                    }
                    let personal = if let Some(value) = &owner.personal_space_id {
                        let space = SpaceId::parse(value)?;
                        if current
                            .auth()
                            .spaces()
                            .get(&space)
                            .is_some_and(|grant| !grant.read_classes.is_empty())
                        {
                            match space_cache.get(&space) {
                                Some(Some(_)) => owner.user_id.clone(),
                                Some(None) => String::new(),
                                None => match self.catalog_space(&current, &space).await {
                                    Ok(info) => {
                                        space_cache.insert(space, Some(info));
                                        owner.user_id.clone()
                                    }
                                    Err(error) if hidden(&error) => {
                                        space_cache.insert(space, None);
                                        String::new()
                                    }
                                    Err(error) => return Err(error),
                                },
                            }
                        } else {
                            String::new()
                        }
                    } else {
                        String::new()
                    };
                    let owner_acknowledgements = self
                        .resolve_acknowledgements_cached(&current, owner_ack_rows, &mut space_cache)
                        .await?;
                    Ok::<_, PortError>((
                        episode,
                        role_to_overlay,
                        selected,
                        personal,
                        owner_acknowledgements,
                    ))
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        let had_overlay_candidate = role_to_overlay.is_some();
        let mut rtx = self.store.read(budget.clone()).await?;
        let second_db = budget
            .run(
                async {
                    let role_enabled = if let Some((reference, raw)) = role_to_overlay {
                        if self
                            .overlay(
                                rtx.inner_mut(),
                                &current,
                                raw,
                                episode.project_hint.as_ref(),
                            )
                            .await?
                            .enabled
                        {
                            Some(reference)
                        } else {
                            None
                        }
                    } else {
                        None
                    };
                    let scope = self
                        .context_digest(
                            rtx.inner_mut(),
                            &current,
                            (
                                "bootstrap",
                                &id,
                                episode.revision,
                                &selected,
                                &episode.project_hint,
                                &personal,
                            ),
                        )
                        .await?;
                    let cursor: Option<BootstrapCursor> = page
                        .continuation()
                        .map(|value| {
                            serde_json::from_str(value)
                                .map_err(|_| invalid(ValidationReason::InvalidQuery))
                        })
                        .transpose()?;
                    if cursor.as_ref().is_some_and(|cursor| {
                        cursor.version != 1 || cursor.scope != scope || cursor.after < 0
                    }) {
                        return Err(invalid(ValidationReason::CursorStale));
                    }
                    let project = episode
                        .project_hint
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(|_| invalid(ValidationReason::InvalidState))?
                        .unwrap_or_default();
                    let space_str = selected.as_ref().map_or("", SpaceId::as_str);
                    let after = cursor.as_ref().map_or(0, |cursor| cursor.after);
                    let mut candidates = load_bootstrap_candidates(
                        rtx.inner_mut(),
                        &owner.user_id,
                        &project,
                        space_str,
                        &personal,
                        after,
                        page.limit(),
                    )
                    .await?;
                    let continuation = if candidates.len() > usize::from(page.limit()) {
                        candidates.pop();
                        Some(
                            serde_json::to_string(&BootstrapCursor {
                                version: 1,
                                scope,
                                after: candidates.last().expect("positive page limit").position,
                            })
                            .map_err(|_| invalid(ValidationReason::InvalidState))?,
                        )
                    } else {
                        None
                    };
                    Ok::<_, PortError>((role_enabled, after, candidates, continuation))
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let (role_enabled, after, candidates, continuation) = second_db?;
        if let Some(reference) = role_enabled {
            episode.active_role = Some(reference);
        } else if had_overlay_candidate {
            episode.diagnostics.push(EpisodeDiagnostic::RoleUnavailable);
        }
        budget
            .run(
                async {
                    let mut pinned = Vec::new();
                    let mut favorites = Vec::new();
                    let mut unavailable = 0;
                    for candidate in candidates {
                        if candidate.position <= after || !matches!(candidate.favorite, 0 | 1) {
                            return Err(invalid(ValidationReason::InvalidState));
                        }
                        let note = NoteRef {
                            space_id: SpaceId::parse(&candidate.note_space)?,
                            note_id: NoteId::parse(&candidate.note_id)?,
                        };
                        match self.catalog_note(&current, &note).await {
                            Ok(_) => {
                                if candidate.favorite == 1 {
                                    favorites.push(note);
                                } else {
                                    pinned.push(note);
                                }
                            }
                            Err(error) if hidden(&error) => unavailable += 1,
                            Err(error) => return Err(error),
                        }
                    }
                    let readable_spaces = current
                        .auth()
                        .spaces()
                        .iter()
                        .filter(|(_, grant)| !grant.read_classes.is_empty())
                        .map(|(space, _)| space.clone())
                        .collect();
                    Ok(BootstrapContext {
                        episode,
                        selection: ContextSelection {
                            space: selected,
                            pinned,
                            favorites,
                            readable_spaces,
                            unavailable,
                        },
                        owner_acknowledgements,
                        continuation,
                    })
                },
                CommitEffect::NotCommitted,
            )
            .await
    }
    pub async fn list_context_entries(
        &self,
        ctx: AccountContext,
        scope: ContextScope,
        page: ControlPageRequest,
    ) -> Result<ControlPage<ContextEntryInfo>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let db_result = budget
            .run(
                async {
                    let owner =
                        user_read(tx.inner_mut(), current.auth().principal().as_str()).await?;
                    let key = scope_key(&owner, &scope)?;
                    Self::context_scope_grant_ok(current.auth(), &scope, &key)?;
                    let digest = self
                        .context_digest(tx.inner_mut(), &current, ("context-entries", &key))
                        .await?;
                    let cursor: Option<EntryCursor> = page
                        .continuation()
                        .map(|value| {
                            serde_json::from_str(value)
                                .map_err(|_| invalid(ValidationReason::InvalidQuery))
                        })
                        .transpose()?;
                    if cursor.as_ref().is_some_and(|cursor| {
                        cursor.version != 1
                            || cursor.scope != digest
                            || !matches!(cursor.last.kind.as_str(), "note" | "set")
                    }) {
                        return Err(invalid(ValidationReason::CursorStale));
                    }
                    let mut after = cursor.map_or(
                        EntryRow {
                            rank: i64::MIN,
                            kind: String::new(),
                            space: String::new(),
                            entity: String::new(),
                        },
                        |cursor| cursor.last,
                    );
                    let target = usize::from(page.limit());
                    let limit = i64::from(page.limit()) + 1;
                    let mut visible = Vec::with_capacity(target + 1);
                    let mut has_more = false;
                    let mut scanned = 0usize;
                    loop {
                        let batch: Vec<EntryRow> = match tx.inner_mut() {
                            Transaction::Sqlite(tx) => {
                                sqlx::query_as(include_str!("entries.sqlite.sql"))
                                    .bind(&key.kind)
                                    .bind(&key.id)
                                    .bind(after.rank)
                                    .bind(&after.kind)
                                    .bind(&after.space)
                                    .bind(&after.entity)
                                    .bind(limit)
                                    .fetch_all(&mut **tx)
                                    .await
                                    .map_err(crate::error::database)?
                            }
                            Transaction::Postgres(tx) => {
                                sqlx::query_as(include_str!("entries.postgres.sql"))
                                    .bind(&key.kind)
                                    .bind(&key.id)
                                    .bind(after.rank)
                                    .bind(&after.kind)
                                    .bind(&after.space)
                                    .bind(&after.entity)
                                    .bind(limit)
                                    .fetch_all(&mut **tx)
                                    .await
                                    .map_err(crate::error::database)?
                            }
                        };
                        let batch_len = batch.len();
                        for row in batch {
                            scanned = scanned.saturating_add(1);
                            after = EntryRow {
                                kind: row.kind.clone(),
                                space: row.space.clone(),
                                entity: row.entity.clone(),
                                rank: row.rank,
                            };
                            if row.kind == "set" {
                                let set_id = ContextSetId::parse(&row.entity)?;
                                let Some(bundle_row) =
                                    sets::bundle(tx.inner_mut(), &set_id, false).await?
                                else {
                                    continue;
                                };
                                match self
                                    .check_bundle_attachment_db(
                                        tx.inner_mut(),
                                        &current,
                                        &bundle_row,
                                    )
                                    .await
                                {
                                    Ok(()) => (),
                                    Err(error) if hidden(&error) => continue,
                                    Err(error) => return Err(error),
                                }
                            }
                            if visible.len() == target {
                                has_more = true;
                                break;
                            }
                            visible.push(row);
                        }
                        if has_more || batch_len < usize::try_from(limit).unwrap_or(usize::MAX) {
                            break;
                        }
                        if scanned >= 4096 {
                            return Err(invalid(ValidationReason::BudgetExceeded));
                        }
                    }
                    let continuation = if has_more {
                        let last = visible.last().expect("positive page limit");
                        Some(
                            serde_json::to_string(&EntryCursor {
                                version: 1,
                                scope: digest,
                                last: EntryRow {
                                    kind: last.kind.clone(),
                                    space: last.space.clone(),
                                    entity: last.entity.clone(),
                                    rank: last.rank,
                                },
                            })
                            .map_err(|_| invalid(ValidationReason::InvalidState))?,
                        )
                    } else {
                        None
                    };
                    Ok::<_, PortError>((key, visible, continuation))
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        let (key, rows, continuation) = db_result?;
        budget
            .run(
                async {
                    self.context_scope_read(&current, &scope, &key).await?;
                    let mut items = Vec::with_capacity(rows.len());
                    for row in rows {
                        let entry = match row.kind.as_str() {
                            "set" => ContextEntry::Set(ContextSetId::parse(&row.entity)?),
                            "note" => {
                                let note = NoteRef {
                                    space_id: SpaceId::parse(&row.space)?,
                                    note_id: NoteId::parse(&row.entity)?,
                                };
                                match self.catalog_note(&current, &note).await {
                                    Ok(_) => (),
                                    Err(error) if hidden(&error) => continue,
                                    Err(error) => return Err(error),
                                };
                                ContextEntry::Note(note)
                            }
                            _ => return Err(invalid(ValidationReason::InvalidState)),
                        };
                        items.push(ContextEntryInfo {
                            entry,
                            rank: row.rank,
                        });
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
}

impl ContextAdminPort for ControlService {
    fn put_context_set(
        &self,
        ctx: AccountContext,
        request: AccountMutation<PutContextSet>,
    ) -> PortFuture<'_, ControlCommit<ContextSetInfo>> {
        Box::pin(Self::put_context_set(self, ctx, request))
    }
    fn get_context_set(
        &self,
        ctx: AccountContext,
        id: ContextSetId,
    ) -> PortFuture<'_, ContextSetInfo> {
        Box::pin(Self::get_context_set(self, ctx, id))
    }
    fn list_context_sets(
        &self,
        ctx: AccountContext,
        home: SpaceId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ContextSetInfo>> {
        Box::pin(Self::list_context_sets(self, ctx, home, page))
    }
    fn delete_context_set(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteContextSet>,
    ) -> PortFuture<'_, ControlCommit<()>> {
        Box::pin(Self::delete_context_set(self, ctx, request))
    }
    fn context_scope(
        &self,
        ctx: AccountContext,
        scope: ContextScope,
    ) -> PortFuture<'_, ContextScopeInfo> {
        Box::pin(Self::context_scope(self, ctx, scope))
    }
    fn list_context_entries(
        &self,
        ctx: AccountContext,
        scope: ContextScope,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ContextEntryInfo>> {
        Box::pin(Self::list_context_entries(self, ctx, scope, page))
    }
    fn set_context_attachment(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetContextAttachment>,
    ) -> PortFuture<'_, ControlCommit<ContextScopeInfo>> {
        Box::pin(Self::set_context_attachment(self, ctx, request))
    }
    fn set_context_pin(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetContextPin>,
    ) -> PortFuture<'_, ControlCommit<ContextScopeInfo>> {
        Box::pin(Self::set_context_pin(self, ctx, request))
    }
    fn set_context_order(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetContextOrder>,
    ) -> PortFuture<'_, ControlCommit<ContextScopeInfo>> {
        Box::pin(Self::set_context_order(self, ctx, request))
    }
    fn set_favorite(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetFavorite>,
    ) -> PortFuture<'_, ControlCommit<()>> {
        Box::pin(Self::set_favorite(self, ctx, request))
    }
    fn list_favorites(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<FavoriteInfo>> {
        Box::pin(Self::list_favorites(self, ctx, page))
    }
}
