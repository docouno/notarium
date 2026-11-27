use super::{
    ControlService,
    authority::*,
    commands::{Command, SavedResult},
    provisioning::stage_space,
};
use crate::{
    error::{invalid, unavailable},
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    auth::*,
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::HistoryScope,
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
};
use serde::{Deserialize, Serialize};

pub(crate) const WHOAMI_PROVIDER_SQLITE_SQL: &str = "SELECT CAST(1 AS BIGINT) FROM provider_attachments a INDEXED BY attachment_target CROSS JOIN provider_resources r CROSS JOIN provider_models m WHERE r.id=a.resource_id AND m.resource_id=r.id AND a.target_kind='personal' AND a.target_owner=$1 AND a.target_space=$2 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$3) AND r.disabled_at IS NULL AND m.kind='completion' LIMIT 1";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SpaceCursor {
    version: u8,
    scope: ContentDigest,
    last: SpaceId,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatedSpace {
    space: SpaceId,
    operation: RequestId,
}
fn membership_command(
    auth: &EngineAuthContext,
    scope: &HistoryScope,
    request: &MembershipChange,
) -> Result<Command, PortError> {
    let payload = (scope, &request.member, request.role);
    let digest = ContentDigest::from_bytes(
        *blake3::hash(
            &serde_json::to_vec(&payload).map_err(|_| invalid(ValidationReason::InvalidQuery))?,
        )
        .as_bytes(),
    );
    Command::new(
        AccountCommandIdentity {
            owner: auth.principal().clone(),
            actor: auth.principal().clone(),
            key: request.command.clone(),
            hash: digest,
            expected: request.expected,
        },
        "change-membership",
        payload,
    )
}
pub(super) fn expect_space(
    row: &SpaceAdmissionRow,
    expected: ControlRevision,
) -> Result<(), PortError> {
    if row.revision as u64 != expected.get() {
        return Err(DomainError::ControlRevisionConflict {
            current: ControlRevision::new(row.revision as u64)?,
        }
        .into());
    }
    Ok(())
}
pub(super) async fn admission(
    tx: &mut Transaction,
    space: &SpaceId,
    lock: bool,
) -> Result<SpaceAdmissionRow, PortError> {
    let row = if lock {
        rows!(tx,SpaceAdmissionRow,fetch_optional,"SELECT * FROM space_admission WHERE space_id=$1","SELECT * FROM v1_control.space_admission WHERE space_id=$1 FOR UPDATE";space.as_str())?
    } else {
        rows!(tx,SpaceAdmissionRow,fetch_optional,"SELECT * FROM space_admission WHERE space_id=$1","SELECT * FROM v1_control.space_admission WHERE space_id=$1";space.as_str())?
    };
    row.ok_or(DomainError::ResourceNotFound.into())
}
pub(super) async fn admission_revisions(
    tx: &mut Transaction,
    spaces: &[&SpaceId],
) -> Result<Vec<(SpaceId, i64)>, PortError> {
    if spaces.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = spaces.iter().map(|space| space.to_string()).collect();
    let fetched: Vec<(String, i64)> = match tx {
        Transaction::Sqlite(tx) => {
            let encoded =
                serde_json::to_string(&ids).map_err(|_| invalid(ValidationReason::InvalidState))?;
            sqlx::query_as(
                "SELECT space_id, revision FROM space_admission WHERE space_id IN (SELECT value FROM json_each($1))",
            )
            .bind(encoded)
            .fetch_all(&mut **tx)
            .await
            .map_err(crate::error::database_not_committed)?
        }
        Transaction::Postgres(tx) => sqlx::query_as(
            "SELECT space_id, revision FROM v1_control.space_admission WHERE space_id = ANY($1)",
        )
        .bind(&ids)
        .fetch_all(&mut **tx)
        .await
        .map_err(crate::error::database_not_committed)?,
    };
    let map: std::collections::BTreeMap<String, i64> = fetched.into_iter().collect();
    let mut out = Vec::with_capacity(spaces.len());
    for space in spaces {
        let rev = map
            .get(space.as_str())
            .copied()
            .ok_or(DomainError::ResourceNotFound)?;
        out.push(((*space).clone(), rev));
    }
    Ok(out)
}
pub(super) async fn require_owner_read(
    tx: &mut Transaction,
    auth: &EngineAuthContext,
    space: &SpaceId,
) -> Result<(), PortError> {
    if auth.kind() != &PrincipalKind::DirectHuman
        || auth
            .spaces()
            .get(space)
            .is_none_or(|grant| grant.role != SpaceRole::Owner || grant.project_root.is_some())
    {
        return Err(access_denied());
    }
    let member = rows!(tx,SpaceMembersRow,fetch_optional,"SELECT * FROM space_members WHERE space_id=$1 AND user_id=$2","SELECT * FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2";space.as_str(),auth.principal().as_str())?;
    if member.is_none_or(|member| member.role != "owner" || member.admission != "active") {
        return Err(access_denied());
    }
    Ok(())
}
pub(super) async fn require_owner(
    tx: &mut Transaction,
    auth: &EngineAuthContext,
    space: &SpaceId,
) -> Result<(), PortError> {
    auth.authorize_human_management()?;
    require_owner_read(tx, auth, space).await
}
impl ControlService {
    pub async fn admit_space_management(
        &self,
        ctx: AccountContext,
        scope: notarium_core::model::HistoryScope,
    ) -> Result<SpaceContext, PortError> {
        ctx.auth().authorize_human_management()?;
        if ctx.auth().taint().is_tainted() {
            return Err(DomainError::CrossSpaceTainted.into());
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut rtx = self.store.read(budget.clone()).await?;
        let auth = budget
            .run(
                async {
                    let current =
                        user_read(rtx.inner_mut(), ctx.auth().principal().as_str()).await?;
                    self.live_human(rtx.inner_mut(), ctx.auth(), &current)
                        .await?;
                    if ctx.auth().is_space_narrowed()
                        || ctx
                            .auth()
                            .spaces()
                            .values()
                            .any(|grant| grant.project_root.is_some())
                    {
                        let allowed =
                            ctx.auth()
                                .spaces()
                                .get(&scope.space_id)
                                .is_some_and(|grant| {
                                    grant.role == SpaceRole::Owner && grant.project_root.is_none()
                                });
                        if !allowed {
                            return Err(access_denied());
                        }
                    }
                    let member = rows!(
                        rtx.inner_mut(),
                        SpaceMembersRow,
                        fetch_optional,
                        "SELECT * FROM space_members WHERE space_id=$1 AND user_id=$2",
                        "SELECT * FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2";
                        scope.space_id.as_str(),
                        &current.user_id
                    )?
                    .ok_or(DomainError::ResourceNotFound)?;
                    if member.role != "owner" || member.admission != "active" {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let space = admission(rtx.inner_mut(), &scope.space_id, false).await?;
                    if !matches!(space.state.as_str(), "active" | "closing" | "archived") {
                        return Err(access_denied());
                    }
                    let (read_classes, write_classes) = if space.state == "active" {
                        let existing = ctx
                            .auth()
                            .spaces()
                            .get(&scope.space_id)
                            .ok_or_else(access_denied)?;
                        if existing.role != SpaceRole::Owner || existing.project_root.is_some() {
                            return Err(access_denied());
                        }
                        (
                            existing.read_classes.clone(),
                            existing.write_classes.clone(),
                        )
                    } else {
                        if ctx.auth().is_space_narrowed()
                            || ctx
                                .auth()
                                .spaces()
                                .values()
                                .any(|grant| grant.project_root.is_some())
                        {
                            return Err(access_denied());
                        }
                        (Default::default(), Default::default())
                    };
                    let credential = ctx.auth().credential().cloned().ok_or_else(denied)?;
                    let mut spaces = std::collections::BTreeMap::new();
                    spaces.insert(
                        scope.space_id.clone(),
                        SpaceGrant {
                            role: SpaceRole::Owner,
                            read_classes,
                            write_classes,
                            project_root: None,
                        },
                    );
                    Ok(EngineAuthContext::for_human(
                        VerifiedHuman::attest(
                            ctx.auth().principal().clone(),
                            ctx.auth().grant().clone(),
                            spaces,
                            ctx.auth().has_cap(Cap::AbilityWrite),
                        )
                        .with_human_management(ctx.auth().human_management())
                        .with_credential(credential),
                    )
                    .mark_spaces_narrowed())
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let current = budget
            .run(
                self.catalog.space(
                    budget.context(ctx.budget.request.clone()),
                    scope.space_id.clone(),
                ),
                CommitEffect::NotCommitted,
            )
            .await?;
        current.history.check(&scope)?;
        SpaceContext::new(auth, scope, budget.context(ctx.budget.request)).map_err(Into::into)
    }
    pub async fn whoami(&self, ctx: AccountContext) -> Result<PrincipalInfo, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (mut rtx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let metadata = budget.run(async {
            let account = account_info(&user_read(rtx.inner_mut(), auth.principal().as_str()).await?)?;
            let personal_space = account.personal_space.filter(|space| {
                auth.spaces().get(space).is_some_and(|grant| {
                    grant.project_root.is_none() && !grant.read_classes.is_empty()
                })
            });
            // A configuration hint for the caller's visible Personal Space.
            // Model selection still performs disclosure and live admission checks.
            let has_completion_provider = if let Some(space) = &personal_space {
                let now = self.clock.now_ms()?;
                rows!(rtx.inner_mut(),(i64,),fetch_optional,
                    WHOAMI_PROVIDER_SQLITE_SQL,
                    "SELECT CAST(1 AS BIGINT) FROM v1_control.provider_attachments a JOIN v1_control.provider_resources r ON r.id=a.resource_id JOIN v1_control.provider_models m ON m.resource_id=r.id WHERE a.target_kind='personal' AND a.target_owner=$1 AND a.target_space=$2 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$3) AND r.disabled_at IS NULL AND m.kind='completion' LIMIT 1";
                    auth.principal().as_str(),space.as_str(),now)?.is_some()
            } else {
                false
            };
            Ok((account.revision, personal_space, has_completion_provider))
        }, CommitEffect::NotCommitted).await;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let (account_revision, personal_space, has_completion_provider) = metadata?;
        Ok(PrincipalInfo {
            principal: auth.principal().clone(),
            kind: auth.kind().clone(),
            grant: auth.grant().clone(),
            account_revision,
            personal_space,
            has_completion_provider,
        })
    }
    pub async fn list_spaces(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> Result<ControlPage<AccessibleSpace>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (rtx, auth) = self
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let facts: Vec<_> = auth
            .spaces()
            .iter()
            .map(|(id, grant)| {
                (
                    id,
                    grant.role,
                    &grant.read_classes,
                    &grant.write_classes,
                    &grant.project_root,
                )
            })
            .collect();
        let bytes = serde_json::to_vec(&(1, "spaces", auth.principal(), auth.grant(), facts))
            .map_err(|_| invalid(ValidationReason::InvalidState))?;
        let scope = ContentDigest::from_bytes(*blake3::hash(&bytes).as_bytes());
        let cursor: Option<SpaceCursor> = page
            .continuation()
            .map(|value| {
                serde_json::from_str(value).map_err(|_| invalid(ValidationReason::InvalidQuery))
            })
            .transpose()?;
        if cursor
            .as_ref()
            .is_some_and(|cursor| cursor.version != 1 || cursor.scope != scope)
        {
            return Err(invalid(ValidationReason::CursorStale));
        }
        let mut items = Vec::new();
        let mut continuation = None;
        for (id, grant) in auth
            .spaces()
            .iter()
            .filter(|(id, _)| cursor.as_ref().is_none_or(|cursor| *id > &cursor.last))
        {
            if items.len() == usize::from(page.limit()) {
                let last: &AccessibleSpace = items.last().expect("positive page limit");
                continuation = Some(
                    serde_json::to_string(&SpaceCursor {
                        version: 1,
                        scope,
                        last: last.space.id.clone(),
                    })
                    .map_err(|_| invalid(ValidationReason::InvalidState))?,
                );
                break;
            }
            let current = budget
                .run(
                    self.catalog
                        .space(budget.context(ctx.budget.request.clone()), id.clone()),
                    CommitEffect::NotCommitted,
                )
                .await?;
            if current.space.id != *id || current.history.space_id != *id {
                return Err(invalid(ValidationReason::InvalidState));
            }
            if current.space.lifecycle == SpaceLifecycle::Active {
                items.push(AccessibleSpace {
                    space: current.space,
                    slug: current.slug,
                    role: grant.role,
                    history: current.history,
                    last_seq: current.last_seq,
                });
            }
        }
        Ok(ControlPage {
            items,
            continuation,
        })
    }
    pub async fn create_space(
        &self,
        ctx: AccountContext,
        request: AccountMutation<CreateSpace>,
    ) -> Result<ControlCommit<AccessibleSpace>, PortError> {
        if request.input.kind != SpaceKind::Shared
            || request.input.name.is_empty()
            || request.input.name.len() > 256
            || request.input.name.contains('\0')
        {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        let command = Command::new(
            request.identity,
            "create-space",
            (&request.input.id, request.input.kind, &request.input.name),
        )?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision,saved)=budget.run(async {
            let (actor,_)=self.manager(tx.inner_mut(),ctx.auth(),ctx.auth().principal()).await?;
            if let Some(replay)=command.replay::<CreatedSpace>(tx.inner_mut()).await? {return Ok(replay);}
            expect_revision(&actor,command.identity.expected)?;
            let now=self.clock.now_ms()?;
            let space=request.input.id.clone();
            let operation=stage_space(tx.inner_mut(),command.identity.clone(),request.input,now).await?;
            let revision=next(actor.revision)?;
            execute!(tx.inner_mut(),"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&actor.user_id)?;
            let revision=ControlRevision::new(revision as u64)?;
            let saved=SavedResult{value:CreatedSpace{space,operation},events:vec![]};
            command.save(tx.inner_mut(),revision,&saved,now).await?;
            Ok((revision,saved))
        },CommitEffect::NotCommitted).await?;
        budget.commit_tx(tx).await?;
        let current = self
            .finish_space_operation(&budget, &saved.value.operation)
            .await?;
        if current.space.id != saved.value.space || current.history.space_id != saved.value.space {
            return Err(unavailable(
                "control committed Space receipt mismatch",
                CommitEffect::Unknown,
            ));
        }
        Ok(ControlCommit {
            revision,
            value: AccessibleSpace {
                space: current.space,
                slug: current.slug,
                role: SpaceRole::Owner,
                history: current.history,
                last_seq: current.last_seq,
            },
        })
    }
    pub async fn resume_membership_change(
        &self,
        ctx: AccountContext,
        scope: HistoryScope,
        request: MembershipChange,
    ) -> Result<ControlCommit<MembershipResult>, PortError> {
        ctx.auth().authorize_human_management()?;
        require_unpinned_human(ctx.auth())?;
        let command = membership_command(ctx.auth(), &scope, &request)?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut rtx = self.store.read(budget.clone()).await?;
        let (revision, saved) = budget
            .run(
                async {
                    let actor = user_read(rtx.inner_mut(), ctx.auth().principal().as_str()).await?;
                    self.live_human(rtx.inner_mut(), ctx.auth(), &actor).await?;
                    command
                        .replay::<MembershipResult>(rtx.inner_mut())
                        .await?
                        .ok_or(DomainError::ResourceNotFound.into())
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        let finish = async {
            // Only the already committed receipt is resumed. No catalog read,
            // new membership admission or mutation is needed after self-removal.
            budget.run(rtx.finish(), CommitEffect::Unknown).await?;
            if saved.value.space != scope.space_id
                || saved.value.member != request.member
                || saved.value.role != request.role
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            for event in &saved.events {
                self.flush_event(&budget, event).await?;
            }
            Ok(ControlCommit {
                revision,
                value: saved.value,
            })
        }
        .await;
        finish.map_err(|_: PortError| {
            unavailable("control committed membership replay", CommitEffect::Unknown)
        })
    }
    pub async fn change_membership(
        &self,
        ctx: SpaceContext,
        request: MembershipChange,
    ) -> Result<ControlCommit<MembershipResult>, PortError> {
        ctx.auth().authorize_human_management()?;
        require_unpinned_project(ctx.auth())?;
        let command = membership_command(ctx.auth(), ctx.scope(), &request)?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let space = &ctx.scope().space_id;
        let mut rtx = self.store.read(budget.clone()).await?;
        let observed = budget
            .run(
                async {
                    let actor = user_read(rtx.inner_mut(), ctx.auth().principal().as_str()).await?;
                    self.live_human(rtx.inner_mut(), ctx.auth(), &actor).await?;
                    if command
                        .replay::<MembershipResult>(rtx.inner_mut())
                        .await?
                        .is_none()
                    {
                        require_owner_read(rtx.inner_mut(), ctx.auth(), space).await?;
                    }
                    admission(rtx.inner_mut(), space, false).await
                },
                CommitEffect::NotCommitted,
            )
            .await?;
        budget.run(rtx.finish(), CommitEffect::NotCommitted).await?;
        let catalog = budget
            .run(
                self.catalog
                    .space(budget.context(ctx.budget.request.clone()), space.clone()),
                CommitEffect::NotCommitted,
            )
            .await?;
        ctx.check_current(&catalog.history)?;
        if catalog.space.id != *space {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision,saved)=budget.run(async {
            let accounts=rows!(tx.inner_mut(),UsersRow,fetch_all,
                "SELECT * FROM users WHERE user_id IN ($1,$2) ORDER BY user_id",
                "SELECT * FROM v1_control.users WHERE user_id IN ($1,$2) ORDER BY user_id FOR UPDATE";ctx.auth().principal().as_str(),request.member.as_str())?;
            let actor=accounts.iter().find(|user|user.user_id==ctx.auth().principal().as_str()).ok_or_else(denied)?;
            self.live_human(tx.inner_mut(),ctx.auth(),actor).await?;
            if let Some(replay)=command.replay::<MembershipResult>(tx.inner_mut()).await? {return Ok(replay);}
            let target=accounts.iter().find(|user|user.user_id==request.member.as_str()).ok_or(DomainError::ResourceNotFound)?;
            if request.role.is_some() && target.disabled_at.is_some() {return Err(access_denied());}
            let current=admission(tx.inner_mut(),space,true).await?;
            expect_space(&current,request.expected)?;
            if current.admission_epoch!=observed.admission_epoch || current.state!="active" || catalog.space.lifecycle!=SpaceLifecycle::Active {return Err(invalid(ValidationReason::InvalidState));}
            require_owner(tx.inner_mut(),ctx.auth(),space).await?;
            if catalog.space.kind==SpaceKind::Personal && (target.personal_space_id.as_deref()!=Some(space.as_str()) || request.role!=Some(SpaceRole::Owner)) {return Err(access_denied());}
            let old=rows!(tx.inner_mut(),SpaceMembersRow,fetch_optional,"SELECT * FROM space_members WHERE space_id=$1 AND user_id=$2","SELECT * FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2";space.as_str(),request.member.as_str())?;
            if old.as_ref().is_some_and(|old|old.role=="owner") && request.role!=Some(SpaceRole::Owner) {
                let count=rows!(tx.inner_mut(),(i64,),fetch_one,"SELECT count(*) FROM space_members WHERE space_id=$1 AND role='owner' AND admission='active'","SELECT count(*) FROM v1_control.space_members WHERE space_id=$1 AND role='owner' AND admission='active'";space.as_str())?.0;
                if count<=1 {return Err(access_denied());}
            }
            let now=self.clock.now_ms()?;
            let revision=next(current.revision)?;
            let epoch=next(current.admission_epoch)?;
            if let Some(role)=request.role {
                let role=match role{SpaceRole::Owner=>"owner",SpaceRole::Editor=>"editor",SpaceRole::Viewer=>"viewer"};
                if let Some(old)=old {
                    execute!(tx.inner_mut(),"UPDATE space_members SET role=$1,admission='active',revision=$2 WHERE space_id=$3 AND user_id=$4","UPDATE v1_control.space_members SET role=$1,admission='active',revision=$2 WHERE space_id=$3 AND user_id=$4";role,next(old.revision)?,space.as_str(),request.member.as_str())?;
                } else {
                    let row=TargetRecord::from(SpaceMembersRow{space_id:space.to_string(),user_id:request.member.to_string(),role:role.into(),admission:"active".into(),revision:0,created_at:now});
                    row.validate()?;row.insert_or_conflict(tx.inner_mut()).await?;
                }
            } else {execute!(tx.inner_mut(),"DELETE FROM space_members WHERE space_id=$1 AND user_id=$2","DELETE FROM v1_control.space_members WHERE space_id=$1 AND user_id=$2";space.as_str(),request.member.as_str())?;}
            execute!(tx.inner_mut(),"UPDATE space_admission SET revision=$1,admission_epoch=$2 WHERE space_id=$3","UPDATE v1_control.space_admission SET revision=$1,admission_epoch=$2 WHERE space_id=$3";revision,epoch,space.as_str())?;
            let event=super::outbox::enqueue(tx.inner_mut(),RevocationSelector::Membership{space:space.clone(),principal:request.member.clone()},RevocationReason::PermissionChanged,epoch,now).await?;
            let revision=ControlRevision::new(revision as u64)?;
            let saved=SavedResult{value:MembershipResult{space:space.clone(),member:request.member,role:request.role},events:vec![event]};
            command.save(tx.inner_mut(),revision,&saved,now).await?;
            Ok((revision,saved))
        },CommitEffect::NotCommitted).await?;
        self.commit_revocations(tx, &budget, &saved.events).await?;
        for event in &saved.events {
            self.flush_event(&budget, event).await?;
        }
        Ok(ControlCommit {
            revision,
            value: saved.value,
        })
    }
}
