use super::super::{commands::Command, spaces::require_owner};
use super::{
    ProviderService,
    attachments::{check_member, credential_for_selection, epochs},
    records::*,
};
use crate::{
    error::invalid,
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, Space, SpaceKind, SpaceLifecycle},
    classes::{ProviderAudience, ProviderPolicy},
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::{FolderRef, HistoryScope},
    ports::{control::*, *},
};

pub(super) fn unavailable() -> PortError {
    DomainError::Provider {
        error: ProviderErrorCode::Unavailable,
    }
    .into()
}
pub(super) fn preference_scope(
    scope: &ProviderPreferenceScope,
    owner: &PrincipalId,
) -> (&'static str, String) {
    match scope {
        ProviderPreferenceScope::Personal => ("personal", owner.to_string()),
        ProviderPreferenceScope::Space(space) => ("space", space.to_string()),
        ProviderPreferenceScope::Project(project) => (
            "project",
            format!("{}:{}", project.space_id, project.folder_id),
        ),
    }
}
fn active(
    row: &ProviderAttachmentsRow,
    resource: &ProviderResourcesRow,
    credential_epoch: Option<i64>,
    now: i64,
) -> bool {
    row.state == "approved"
        && row.resource_epoch == resource.consent_epoch
        && row.credential_epoch == credential_epoch
        && row.expires_at.is_none_or(|time| time > now)
}
fn model_kind_name(kind: PreferenceModelKind) -> &'static str {
    match kind {
        PreferenceModelKind::Completion => "completion",
        PreferenceModelKind::Embedding => "embedding",
    }
}
fn matches_preference_kind(actual: &ProviderModelKind, wanted: PreferenceModelKind) -> bool {
    matches!(
        (actual, wanted),
        (
            ProviderModelKind::Completion,
            PreferenceModelKind::Completion
        ) | (
            ProviderModelKind::Embedding { .. },
            PreferenceModelKind::Embedding
        )
    )
}
pub(super) struct PolicyAdmission {
    pub policy: ProviderPolicy,
    pub project_only: Option<FolderRef>,
    pub expires_at_ms: Option<i64>,
}

/// Deterministic embedding target resolved for background search indexing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedSearchEmbeddingModel {
    pub provider: ProviderResourceId,
    pub model: ModelProfileId,
    pub dimension: u32,
    pub max_input_tokens: u32,
    pub runtime_epochs: ProviderRuntimeEpochs,
    pub project: Option<FolderRef>,
}

