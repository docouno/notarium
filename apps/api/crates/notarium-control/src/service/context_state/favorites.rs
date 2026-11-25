use super::*;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    scope: ContentDigest,
    rank: i64,
    space: SpaceId,
    kind: String,
    entity: String,
}
fn reference(row: &FavoritesRow) -> Result<FavoriteRef, PortError> {
    let space_id = SpaceId::parse(&row.space_id)?;
    match row.entity_kind.as_str() {
        "note" => Ok(FavoriteRef::Note(NoteRef {
            space_id,
            note_id: NoteId::parse(&row.entity_id)?,
        })),
        "folder" => Ok(FavoriteRef::Folder(FolderRef {
            space_id,
            folder_id: FolderId::parse(&row.entity_id)?,
        })),
        _ => Err(invalid(ValidationReason::InvalidState)),
    }
}
impl ControlService {
    pub(super) async fn favorite_visible(
        &self,
        ctx: &AccountContext,
        reference: &FavoriteRef,
    ) -> Result<(), PortError> {
        match reference {
            FavoriteRef::Note(note) => {
                self.catalog_note(ctx, note).await?;
            }
            FavoriteRef::Folder(folder) => {
                self.catalog_folder(ctx, folder).await?;
            }
        }
        Ok(())
    }
    pub async fn set_favorite(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetFavorite>,
    ) -> Result<ControlCommit<()>, PortError> {
        let command = Command::new(request.identity, "set-favorite", &request.input)?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        ctx.auth().authorize_human_management()?;
        require_unpinned_human(ctx.auth())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let visible_precheck = if request.input.saved {
            let current = self.current_account(&ctx, &budget).await?;
            Some(
                budget
                    .run(
                        self.favorite_visible(&current, &request.input.reference),
                        CommitEffect::NotCommitted,
                    )
                    .await,
            )
        } else {
            None
        };
        let mut tx = self.store.write(budget.clone()).await?;
        let revision = budget.run(async {
            let auth = self.revalidate(tx.inner_mut(), ctx.auth()).await?;
            auth.authorize_human_management()?;
            if let Some((revision, _)) = command.replay::<()>(tx.inner_mut()).await? { return Ok(revision); }
            if let Some(check) = visible_precheck {
                check?;
            }
            let owner = user(tx.inner_mut(), auth.principal().as_str()).await?;
            expect_revision(&owner, command.identity.expected)?;
            let (kind, space, entity) = match &request.input.reference {
                FavoriteRef::Note(note) => ("note", &note.space_id, note.note_id.as_str()),
                FavoriteRef::Folder(folder) => ("folder", &folder.space_id, folder.folder_id.as_str()),
            };
            if request.input.saved {
                let row = FavoritesRow { owner_id: owner.user_id.clone(), space_id: space.to_string(), entity_kind: kind.into(), entity_id: entity.into(), rank: request.input.rank, created_at: self.clock.now_ms()? };
                TargetRecord::from(row.clone()).validate()?;
                execute!(tx.inner_mut(),"INSERT INTO favorites(owner_id,space_id,entity_kind,entity_id,rank,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,space_id,entity_kind,entity_id) DO UPDATE SET rank=excluded.rank",
                    "INSERT INTO v1_control.favorites(owner_id,space_id,entity_kind,entity_id,rank,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,space_id,entity_kind,entity_id) DO UPDATE SET rank=excluded.rank";&owner.user_id,space.as_str(),kind,entity,row.rank,row.created_at)?;
            } else {
                // An owner can remove an unavailable reference without regaining
                // access to its metadata or learning whether its target exists.
                execute!(tx.inner_mut(),"DELETE FROM favorites WHERE owner_id=$1 AND space_id=$2 AND entity_kind=$3 AND entity_id=$4","DELETE FROM v1_control.favorites WHERE owner_id=$1 AND space_id=$2 AND entity_kind=$3 AND entity_id=$4";&owner.user_id,space.as_str(),kind,entity)?;
            }
            let revision = bump_owner(tx.inner_mut(), &owner).await?;
            command.save(tx.inner_mut(), revision, &SavedResult { value: (), events: vec![] }, self.clock.now_ms()?).await?;
            Ok(revision)
        }, CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        Ok(ControlCommit {
            revision,
            value: (),
        })
    }
    pub async fn list_favorites(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> Result<ControlPage<FavoriteInfo>, PortError> {
        const MAX_SCAN: usize = 4096;
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut tx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let current = AccountContext::new(auth, budget.context(ctx.budget.request.clone()));
        let init_result = budget
            .run(
                async {
                    let scope = self
                        .context_digest(tx.inner_mut(), &current, "favorites")
                        .await?;
                    let cursor: Option<Cursor> = page
                        .continuation()
                        .map(|value| {
                            serde_json::from_str(value)
                                .map_err(|_| invalid(ValidationReason::InvalidQuery))
                        })
                        .transpose()?;
                    if cursor.as_ref().is_some_and(|cursor| {
                        cursor.version != 1
                            || cursor.scope != scope
                            || !matches!(cursor.kind.as_str(), "note" | "folder")
                    }) {
                        return Err(invalid(ValidationReason::CursorStale));
                    }
                    Ok::<_, PortError>((scope, cursor))
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        let (scope, mut after) = init_result?;
        let target = usize::from(page.limit());
        let batch_limit = i64::from(page.limit()).saturating_add(1).max(16);
        let mut items = Vec::with_capacity(target);
        let mut last_visible: Option<Cursor> = None;
        let mut has_more = false;
        let mut scanned = 0usize;
        loop {
            let mut tx = self.store.read(budget.clone()).await?;
            let batch_result = budget
                .run(
                    async {
                        let rows = match &after {
                            None => rows!(
                                tx.inner_mut(),
                                FavoritesRow,
                                fetch_all,
                                "SELECT * FROM favorites WHERE owner_id=$1 ORDER BY rank,space_id,entity_kind,entity_id LIMIT $2",
                                "SELECT * FROM v1_control.favorites WHERE owner_id=$1 ORDER BY rank,space_id,entity_kind,entity_id LIMIT $2";
                                current.auth().principal().as_str(),
                                batch_limit
                            )?,
                            Some(cursor) => rows!(
                                tx.inner_mut(),
                                FavoritesRow,
                                fetch_all,
                                "SELECT * FROM favorites WHERE owner_id=$1 AND (rank,space_id,entity_kind,entity_id)>($2,$3,$4,$5) ORDER BY rank,space_id,entity_kind,entity_id LIMIT $6",
                                "SELECT * FROM v1_control.favorites WHERE owner_id=$1 AND (rank,space_id,entity_kind,entity_id)>($2,$3,$4,$5) ORDER BY rank,space_id,entity_kind,entity_id LIMIT $6";
                                current.auth().principal().as_str(),
                                cursor.rank,
                                cursor.space.as_str(),
                                &cursor.kind,
                                &cursor.entity,
                                batch_limit
                            )?,
                        };
                        Ok::<_, PortError>(rows)
                    },
                    CommitEffect::NotCommitted,
                )
                .await;
            budget
                .run(tx.rollback(), CommitEffect::NotCommitted)
                .await?;
            let batch = batch_result?;
            let batch_len = batch.len();
            for row in batch {
                scanned = scanned.saturating_add(1);
                let space = SpaceId::parse(&row.space_id)?;
                let row_cursor = Cursor {
                    version: 1,
                    scope,
                    rank: row.rank,
                    space: space.clone(),
                    kind: row.entity_kind.clone(),
                    entity: row.entity_id.clone(),
                };
                after = Some(Cursor {
                    version: 1,
                    scope,
                    rank: row_cursor.rank,
                    space: row_cursor.space.clone(),
                    kind: row_cursor.kind.clone(),
                    entity: row_cursor.entity.clone(),
                });
                if current
                    .auth()
                    .spaces()
                    .get(&space)
                    .is_none_or(|grant| grant.read_classes.is_empty())
                {
                    continue;
                }
                let reference = reference(&row)?;
                let visible = budget
                    .run(
                        async {
                            match self.favorite_visible(&current, &reference).await {
                                Ok(()) => Ok(true),
                                Err(error) if hidden(&error) => Ok(false),
                                Err(error) => Err(error),
                            }
                        },
                        CommitEffect::NotCommitted,
                    )
                    .await?;
                if !visible {
                    continue;
                }
                if items.len() == target {
                    has_more = true;
                    break;
                }
                items.push(FavoriteInfo {
                    reference,
                    rank: row.rank,
                });
                last_visible = Some(row_cursor);
            }
            if has_more || batch_len < usize::try_from(batch_limit).unwrap_or(usize::MAX) {
                break;
            }
            if scanned >= MAX_SCAN {
                return Err(invalid(ValidationReason::BudgetExceeded));
            }
        }
        let continuation = if has_more {
            let last = last_visible.expect("positive page limit");
            Some(
                serde_json::to_string(&last)
                    .map_err(|_| invalid(ValidationReason::InvalidState))?,
            )
        } else {
            None
        };
        Ok(ControlPage {
            items,
            continuation,
        })
    }
}
