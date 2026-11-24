//! Reusable pre-send checks. These helpers never perform a provider request.
use super::{
    ProviderService,
    accounting::BudgetLimit,
    records::*,
    selection::{self, PolicyAdmission},
};
use crate::{
    error::invalid,
    keyring::{EnvelopeAddress, KeyringWitness},
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{read_rows, rows},
        target::*,
    },
};
use http::header::{HeaderMap, HeaderName, HeaderValue};
use notarium_core::{
    DomainError,
    auth::{AuthenticatedCredential, EngineAuthContext, PrincipalKind, Space, SpaceGrant},
    classes::{ClassEgressFence, DocClass, ProviderCurrentContent, ProviderMessage},
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::FolderRef,
    ports::*,
};
use std::collections::{BTreeMap, BTreeSet};

/// Prior disclosure observed by an `AgentRun` or `Keeper` across its recorded
/// provider calls.
pub(super) struct RunQuerySourceDisclosure {
    pub classes: BTreeSet<DocClass>,
    /// `None` when the run has no prior non-query disclosure rows (clean unlogged run).
    /// `Some(Some(project))` when every prior non-query call was strictly confined to `project`.
    /// `Some(None)` when any prior non-query call had Space-wide, multi-project,
    /// legacy, unparseable, or overflow (>64 rows) disclosure.
    pub confined_project: Option<Option<FolderRef>>,
}

impl RunQuerySourceDisclosure {
    pub(super) fn allows_embedder(
        &self,
        allowed_classes: &BTreeSet<DocClass>,
        embedder_project_only: Option<&FolderRef>,
    ) -> bool {
        if !self.classes.is_subset(allowed_classes) {
            return false;
        }
        if let (Some(required_project), Some(confined)) =
            (embedder_project_only, &self.confined_project)
        {
            return confined.as_ref() == Some(required_project);
        }
        true
    }
}

/// Model-authored search queries may reflect any non-encrypted class and scope
/// previously disclosed to the calling run across its recorded provider calls.
/// Require the remote embedding provider to cover every such class and respect
/// project confinement, failing closed to the run's non-encrypted Space grant
/// and unconfined scope if any recorded call lacks disclosure data, fails
/// parsing, or exceeds the bounded scan limit. A clean run with zero prior
/// non-query provider calls has no recorded disclosure.
pub(super) async fn required_query_source_disclosure(
    tx: &mut Transaction,
    auth: &EngineAuthContext,
    grant: &SpaceGrant,
) -> Result<RunQuerySourceDisclosure, PortError> {
    let run = match auth.kind() {
        PrincipalKind::AgentRun(run) | PrincipalKind::Keeper(run) => run,
        _ => {
            return Ok(RunQuerySourceDisclosure {
                classes: BTreeSet::new(),
                confined_project: None,
            });
        }
    };
    let grant_readable: BTreeSet<DocClass> = grant
        .read_classes
        .iter()
        .copied()
        .filter(|class| *class != DocClass::EncryptedNote)
        .collect();
    let fail_closed = || RunQuerySourceDisclosure {
        classes: grant_readable.clone(),
        confined_project: Some(None),
    };
    let prior_calls = rows!(
        tx,
        (String,),
        fetch_all,
        "SELECT policy_epochs FROM provider_call_log WHERE run_id=$1 ORDER BY call_id LIMIT 65",
        "SELECT policy_epochs FROM v1_control.provider_call_log WHERE run_id=$1 ORDER BY call_id LIMIT 65";
        run.as_str()
    )?;
    if prior_calls.is_empty() {
        return Ok(RunQuerySourceDisclosure {
            classes: BTreeSet::new(),
            confined_project: None,
        });
    }
    if prior_calls.len() > 64 {
        return Ok(fail_closed());
    }
    let mut required = BTreeSet::new();
    let mut confined_project: Option<Option<FolderRef>> = None;
    for (raw_epochs,) in prior_calls {
        let Some((classes, call_project_only)) = parse_logged_disclosure(&raw_epochs) else {
            return Ok(fail_closed());
        };
        let classes: BTreeSet<DocClass> = classes
            .into_iter()
            .filter(|class| *class != DocClass::EncryptedNote)
            .collect();
        if classes.is_empty() {
            // Query-only embedding calls record empty classes and disclose no
            // new corpus scope to the model.
            continue;
        }
        required.extend(classes);
        confined_project = match (confined_project, call_project_only) {
            (None, next) => Some(next),
            (Some(Some(prev)), Some(next)) if prev == next => Some(Some(prev)),
            _ => Some(None),
        };
    }
    Ok(RunQuerySourceDisclosure {
        classes: required,
        confined_project,
    })
}