#[allow(clippy::too_many_arguments)]
async fn resolve_search_candidate(
    tx: &mut Transaction,
    space: &Space,
    personal_owner: Option<&str>,
    resource_id: &str,
    model_id: &str,
    project: Option<FolderRef>,
    now: i64,
) -> Result<Option<ResolvedSearchEmbeddingModel>, PortError> {
    let Some(resource) = rows!(
        tx,
        ProviderResourcesRow,
        fetch_optional,
        "SELECT * FROM provider_resources WHERE id=$1",
        "SELECT * FROM v1_control.provider_resources WHERE id=$1";
        resource_id
    )?
    .filter(|row| row.disabled_at.is_none()) else {
        return Ok(None);
    };
    let owner_active = rows!(
        tx,
        (i64,),
        fetch_one,
        "SELECT count(*) FROM users WHERE user_id=$1 AND disabled_at IS NULL",
        "SELECT count(*) FROM v1_control.users WHERE user_id=$1 AND disabled_at IS NULL";
        &resource.owner_id
    )?
    .0;
    if owner_active != 1 {
        return Ok(None);
    }
    let credential = match credential_for_selection(tx, &resource).await {
        Ok(credential) => credential,
        Err(PortError::Domain(DomainError::AccessDenied | DomainError::ResourceNotFound)) => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    let credential_epoch = credential.as_ref().map(|row| row.consent_epoch);
    let Some(model_row) = rows!(
        tx,
        ProviderModelsRow,
        fetch_optional,
        "SELECT * FROM provider_models WHERE resource_id=$1 AND model_id=$2",
        "SELECT * FROM v1_control.provider_models WHERE resource_id=$1 AND model_id=$2";
        &resource.id,
        model_id
    )?
    else {
        return Ok(None);
    };
    let loaded = model_info(&model_row)?;
    let ProviderModelKind::Embedding { dimension } = loaded.model.kind else {
        return Ok(None);
    };
    let attachment = if space.kind == SpaceKind::Personal {
        let Some(owner) = personal_owner else {
            return Ok(None);
        };
        rows!(
            tx,
            ProviderAttachmentsRow,
            fetch_optional,
            "SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3",
            "SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3";
            &resource.id,
            owner,
            space.id.as_str()
        )?
        .filter(|row| active(row, &resource, credential_epoch, now))
    } else {
        match shared_attachment(
            tx,
            &resource,
            credential_epoch,
            &space.id,
            project.as_ref(),
            now,
            false,
        )
        .await
        {
            Ok(attachment) => Some(attachment),
            Err(PortError::Domain(DomainError::Provider {
                error: ProviderErrorCode::Unavailable,
            })) => None,
            Err(error) => return Err(error),
        }
    };
    let Some(attachment) = attachment else {
        return Ok(None);
    };
    let mut disclosure: ProviderDisclosure = parse(&attachment.disclosure)?;
    disclosure
        .classes
        .remove(&notarium_core::classes::DocClass::EncryptedNote);
    if space.kind == SpaceKind::Shared {
        disclosure
            .classes
            .remove(&notarium_core::classes::DocClass::Profile);
    }
    if disclosure.classes.is_empty() {
        return Ok(None);
    }
    Ok(Some(ResolvedSearchEmbeddingModel {
        provider: ProviderResourceId::parse(&resource.id)?,
        model: loaded.model.id,
        dimension,
        max_input_tokens: loaded.model.max_input_tokens,
        runtime_epochs: runtime_epochs(&resource, credential.as_ref())?,
        project,
    }))
}
pub(super) async fn search_default(
    tx: &mut Transaction,
    space: &Space,
    personal_owner: Option<&str>,
    now: i64,
) -> Result<Option<ResolvedSearchEmbeddingModel>, PortError> {
    // Step 1: Space-level preference, or Personal Space owner preference fallback.
    let space_prefs = rows!(
        tx,
        ProviderPreferencesRow,
        fetch_all,
        "SELECT * FROM provider_preferences WHERE scope_kind='space' AND scope_id=$1 AND model_kind='embedding' ORDER BY owner_id LIMIT 2",
        "SELECT * FROM v1_control.provider_preferences WHERE scope_kind='space' AND scope_id=$1 AND model_kind='embedding' ORDER BY owner_id LIMIT 2";
        space.id.as_str()
    )?;
    if space_prefs.len() > 1 {
        return Ok(None);
    }
    if let Some(pref) = space_prefs.into_iter().next() {
        return resolve_search_candidate(
            tx,
            space,
            personal_owner,
            &pref.resource_id,
            &pref.model_id,
            None,
            now,
        )
        .await;
    }
    if let Some(owner) = personal_owner
        && let Some(pref) = rows!(
            tx,
            ProviderPreferencesRow,
            fetch_optional,
            "SELECT * FROM provider_preferences WHERE owner_id=$1 AND scope_kind='personal' AND scope_id=$1 AND model_kind='embedding'",
            "SELECT * FROM v1_control.provider_preferences WHERE owner_id=$1 AND scope_kind='personal' AND scope_id=$1 AND model_kind='embedding'";
            owner
        )?
    {
        return resolve_search_candidate(
            tx,
            space,
            Some(owner),
            &pref.resource_id,
            &pref.model_id,
            None,
            now,
        )
        .await;
    }

    // Step 2: Unique active project preference within this Space.
    let prefix = format!("{}:", space.id);
    let prefix_len =
        i32::try_from(prefix.len()).map_err(|_| invalid(ValidationReason::InvalidState))?;
    let suffix_start = prefix_len + 1;
    let is_shared = if space.kind == SpaceKind::Shared {
        1_i64
    } else {
        0_i64
    };
    let project_prefs = rows!(
        tx,
        ProviderPreferencesRow,
        fetch_all,
        "SELECT p.* FROM provider_preferences p JOIN provider_resources r ON r.id=p.resource_id JOIN users u ON u.user_id=r.owner_id LEFT JOIN credentials c ON c.id=r.credential_id JOIN provider_models m ON m.resource_id=r.id AND m.model_id=p.model_id WHERE p.scope_kind='project' AND substr(p.scope_id, 1, $1)=$2 AND p.model_kind='embedding' AND m.kind='embedding' AND m.dimension IS NOT NULL AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND (r.credential_id IS NULL OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL)) AND EXISTS (SELECT 1 FROM provider_attachments a WHERE a.resource_id=r.id AND a.target_space=$3 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR a.credential_epoch=c.consent_epoch) AND (a.expires_at IS NULL OR a.expires_at>$4) AND (($5=0 AND a.target_kind='personal' AND a.target_owner=$6) OR ($5=1 AND (a.target_kind='space' OR (a.target_kind='project' AND a.target_project=substr(p.scope_id, $7)))))) ORDER BY p.scope_id, p.owner_id LIMIT 2",
        "SELECT p.* FROM v1_control.provider_preferences p JOIN v1_control.provider_resources r ON r.id=p.resource_id JOIN v1_control.users u ON u.user_id=r.owner_id LEFT JOIN v1_control.credentials c ON c.id=r.credential_id JOIN v1_control.provider_models m ON m.resource_id=r.id AND m.model_id=p.model_id WHERE p.scope_kind='project' AND substr(p.scope_id, 1, $1)=$2 AND p.model_kind='embedding' AND m.kind='embedding' AND m.dimension IS NOT NULL AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND (r.credential_id IS NULL OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL)) AND EXISTS (SELECT 1 FROM v1_control.provider_attachments a WHERE a.resource_id=r.id AND a.target_space=$3 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR a.credential_epoch=c.consent_epoch) AND (a.expires_at IS NULL OR a.expires_at>$4) AND (($5=0 AND a.target_kind='personal' AND a.target_owner=$6) OR ($5=1 AND (a.target_kind='space' OR (a.target_kind='project' AND a.target_project=substr(p.scope_id, $7)))))) ORDER BY p.scope_id, p.owner_id LIMIT 2";
        prefix_len,
        &prefix,
        space.id.as_str(),
        now,
        is_shared,
        personal_owner,
        suffix_start
    )?;
    if project_prefs.len() != 1 {
        return Ok(None);
    }
    let pref = project_prefs
        .into_iter()
        .next()
        .expect("checked single project preference");
    let Some(folder_raw) = pref.scope_id.strip_prefix(&prefix) else {
        return Ok(None);
    };
    let project = FolderRef {
        space_id: space.id.clone(),
        folder_id: FolderId::parse(folder_raw)?,
    };
    resolve_search_candidate(
        tx,
        space,
        personal_owner,
        &pref.resource_id,
        &pref.model_id,
        Some(project),
        now,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn policy(
    tx: &mut Transaction,
    auth: &EngineAuthContext,
    resource: &ProviderResourcesRow,
    credential_epoch: Option<i64>,
    space: &Space,
    project: Option<&FolderRef>,
    now: i64,
    lock: bool,
) -> Result<PolicyAdmission, PortError> {
    // Current-auth revalidation already holds shared Space admission. Policy
    // checks must not upgrade it after taking resource/credential locks.
    check_member(tx, auth, &space.id).await?;
    if space.lifecycle != SpaceLifecycle::Active {
        return Err(unavailable());
    }
    let personal = if lock {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,
            "SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3",
            "SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3 FOR SHARE";&resource.id,auth.principal().as_str(),space.id.as_str())?
    } else {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,
            "SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3",
            "SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='personal' AND target_owner=$2 AND target_space=$3";&resource.id,auth.principal().as_str(),space.id.as_str())?
    }
    .filter(|row| active(row, resource, credential_epoch, now))
    .ok_or_else(unavailable)?;
    let mut disclosure: ProviderDisclosure = parse(&personal.disclosure)?;
    let mut project_only = None;
    let mut expires_at_ms = personal.expires_at;
    let audience = if space.kind == SpaceKind::Personal {
        ProviderAudience::Personal { consented: true }
    } else {
        let shared = shared_attachment(
            tx,
            resource,
            credential_epoch,
            &space.id,
            project,
            now,
            lock,
        )
        .await?;
        expires_at_ms = [expires_at_ms, shared.expires_at]
            .into_iter()
            .flatten()
            .min();
        if shared.target_kind == "project" {
            project_only = project.cloned();
        }
        let allowed: ProviderDisclosure = parse(&shared.disclosure)?;
        disclosure.classes = disclosure
            .classes
            .intersection(&allowed.classes)
            .copied()
            .collect();
        ProviderAudience::Shared {
            space: space.id.clone(),
            attached: true,
            space_consented: true,
            sender_consented: true,
        }
    };
    disclosure
        .classes
        .remove(&notarium_core::classes::DocClass::EncryptedNote);
    if space.kind == SpaceKind::Shared {
        disclosure
            .classes
            .remove(&notarium_core::classes::DocClass::Profile);
    }
    if disclosure.classes.is_empty() {
        return Err(unavailable());
    }
    Ok(PolicyAdmission {
        policy: ProviderPolicy {
            provider: ProviderResourceId::parse(&resource.id)?,
            audience,
            allowed_classes: disclosure.classes,
        },
        project_only,
        expires_at_ms,
    })
}
async fn shared_attachment(
    tx: &mut Transaction,
    resource: &ProviderResourcesRow,
    credential_epoch: Option<i64>,
    space: &SpaceId,
    project: Option<&FolderRef>,
    now: i64,
    lock: bool,
) -> Result<ProviderAttachmentsRow, PortError> {
    let global = if lock {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='space' AND target_space=$2","SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='space' AND target_space=$2 FOR SHARE";&resource.id,space.as_str())?
    } else {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='space' AND target_space=$2","SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='space' AND target_space=$2";&resource.id,space.as_str())?
    };
    if let Some(row) = global.filter(|row| active(row, resource, credential_epoch, now)) {
        return Ok(row);
    }
    let project = project
        .filter(|project| project.space_id == *space)
        .ok_or_else(unavailable)?;
    let scoped = if lock {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='project' AND target_space=$2 AND target_project=$3","SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='project' AND target_space=$2 AND target_project=$3 FOR SHARE";&resource.id,space.as_str(),project.folder_id.as_str())?
    } else {
        rows!(tx,ProviderAttachmentsRow,fetch_optional,"SELECT * FROM provider_attachments WHERE resource_id=$1 AND target_kind='project' AND target_space=$2 AND target_project=$3","SELECT * FROM v1_control.provider_attachments WHERE resource_id=$1 AND target_kind='project' AND target_space=$2 AND target_project=$3";&resource.id,space.as_str(),project.folder_id.as_str())?
    };
    scoped
        .filter(|row| active(row, resource, credential_epoch, now))
        .ok_or_else(unavailable)
}
impl ProviderService {
    /// Admit the revision author in a Shared Space or the owner of a Personal
    /// Space. An ineligible author or unavailable disclosure returns no grant
    /// for this note. Storage and budget failures propagate to the caller.
    pub async fn admit_search_indexing(
        &self,
        authority: &ServiceAuthority,
        scope: HistoryScope,
        revision_actor: &PrincipalId,
        provider: &ProviderResourceId,
        project: Option<&FolderRef>,
        call: CallBudget,
    ) -> Result<Option<(SpaceContext, ProviderPolicy)>, PortError> {
        authority.require(ServicePurpose::Search)?;
        match self
            .search_indexing_policy(authority, scope, revision_actor, provider, project, call)
            .await
        {
            Ok(grant) => Ok(Some(grant)),
            Err(PortError::Domain(
                DomainError::AccessDenied
                | DomainError::AuthenticationFailed
                | DomainError::ResourceNotFound
                | DomainError::Provider {
                    error: ProviderErrorCode::Unavailable,
                },
            )) => Ok(None),
            Err(error) => Err(error),
        }
    }

    async fn search_indexing_policy(
        &self,
        authority: &ServiceAuthority,
        scope: HistoryScope,
        revision_actor: &PrincipalId,
        provider: &ProviderResourceId,
        project: Option<&FolderRef>,
        call: CallBudget,
    ) -> Result<(SpaceContext, ProviderPolicy), PortError> {
        let budget = OperationBudget::new(call.clone());
        let space = budget
            .run(
                self.control
                    .catalog
                    .space(budget.context(call.request.clone()), scope.space_id.clone()),
                CommitEffect::NotCommitted,
            )
            .await?;
        scope.check(&space.history)?;
        let mut ctx = self
            .control
            .admit_search_indexing(
                authority,
                &space,
                revision_actor,
                provider,
                budget.context(call.request.clone()),
            )
            .await?;
        let space = self.selection_catalog(&ctx, project).await?;
        let (mut tx, auth) = self
            .control
            .open_revalidated_read_for_search_indexing(&budget, &call.request, ctx.auth())
            .await?;
        let admitted = budget
            .run(
                async {
                    let resource = resource_read(tx.inner_mut(), provider.as_str()).await?;
                    let epoch = credential_for_selection(tx.inner_mut(), &resource)
                        .await?
                        .map(|credential| credential.consent_epoch);
                    policy(
                        tx.inner_mut(),
                        &auth,
                        &resource,
                        epoch,
                        &space.space,
                        project,
                        self.control.clock.now_ms()?,
                        false,
                    )
                    .await
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        ctx.budget = budget.context(call.request);
        Ok((ctx, admitted?.policy))
    }

    /// Deterministically resolve the remote embedding model for a Space:
    /// 1. Space preference (or personal owner fallback for Personal Spaces) -> `project: None`.
    /// 2. Otherwise, a unique (`LIMIT 2`) active project preference in this Space -> `project: Some(folder_ref)`.
    ///    Zero or two-or-more candidates return `Ok(None)`.
    ///
    /// When `explicit` is `Some(model)`, apply the same 2-step lookup across active
    /// Space/personal attachments first, then unique project attachments.
    pub async fn resolve_search_embedding_model(
        &self,
        authority: &ServiceAuthority,
        scope: HistoryScope,
        explicit: Option<ModelProfileId>,
        call: CallBudget,
    ) -> Result<Option<ResolvedSearchEmbeddingModel>, PortError> {
        authority.require(ServicePurpose::Search)?;
        let budget = OperationBudget::new(call.clone());
        let space = budget
            .run(
                self.control
                    .catalog
                    .space(budget.context(call.request.clone()), scope.space_id.clone()),
                CommitEffect::NotCommitted,
            )
            .await?;
        scope.check(&space.history)?;
        if space.space.id != scope.space_id || space.space.lifecycle != SpaceLifecycle::Active {
            return Ok(None);
        }
        let mut tx = self.control.store.read(budget.clone()).await?;
        let resolved = budget
            .run(
                async {
                    let now = self.control.clock.now_ms()?;
                    let state = rows!(
                        tx.inner_mut(),
                        (String,),
                        fetch_optional,
                        "SELECT state FROM space_admission WHERE space_id=$1",
                        "SELECT state FROM v1_control.space_admission WHERE space_id=$1";
                        space.space.id.as_str()
                    )?;
                    if state.as_ref().map(|(s,)| s.as_str()) != Some("active") {
                        return Ok(None);
                    }
                    let personal_owner: Option<String> = if space.space.kind == SpaceKind::Personal
                    {
                        rows!(
                            tx.inner_mut(),
                            (String,),
                            fetch_optional,
                            "SELECT u.user_id FROM users u JOIN space_members m ON u.user_id=m.user_id WHERE u.personal_space_id=$1 AND m.space_id=$1 AND m.role='owner' AND m.admission='active' AND u.disabled_at IS NULL",
                            "SELECT u.user_id FROM v1_control.users u JOIN v1_control.space_members m ON u.user_id=m.user_id WHERE u.personal_space_id=$1 AND m.space_id=$1 AND m.role='owner' AND m.admission='active' AND u.disabled_at IS NULL";
                            space.space.id.as_str()
                        )?
                        .map(|(id,)| id)
                    } else {
                        None
                    };
                    if space.space.kind == SpaceKind::Personal && personal_owner.is_none() {
                        return Ok(None);
                    }
                    if let Some(model_id) = explicit {
                        if space.space.kind == SpaceKind::Personal {
                            let owner = personal_owner.as_deref().expect("checked personal owner");
                            let candidates = rows!(
                                tx.inner_mut(),
                                (String,),
                                fetch_all,
                                "SELECT r.id FROM provider_resources r JOIN users u ON u.user_id=r.owner_id LEFT JOIN credentials c ON c.id=r.credential_id JOIN provider_models m ON m.resource_id=r.id JOIN provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND m.kind='embedding' AND m.dimension IS NOT NULL AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND a.credential_epoch=c.consent_epoch)) AND a.target_kind='personal' AND a.target_owner=$2 AND a.target_space=$3 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$4) ORDER BY r.id LIMIT 2",
                                "SELECT r.id FROM v1_control.provider_resources r JOIN v1_control.users u ON u.user_id=r.owner_id LEFT JOIN v1_control.credentials c ON c.id=r.credential_id JOIN v1_control.provider_models m ON m.resource_id=r.id JOIN v1_control.provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND m.kind='embedding' AND m.dimension IS NOT NULL AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND a.credential_epoch=c.consent_epoch)) AND a.target_kind='personal' AND a.target_owner=$2 AND a.target_space=$3 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$4) ORDER BY r.id LIMIT 2";
                                model_id.as_str(),
                                owner,
                                space.space.id.as_str(),
                                now
                            )?;
                            if candidates.len() != 1 {
                                return Ok(None);
                            }
                            return resolve_search_candidate(
                                tx.inner_mut(),
                                &space.space,
                                personal_owner.as_deref(),
                                &candidates[0].0,
                                model_id.as_str(),
                                None,
                                now,
                            )
                            .await;
                        }
                        let space_candidates = rows!(
                            tx.inner_mut(),
                            (String,),
                            fetch_all,
                            "SELECT r.id FROM provider_resources r JOIN users u ON u.user_id=r.owner_id LEFT JOIN credentials c ON c.id=r.credential_id JOIN provider_models m ON m.resource_id=r.id JOIN provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND m.kind='embedding' AND m.dimension IS NOT NULL AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND a.credential_epoch=c.consent_epoch)) AND a.target_kind='space' AND a.target_space=$2 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$3) ORDER BY r.id LIMIT 2",
                            "SELECT r.id FROM v1_control.provider_resources r JOIN v1_control.users u ON u.user_id=r.owner_id LEFT JOIN v1_control.credentials c ON c.id=r.credential_id JOIN v1_control.provider_models m ON m.resource_id=r.id JOIN v1_control.provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND m.kind='embedding' AND m.dimension IS NOT NULL AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND a.credential_epoch=c.consent_epoch)) AND a.target_kind='space' AND a.target_space=$2 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$3) ORDER BY r.id LIMIT 2";
                            model_id.as_str(),
                            space.space.id.as_str(),
                            now
                        )?;
                        if space_candidates.len() > 1 {
                            return Ok(None);
                        }
                        if let Some((resource_id,)) = space_candidates.into_iter().next() {
                            return resolve_search_candidate(
                                tx.inner_mut(),
                                &space.space,
                                None,
                                &resource_id,
                                model_id.as_str(),
                                None,
                                now,
                            )
                            .await;
                        }
                        let project_candidates = rows!(
                            tx.inner_mut(),
                            (String, String),
                            fetch_all,
                            "SELECT r.id, a.target_project FROM provider_resources r JOIN users u ON u.user_id=r.owner_id LEFT JOIN credentials c ON c.id=r.credential_id JOIN provider_models m ON m.resource_id=r.id JOIN provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND m.kind='embedding' AND m.dimension IS NOT NULL AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND a.credential_epoch=c.consent_epoch)) AND a.target_kind='project' AND a.target_space=$2 AND a.target_project IS NOT NULL AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$3) ORDER BY r.id, a.target_project LIMIT 2",
                            "SELECT r.id, a.target_project FROM v1_control.provider_resources r JOIN v1_control.users u ON u.user_id=r.owner_id LEFT JOIN v1_control.credentials c ON c.id=r.credential_id JOIN v1_control.provider_models m ON m.resource_id=r.id JOIN v1_control.provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND m.kind='embedding' AND m.dimension IS NOT NULL AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND a.credential_epoch=c.consent_epoch)) AND a.target_kind='project' AND a.target_space=$2 AND a.target_project IS NOT NULL AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$3) ORDER BY r.id, a.target_project LIMIT 2";
                            model_id.as_str(),
                            space.space.id.as_str(),
                            now
                        )?;
                        if project_candidates.len() != 1 {
                            return Ok(None);
                        }
                        let (resource_id, folder_raw) = project_candidates.into_iter().next().expect("checked single candidate");
                        let project = FolderRef {
                            space_id: space.space.id.clone(),
                            folder_id: FolderId::parse(&folder_raw)?,
                        };
                        return resolve_search_candidate(
                            tx.inner_mut(),
                            &space.space,
                            None,
                            &resource_id,
                            model_id.as_str(),
                            Some(project),
                            now,
                        )
                        .await;
                    }

                    search_default(tx.inner_mut(), &space.space, personal_owner.as_deref(), now).await
                },
                CommitEffect::NotCommitted,
            )
            .await;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        resolved
    }

    pub(super) async fn selection_catalog(
        &self,
        ctx: &SpaceContext,
        project: Option<&FolderRef>,
    ) -> Result<CatalogSpace, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let space = budget
            .run(
                self.control.catalog.space(
                    budget.context(ctx.budget.request.clone()),
                    ctx.scope().space_id.clone(),
                ),
                CommitEffect::NotCommitted,
            )
            .await?;
        ctx.check_current(&space.history)?;
        if space.space.id != ctx.scope().space_id || space.space.lifecycle != SpaceLifecycle::Active
        {
            return Err(unavailable());
        }
        if let Some(project) = project {
            if project.space_id != space.space.id {
                return Err(invalid(ValidationReason::ScopeMismatch));
            }
            let actual = budget
                .run(
                    self.control.catalog.project(ctx.clone(), project.clone()),
                    CommitEffect::NotCommitted,
                )
                .await?;
            if actual.folder != *project {
                return Err(DomainError::ResourceNotFound.into());
            }
        }
        Ok(space)
    }
    pub async fn select_provider(
        &self,
        ctx: SpaceContext,
        request: SelectProvider,
    ) -> Result<ProviderSelection, PortError> {
        self.control.reject_search_indexing(ctx.auth())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let space = self
            .selection_catalog(&ctx, request.project.as_ref())
            .await?;
        let wanted_kind = model_kind_name(request.kind);
        let (mut tx, auth) = self
            .control
            .open_revalidated_read(&budget, &ctx.budget.request, ctx.auth())
            .await?;
        let selected=budget.run(async {
            let now=self.control.clock.now_ms()?;
            let (id,model_id)=if let Some(id)=request.resource { (id,request.model) }
            else if let Some(model)=request.model {
                let project_id = request.project.as_ref().map(|p| p.folder_id.as_str());
                let is_shared = if space.space.kind == SpaceKind::Shared { 1_i64 } else { 0_i64 };
                let candidates=rows!(tx.inner_mut(),(String,),fetch_all,
                    "SELECT r.id FROM provider_resources r JOIN users u ON u.user_id=r.owner_id LEFT JOIN credentials c ON c.id=r.credential_id JOIN provider_models m ON m.resource_id=r.id JOIN provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND m.kind=$2 AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND a.credential_epoch=c.consent_epoch)) AND a.target_kind='personal' AND a.target_owner=$3 AND a.target_space=$4 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$5) AND ($6=0 OR EXISTS (SELECT 1 FROM provider_attachments sa WHERE sa.resource_id=r.id AND sa.target_space=$4 AND (sa.target_kind='space' OR (sa.target_kind='project' AND sa.target_project=$7)) AND sa.state='approved' AND sa.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND sa.credential_epoch IS NULL) OR sa.credential_epoch=c.consent_epoch) AND (sa.expires_at IS NULL OR sa.expires_at>$5))) ORDER BY r.id LIMIT 2",
                    "SELECT r.id FROM v1_control.provider_resources r JOIN v1_control.users u ON u.user_id=r.owner_id LEFT JOIN v1_control.credentials c ON c.id=r.credential_id JOIN v1_control.provider_models m ON m.resource_id=r.id JOIN v1_control.provider_attachments a ON a.resource_id=r.id WHERE m.model_id=$1 AND m.kind=$2 AND r.disabled_at IS NULL AND u.disabled_at IS NULL AND ((r.credential_id IS NULL AND a.credential_epoch IS NULL) OR (c.kind='provider-header-v1' AND c.owner_id=r.owner_id AND c.disabled_at IS NULL AND a.credential_epoch=c.consent_epoch)) AND a.target_kind='personal' AND a.target_owner=$3 AND a.target_space=$4 AND a.state='approved' AND a.resource_epoch=r.consent_epoch AND (a.expires_at IS NULL OR a.expires_at>$5) AND ($6=0 OR EXISTS (SELECT 1 FROM v1_control.provider_attachments sa WHERE sa.resource_id=r.id AND sa.target_space=$4 AND (sa.target_kind='space' OR (sa.target_kind='project' AND sa.target_project=$7)) AND sa.state='approved' AND sa.resource_epoch=r.consent_epoch AND ((r.credential_id IS NULL AND sa.credential_epoch IS NULL) OR sa.credential_epoch=c.consent_epoch) AND (sa.expires_at IS NULL OR sa.expires_at>$5))) ORDER BY r.id LIMIT 2";model.as_str(),wanted_kind,auth.principal().as_str(),space.space.id.as_str(),now,is_shared,project_id)?;
                if candidates.len()!=1 {return Err(unavailable());}
                (ProviderResourceId::parse(&candidates[0].0)?,Some(model))
            } else {
                let preferred=self.preference(tx.inner_mut(),&auth,&space.space.id,request.project.as_ref(),wanted_kind).await?;
                (ProviderResourceId::parse(&preferred.resource_id)?,Some(ModelProfileId::parse(&preferred.model_id)?))
            };
            let resource=resource_read(tx.inner_mut(),id.as_str()).await?;
            let owner_active = rows!(tx.inner_mut(),(i64,),fetch_one,"SELECT count(*) FROM users WHERE user_id=$1 AND disabled_at IS NULL","SELECT count(*) FROM v1_control.users WHERE user_id=$1 AND disabled_at IS NULL";&resource.owner_id)?.0;
            if owner_active != 1 {
                return Err(unavailable());
            }
            let credential=credential_for_selection(tx.inner_mut(),&resource).await.map_err(|_| unavailable())?;
            let credential_epoch=credential.as_ref().map(|row| row.consent_epoch);
            let model_id=model_id.or_else(||resource.default_model.as_deref().and_then(|value|ModelProfileId::parse(value).ok())).ok_or_else(unavailable)?;
            let loaded=model_info(&model_read(tx.inner_mut(),&resource.id,model_id.as_str()).await.map_err(|_| unavailable())?)?;
            if !matches_preference_kind(&loaded.model.kind, request.kind) {
                return Err(unavailable());
            }
            let admission=policy(tx.inner_mut(),&auth,&resource,credential_epoch,&space.space,request.project.as_ref(),now,false).await?;
            let runtime_epochs=runtime_epochs(&resource,credential.as_ref())?;
            Ok(ProviderSelection{provider:id,model:model_id,runtime_epochs,project:request.project,policy:admission.policy})
        },CommitEffect::NotCommitted).await?;
        budget
            .run(tx.rollback(), CommitEffect::NotCommitted)
            .await?;
        Ok(selected)
    }
    async fn preference(
        &self,
        tx: &mut Transaction,
        auth: &EngineAuthContext,
        space: &SpaceId,
        project: Option<&FolderRef>,
        model_kind: &str,
    ) -> Result<ProviderPreferencesRow, PortError> {
        let personal = rows!(tx,ProviderPreferencesRow,fetch_optional,"SELECT * FROM provider_preferences WHERE owner_id=$1 AND scope_kind='personal' AND scope_id=$1 AND model_kind=$2","SELECT * FROM v1_control.provider_preferences WHERE owner_id=$1 AND scope_kind='personal' AND scope_id=$1 AND model_kind=$2";auth.principal().as_str(),model_kind)?;
        if let Some(row) = personal {
            return Ok(row);
        }
        let mut scopes = Vec::new();
        if let Some(project) = project {
            scopes.push(preference_scope(
                &ProviderPreferenceScope::Project(project.clone()),
                auth.principal(),
            ));
        }
        scopes.push(("space", space.to_string()));
        for (kind, id) in scopes {
            let rows = rows!(tx,ProviderPreferencesRow,fetch_all,"SELECT * FROM provider_preferences WHERE scope_kind=$1 AND scope_id=$2 AND model_kind=$3 ORDER BY owner_id LIMIT 2","SELECT * FROM v1_control.provider_preferences WHERE scope_kind=$1 AND scope_id=$2 AND model_kind=$3 ORDER BY owner_id LIMIT 2";kind,&id,model_kind)?;
            if rows.len() > 1 {
                return Err(unavailable());
            }
            if let Some(row) = rows.into_iter().next() {
                return Ok(row);
            }
        }
        Err(unavailable())
    }
    pub async fn set_preference(
        &self,
        mut ctx: AccountContext,
        request: AccountMutation<SetProviderPreference>,
    ) -> Result<ControlCommit<SetProviderPreference>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        self.management(&ctx).await?;
        let input = request.input;
        let catalog = match &input.scope {
            ProviderPreferenceScope::Personal => None,
            ProviderPreferenceScope::Space(space) => Some(
                self.target_catalog(&ctx, &ProviderAttachmentTarget::Space(space.clone()))
                    .await?,
            ),
            ProviderPreferenceScope::Project(project) => Some(
                self.target_catalog(&ctx, &ProviderAttachmentTarget::Project(project.clone()))
                    .await?,
            ),
        };
        let command = Command::new(request.identity, "set-provider-preference", &input)?;
        let auth = ctx.auth().clone();
        ctx.budget = budget.context(ctx.budget.request.clone());
        self.mutate(ctx,command,move |tx,owner,now|Box::pin(async move {
            // A shared default is replaced across resource owners. Serialize
            // that scope before taking any provider configuration row locks.
            if let Some(catalog)=&catalog {
                super::super::spaces::admission(tx,&catalog.space.id,true).await?;
                check_member(tx,&auth,&catalog.space.id).await?;require_owner(tx,&auth,&catalog.space.id).await?;
            }
            let resource=resource(tx,input.resource.as_str()).await?;let credential_epoch=epochs(tx,&resource).await?;
            let loaded=model_info(&model(tx,&resource.id,input.model.as_str()).await?)?;
            if !matches_preference_kind(&loaded.model.kind, input.kind) {
                return Err(invalid(ValidationReason::InvalidQuery));
            }
            if let Some(catalog)=&catalog {
                let project=match &input.scope{ProviderPreferenceScope::Project(project)=>Some(project),_=>None};
                shared_attachment(tx,&resource,credential_epoch,&catalog.space.id,project,now,true).await?;
            } else {super::inventory::resource_visible(tx,&owner.user_id,&resource).await?;}
            let selection_space = match (&input.kind, &catalog, &owner.personal_space_id) {
                (PreferenceModelKind::Embedding, Some(catalog), _) => Some(catalog.space.clone()),
                (PreferenceModelKind::Embedding, None, Some(space)) => Some(Space {
                    id: SpaceId::parse(space)?, kind: SpaceKind::Personal, lifecycle: SpaceLifecycle::Active,
                }),
                _ => None,
            };
            let personal_owner = selection_space.as_ref()
                .filter(|space| space.kind == SpaceKind::Personal)
                .map(|_| owner.user_id.as_str());
            let previous = match &selection_space {
                Some(space) => search_default(tx, space, personal_owner, now).await?,
                None => None,
            };
            let (kind,id)=preference_scope(&input.scope,auth.principal());
            let wanted_kind = model_kind_name(input.kind);
            // Space/project preferences belong to that scope and model_kind. The
            // row owner is its last authorized editor; a second owner replaces it.
            if kind=="personal" {execute!(tx,"DELETE FROM provider_preferences WHERE owner_id=$1 AND scope_kind=$2 AND scope_id=$3 AND model_kind=$4","DELETE FROM v1_control.provider_preferences WHERE owner_id=$1 AND scope_kind=$2 AND scope_id=$3 AND model_kind=$4";&owner.user_id,kind,&id,wanted_kind)?;}
            else {execute!(tx,"DELETE FROM provider_preferences WHERE scope_kind=$1 AND scope_id=$2 AND model_kind=$3","DELETE FROM v1_control.provider_preferences WHERE scope_kind=$1 AND scope_id=$2 AND model_kind=$3";kind,&id,wanted_kind)?;}
            let row=TargetRecord::from(ProviderPreferencesRow{owner_id:owner.user_id.clone(),scope_kind:kind.into(),scope_id:id,model_kind:wanted_kind.into(),resource_id:resource.id,model_id:input.model.to_string(),revision:super::super::authority::next(owner.revision)?});row.validate()?;row.insert(tx).await?;
            let mut selectors = Vec::new();
            if let (Some(previous), Some(space)) = (previous, selection_space) {
                let current = search_default(tx, &space, personal_owner, now).await?;
                if current.as_ref().is_none_or(|current|
                    current.provider != previous.provider || current.project != previous.project
                ) {
                    selectors.push(RevocationSelector::SearchEmbeddingDefault(space.id));
                }
            }
            Ok((input,selectors))
        })).await
    }
}