fn parse_logged_disclosure(raw: &str) -> Option<(BTreeSet<DocClass>, Option<FolderRef>)> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let array = value.as_array()?;
    if array.first()?.as_u64()? != 2 {
        return None;
    }
    let classes = serde_json::from_value(array.get(4)?.clone()).ok()?;
    let project_only = match array.get(5) {
        Some(value) => serde_json::from_value(value.clone()).ok()?,
        // Entries missing the project-confinement field fail closed as unconfined.
        None => None,
    };
    Some((classes, project_only))
}

pub(super) struct Snapshot {
    pub resource: ProviderResourcesRow,
    pub credential: Option<CredentialsRow>,
    pub model: Option<ProviderModelSpec>,
}
pub(super) struct HeaderMaterial {
    pub headers: HeaderMap,
    pub witnesses: Vec<KeyringWitness>,
}
pub(super) struct Validated {
    pub auth: EngineAuthContext,
    pub selectors: Vec<RevocationSelector>,
    pub spaces: Vec<SpaceId>,
    pub disclosed_classes: BTreeSet<DocClass>,
    pub disclosed_project_only: Option<FolderRef>,
    pub expires_at_ms: Option<i64>,
}
pub(super) struct DispatchAuthority<'a> {
    pub snapshot: &'a Snapshot,
    pub ctx: &'a AccountContext,
    pub primary: Option<&'a CatalogSpace>,
    pub project: Option<&'a FolderRef>,
    pub secondary_projects: &'a [FolderRef],
    pub parts: &'a [ProviderMessage],
    pub embedding_inputs: &'a [EmbeddingInput],
    pub selection: Option<&'a EmbeddingSelection>,
    pub current: &'a [ProviderCurrentContent],
    pub keeper: Option<&'a crate::service::schedules::PrecheckedKeeper>,
    pub allow_search_indexing: bool,
}
impl Snapshot {
    pub fn budgets(
        &self,
        config: &super::ProviderConfig,
        spaces: &[SpaceId],
    ) -> Result<Vec<BudgetLimit>, PortError> {
        let mut budgets = vec![BudgetLimit {
            kind: "resource",
            owner: self.resource.id.clone(),
            limits: stored_limits(self.resource.rpm, self.resource.tpm)?,
        }];
        if let Some(credential) = &self.credential {
            budgets.push(BudgetLimit {
                kind: "credential",
                owner: credential.id.clone(),
                limits: stored_limits(credential.rpm, credential.tpm)?,
            });
        }
        for space in spaces {
            budgets.push(BudgetLimit {
                kind: "space",
                owner: space.to_string(),
                limits: config
                    .space_limits
                    .get(space)
                    .copied()
                    .unwrap_or(config.default_space_limits),
            });
        }
        Ok(budgets)
    }
    pub fn epochs(
        &self,
        disclosed_classes: &BTreeSet<DocClass>,
        disclosed_project_only: Option<&FolderRef>,
    ) -> Result<String, PortError> {
        json(&(
            2_u8,
            self.resource.consent_epoch,
            self.resource.runtime_epoch,
            self.credential
                .as_ref()
                .map(|value| (&value.id, value.consent_epoch, value.runtime_epoch)),
            disclosed_classes,
            disclosed_project_only,
        ))
    }
}
impl ProviderService {
    /// Reading ciphertext/configuration is internal preparation only. It grants
    /// no authority to decrypt, reserve or send; fresh validation follows.
    pub(super) async fn snapshot(
        &self,
        budget: &OperationBudget,
        id: &ProviderResourceId,
        model_id: Option<&ModelProfileId>,
    ) -> Result<Snapshot, PortError> {
        budget.run(async {
            let resource=read_rows!(&self.control.store.backend,ProviderResourcesRow,fetch_optional,"SELECT * FROM provider_resources WHERE id=$1","SELECT * FROM v1_control.provider_resources WHERE id=$1";id.as_str())?.ok_or_else(selection::unavailable)?;
            let credential=if let Some(id)=&resource.credential_id {Some(read_rows!(&self.control.store.backend,CredentialsRow,fetch_optional,"SELECT * FROM credentials WHERE id=$1 AND kind='provider-header-v1'","SELECT * FROM v1_control.credentials WHERE id=$1 AND kind='provider-header-v1'";id)?.ok_or_else(selection::unavailable)?)} else {None};
            let model=if let Some(id)=model_id {Some(model_info(&read_rows!(&self.control.store.backend,ProviderModelsRow,fetch_optional,"SELECT * FROM provider_models WHERE resource_id=$1 AND model_id=$2","SELECT * FROM v1_control.provider_models WHERE resource_id=$1 AND model_id=$2";&resource.id,id.as_str())?.ok_or_else(selection::unavailable)?)?.model)} else {None};
            timeout(&resource)?;wire(&resource.wire)?;
            Ok(Snapshot{resource,credential,model})
        },CommitEffect::NotCommitted).await
    }
    /// Lock every user first, then resource/credential, then ordered Space rows.
    /// Sender and credential owner disable/revocation must both fence this call.
    pub(super) async fn validate_dispatch(
        &self,
        tx: &mut Transaction,
        authority: DispatchAuthority<'_>,
    ) -> Result<Validated, PortError> {
        let DispatchAuthority {
            snapshot,
            ctx,
            primary,
            project,
            secondary_projects,
            parts,
            embedding_inputs,
            selection,
            current,
            keeper,
            allow_search_indexing,
        } = authority;
        let users = rows!(tx,UsersRow,fetch_all,"SELECT * FROM users WHERE user_id IN ($1,$2) ORDER BY user_id","SELECT * FROM v1_control.users WHERE user_id IN ($1,$2) ORDER BY user_id FOR UPDATE";ctx.auth().principal().as_str(),&snapshot.resource.owner_id)?;
        if !users
            .iter()
            .any(|user| user.user_id == snapshot.resource.owner_id && user.disabled_at.is_none())
        {
            return Err(selection::unavailable());
        }
        let auth = if allow_search_indexing {
            self.control
                .revalidate_for_embedding(tx, ctx.auth(), keeper)
                .await?
        } else {
            self.control
                .revalidate_with_keeper(tx, ctx.auth(), keeper)
                .await?
        };
        let indexing_project = match (auth.kind(), auth.credential()) {
            (
                PrincipalKind::SearchIndexing,
                Some(AuthenticatedCredential::SearchIndexing { space, provider }),
            ) => {
                if !allow_search_indexing
                    || provider.as_str() != snapshot.resource.id
                    || primary.is_none_or(|primary| &primary.space.id != space)
                    || embedding_inputs.is_empty()
                    || embedding_inputs
                        .iter()
                        .any(|input| !matches!(input, EmbeddingInput::Part(_)))
                {
                    return Err(DomainError::AccessDenied.into());
                }
                project
            }
            (PrincipalKind::SearchIndexing, _)
            | (_, Some(AuthenticatedCredential::SearchIndexing { .. })) => {
                return Err(DomainError::AccessDenied.into());
            }
            _ => None,
        };
        let resource = resource(tx, &snapshot.resource.id).await?;
        if resource.owner_id != snapshot.resource.owner_id
            || resource.runtime_epoch != snapshot.resource.runtime_epoch
            || resource.consent_epoch != snapshot.resource.consent_epoch
            || resource.credential_id != snapshot.resource.credential_id
            || resource.disabled_at.is_some()
        {
            return Err(selection::unavailable());
        }
        let credential_epoch = if let Some(expected) = &snapshot.credential {
            let credential = credential(tx, &expected.id).await?;
            if credential.owner_id != resource.owner_id
                || credential.runtime_epoch != expected.runtime_epoch
                || credential.consent_epoch != expected.consent_epoch
                || credential.disabled_at.is_some()
            {
                return Err(selection::unavailable());
            }
            Some(credential.consent_epoch)
        } else {
            if resource.credential_id.is_some() {
                return Err(selection::unavailable());
            }
            None
        };
        if let Some(expected) = &snapshot.model {
            let model = model_info(&model(tx, &resource.id, expected.id.as_str()).await?)?.model;
            if &model != expected {
                return Err(selection::unavailable());
            }
        }
        let mut spaces: BTreeMap<SpaceId, Space> = BTreeMap::new();
        if let Some(primary) = primary {
            spaces.insert(primary.space.id.clone(), primary.space.clone());
        }
        if current.len() > MAX_PROVIDER_ORIGINS || parts.len() > MAX_PROVIDER_ORIGINS {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let mut metadata = BTreeMap::new();
        for item in current {
            if let ProviderCurrentContent::Ability {
                reference,
                provenance,
                promoted_from,
                ..
            } = item
            {
                let identity = AbilityIdentity {
                    id: reference.ability.clone(),
                    placement: provenance.current.placement.clone(),
                };
                if !self
                    .control
                    .promotion_is_committed(tx, promoted_from.as_ref(), &identity)
                    .await?
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
            let origin = json(&item.origin())?;
            if metadata.insert(origin, item).is_some() {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            if let Some(space) = item.space()
                && let Some(old) = spaces.insert(space.id.clone(), space.clone())
                && old != *space
            {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
        }
        if spaces.len() > MAX_PROVIDER_SOURCE_SPACES {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        if primary.is_none()
            && (!parts.is_empty()
                || !spaces.is_empty()
                || project.is_some()
                || snapshot.model.is_some())
        {
            return Err(invalid(ValidationReason::ScopeMismatch));
        }
        if primary.is_none() {
            auth.authorize_human_management()?;
            if auth.principal().as_str() != resource.owner_id {
                return Err(DomainError::AccessDenied.into());
            }
        }
        let mut project_by_space: BTreeMap<&SpaceId, Option<&FolderRef>> = BTreeMap::new();
        for project in secondary_projects {
            if !spaces.contains_key(&project.space_id)
                || primary.is_some_and(|primary| primary.space.id == project.space_id)
            {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            project_by_space
                .entry(&project.space_id)
                .and_modify(|current| {
                    if *current != Some(project) {
                        // Distinct projects can be disclosed with Space-wide consent only.
                        *current = None;
                    }
                })
                .or_insert(Some(project));
        }
        if let Some(primary) = primary {
            project_by_space.insert(&primary.space.id, project);
        }
        let mut policies: BTreeMap<SpaceId, PolicyAdmission> = BTreeMap::new();
        let now = self.control.clock.now_ms()?;
        for space in spaces.values() {
            policies.insert(
                space.id.clone(),
                selection::policy(
                    tx,
                    &auth,
                    &resource,
                    credential_epoch,
                    space,
                    project_by_space.get(&space.id).copied().flatten(),
                    now,
                    true,
                )
                .await?,
            );
        }
        for input in embedding_inputs {
            let EmbeddingInput::Query(query) = input else {
                continue;
            };
            let primary = primary.ok_or_else(selection::unavailable)?;
            auth.authorize_remote_embedding_query(&primary.space.id)?;
            let admitted = policies
                .get(&primary.space.id)
                .ok_or_else(selection::unavailable)?;
            let grant = auth
                .spaces()
                .get(&primary.space.id)
                .ok_or_else(selection::unavailable)?;
            if admitted
                .project_only
                .as_ref()
                .is_some_and(|required| query.project_scope.as_ref() != Some(required))
            {
                return Err(DomainError::AccessDenied.into());
            }
            let source_disclosure = required_query_source_disclosure(tx, &auth, grant).await?;
            if !query.classes.iter().all(|class| {
                admitted.policy.allowed_classes.contains(class)
                    && grant.read_classes.contains(class)
            }) || !source_disclosure.allows_embedder(
                &admitted.policy.allowed_classes,
                admitted.project_only.as_ref(),
            ) {
                return Err(invalid(ValidationReason::ClassEgressForbidden));
            }
        }
        let policy_for = |source: &ProviderCurrentContent| {
            let space = source
                .space()
                .or_else(|| primary.map(|value| &value.space))
                .ok_or_else(selection::unavailable)?;
            policies.get(&space.id).ok_or_else(selection::unavailable)
        };
        let mut used = BTreeSet::new();
        let mut checked_dependencies = BTreeSet::new();
        let mut dependencies = Vec::new();
        for part in parts {
            let origin = json(&part.origin())?;
            used.insert(origin.clone());
            let metadata = metadata
                .get(&origin)
                .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
            let admitted = policy_for(metadata)?;
            if admitted
                .project_only
                .as_ref()
                .or(indexing_project)
                .is_some_and(|project| !part.in_project(project) || !metadata.in_project(project))
            {
                return Err(DomainError::AccessDenied.into());
            }
            if let ProviderCurrentContent::Ability {
                reference,
                provenance,
                requires_explicit_binding,
                ..
            } = metadata
            {
                let identity = AbilityIdentity {
                    id: reference.ability.clone(),
                    placement: provenance.current.placement.clone(),
                };
                let ability_project = match &identity.placement {
                    AbilityPlacement::OwnedProject(folder) => Some(folder),
                    AbilityPlacement::OwnedSpace(space) => admitted
                        .project_only
                        .as_ref()
                        .or(indexing_project)
                        .or_else(|| project_by_space.get(space).copied().flatten()),
                    AbilityPlacement::OwnedPersonal(_) | AbilityPlacement::System => {
                        admitted.project_only.as_ref().or(project)
                    }
                };
                if !self
                    .control
                    .ability_admitted_for_provider(
                        tx,
                        &identity,
                        ability_project,
                        *requires_explicit_binding,
                    )
                    .await?
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
            ClassEgressFence::revalidate(part, &auth, &admitted.policy, metadata)?;
            dependencies.push(*metadata);
        }
        while let Some(source) = dependencies.pop() {
            if !checked_dependencies.insert(json(&source.origin())?) {
                continue;
            }
            let Some(proof) = source.provenance() else {
                continue;
            };
            for witnessed in &proof.projects {
                if !secondary_projects.contains(witnessed) && Some(witnessed) != project {
                    return Err(invalid(ValidationReason::SourceMismatch));
                }
            }
            for origin in &proof.origins {
                let key = json(origin)?;
                let dependency = metadata
                    .get(&key)
                    .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
                let admitted = policy_for(dependency)?;
                if admitted
                    .project_only
                    .as_ref()
                    .is_some_and(|project| !dependency.in_project(project))
                {
                    return Err(DomainError::AccessDenied.into());
                }
                if let ProviderCurrentContent::Ability {
                    reference,
                    provenance,
                    requires_explicit_binding,
                    ..
                } = dependency
                {
                    let identity = AbilityIdentity {
                        id: reference.ability.clone(),
                        placement: provenance.current.placement.clone(),
                    };
                    let ability_project = match &identity.placement {
                        AbilityPlacement::OwnedProject(folder) => Some(folder),
                        AbilityPlacement::OwnedSpace(space) => admitted
                            .project_only
                            .as_ref()
                            .or(indexing_project)
                            .or_else(|| project_by_space.get(space).copied().flatten()),
                        AbilityPlacement::OwnedPersonal(_) | AbilityPlacement::System => {
                            admitted.project_only.as_ref().or(project)
                        }
                    };
                    if !self
                        .control
                        .ability_admitted_for_provider(
                            tx,
                            &identity,
                            ability_project,
                            *requires_explicit_binding,
                        )
                        .await?
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                }
                ClassEgressFence::revalidate_origin(&auth, &admitted.policy, dependency)?;
                if used.insert(key) {
                    dependencies.push(dependency);
                }
            }
        }
        if used.len() != metadata.len() {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        // Query-only embeddings carry no instructions. The credential recheck above
        // validates the approved packages under the primary Space's egress lease.
        let query_only = !embedding_inputs.is_empty()
            && embedding_inputs
                .iter()
                .all(|input| matches!(input, EmbeddingInput::Query(_)));
        if let Some(keeper) = keeper.filter(|_| !query_only) {
            for approved in keeper.approved() {
                if !parts.iter().any(|part| {
                    let Ok(key) = json(&part.origin()) else {
                        return false;
                    };
                    match metadata.get(&key).copied() {
                        Some(ProviderCurrentContent::Ability {
                            reference,
                            provenance,
                            ..
                        }) => {
                            reference.ability == approved.id
                                && reference.package_revision == approved.revision
                                && provenance.current.placement == approved.placement
                                && matches!(
                                    reference.resource,
                                    notarium_core::model::AbilityResourceName::Entrypoint
                                )
                        }
                        Some(ProviderCurrentContent::SystemAbility {
                            ability, revision, ..
                        }) => {
                            approved.placement == AbilityPlacement::System
                                && ability == &approved.id
                                && revision == &approved.revision
                        }
                        _ => false,
                    }
                }) {
                    return Err(invalid(ValidationReason::SourceMismatch));
                }
            }
        }
        let mut selectors = auth.selectors_for_revocation(spaces.keys())?;
        if let Some(EmbeddingSelection::SearchDefault {
            project: selected_project,
        }) = selection
        {
            let space = &primary.ok_or_else(selection::unavailable)?.space;
            let personal_owner = (space.kind == notarium_core::auth::SpaceKind::Personal)
                .then(|| auth.principal().as_str());
            let selected = selection::search_default(tx, space, personal_owner, now).await?;
            if selected.as_ref().is_none_or(|model| {
                model.provider.as_str() != resource.id || &model.project != selected_project
            }) {
                return Err(invalid(ValidationReason::NotReady));
            }
            selectors.insert(RevocationSelector::SearchEmbeddingDefault(space.id.clone()));
        }
        let revocation_scope = ProviderRevocationScope {
            owner: PrincipalId::parse(&resource.owner_id)?,
            credential: snapshot
                .credential
                .as_ref()
                .map(|row| CredentialId::parse(&row.id))
                .transpose()?,
        };
        selectors.extend(revocation_scope.selectors(&ProviderResourceId::parse(&resource.id)?));
        let expires_at_ms = crate::service::sessions::credential_expiry(
            tx,
            auth.credential().ok_or(DomainError::AuthenticationFailed)?,
        )
        .await?;
        let (disclosed_classes, disclosed_project_only) = if query_only {
            (BTreeSet::new(), None)
        } else {
            let classes: BTreeSet<DocClass> = policies
                .values()
                .flat_map(|policy| policy.policy.allowed_classes.iter().copied())
                .filter(|class| *class != DocClass::EncryptedNote)
                .collect();
            let mut projects = policies.values().map(|policy| policy.project_only.as_ref());
            let project_only = match projects.next().flatten() {
                Some(first) if projects.all(|next| next == Some(first)) => Some(first.clone()),
                _ => None,
            };
            (classes, project_only)
        };
        let expires_at_ms = policies
            .values()
            .filter_map(|policy| policy.expires_at_ms)
            .chain(expires_at_ms)
            .min();
        Ok(Validated {
            auth,
            selectors: selectors.into_iter().collect(),
            spaces: spaces.into_keys().collect(),
            disclosed_classes,
            disclosed_project_only,
            expires_at_ms,
        })
    }
    /// Called only after consent validation and durable intent reservation.
    pub(super) async fn headers(
        &self,
        budget: &OperationBudget,
        request: &RequestId,
        snapshot: &Snapshot,
    ) -> Result<HeaderMaterial, PortError> {
        let encrypted: BTreeMap<String, String> = parse(&snapshot.resource.headers)?;
        if encrypted.len() > 16 {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let id = ProviderResourceId::parse(&snapshot.resource.id)?;
        let mut names = Vec::with_capacity(encrypted.len());
        let mut batch = Vec::with_capacity(encrypted.len() + 1);
        for (name, ciphertext) in encrypted {
            let normalized = header(&name)?;
            if normalized != name {
                return Err(invalid(ValidationReason::InvalidState));
            }
            batch.push((EnvelopeAddress::resource_header(&id, &name)?, ciphertext));
            names.push(name);
        }
        let credential_inject = if let Some(credential) = &snapshot.credential {
            let mut inject: CredentialInjection = parse(&credential.injection)?;
            injection(&mut inject)?;
            batch.push((
                EnvelopeAddress::credential(&CredentialId::parse(&credential.id)?),
                credential.secret.clone(),
            ));
            Some(inject)
        } else {
            None
        };
        let mut opened = self
            .keyring
            .open_verified_many(budget.context(request.clone()), batch)
            .await?
            .into_iter();
        let mut headers = HeaderMap::new();
        let mut witnesses = Vec::with_capacity(names.len() + 1);
        let mut bytes = 0usize;
        for name in names {
            let (value, witness) = opened
                .next()
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            put_header(&mut headers, &name, value.expose(), &mut bytes)?;
            witnesses.push(witness);
        }
        if let Some(inject) = credential_inject {
            let (value, witness) = opened
                .next()
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let value = format!("{}{}", inject.prefix, value.expose());
            put_header(&mut headers, &inject.header, &value, &mut bytes)?;
            witnesses.push(witness);
        }
        Ok(HeaderMaterial { headers, witnesses })
    }
}
fn put_header(
    headers: &mut HeaderMap,
    name: &str,
    value: &str,
    bytes: &mut usize,
) -> Result<(), PortError> {
    if value.is_empty() || value.len() > 16 * 1024 || HeaderValue::from_str(value).is_err() {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    *bytes = bytes
        .checked_add(name.len() + value.len() + 4)
        .ok_or_else(|| invalid(ValidationReason::InvalidLimit))?;
    if *bytes > 15 * 1024 || headers.contains_key(name) {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let name = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| invalid(ValidationReason::InvalidQuery))?;
    let mut value =
        HeaderValue::from_str(value).map_err(|_| invalid(ValidationReason::InvalidQuery))?;
    value.set_sensitive(true);
    headers.insert(name, value);
    Ok(())
}
