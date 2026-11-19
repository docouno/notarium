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
use notarium_core::{
    DomainError,
    auth::{AuthenticatedCredential, EngineAuthContext, Space},
    classes::{ClassEgressFence, ProviderCurrentContent, ProviderMessage},
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    model::FolderRef,
    ports::*,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use std::collections::BTreeMap;

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
    pub expires_at_ms: Option<i64>,
}
pub(super) struct DispatchAuthority<'a> {
    pub snapshot: &'a Snapshot,
    pub ctx: &'a AccountContext,
    pub primary: Option<&'a CatalogSpace>,
    pub project: Option<&'a FolderRef>,
    pub parts: &'a [ProviderMessage],
    pub current: &'a [ProviderCurrentContent],
    pub keeper: Option<&'a crate::service::schedules::PrecheckedKeeper>,
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
    pub fn epochs(&self) -> Result<String, PortError> {
        json(&(
            1,
            self.resource.consent_epoch,
            self.resource.runtime_epoch,
            self.credential
                .as_ref()
                .map(|value| (&value.id, value.consent_epoch, value.runtime_epoch)),
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
            parts,
            current,
            keeper,
        } = authority;
        let users = rows!(tx,UsersRow,fetch_all,"SELECT * FROM users WHERE user_id IN ($1,$2) ORDER BY user_id","SELECT * FROM v1_control.users WHERE user_id IN ($1,$2) ORDER BY user_id FOR UPDATE";ctx.auth().principal().as_str(),&snapshot.resource.owner_id)?;
        if !users
            .iter()
            .any(|user| user.user_id == snapshot.resource.owner_id && user.disabled_at.is_none())
        {
            return Err(selection::unavailable());
        }
        let auth = self
            .control
            .revalidate_with_keeper(tx, ctx.auth(), keeper)
            .await?;
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
        if current.len() > 4096 || parts.len() > 4096 {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        let mut metadata = BTreeMap::new();
        for item in current {
            let origin = json(&item.origin())?;
            if metadata.insert(origin, item).is_some() {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
            if let Some(old) = spaces.insert(item.space().id.clone(), item.space().clone())
                && old != *item.space()
            {
                return Err(invalid(ValidationReason::SourceMismatch));
            }
        }
        if spaces.len() > 64 {
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
                    project,
                    now,
                    true,
                )
                .await?,
            );
        }
        let mut used = std::collections::BTreeSet::new();
        for part in parts {
            let origin = json(&part.origin())?;
            used.insert(origin.clone());
            let metadata = metadata
                .get(&origin)
                .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
            let admitted = policies
                .get(&metadata.space().id)
                .ok_or_else(selection::unavailable)?;
            if admitted
                .project_only
                .as_ref()
                .is_some_and(|project| !part.in_project(project) || !metadata.in_project(project))
            {
                return Err(DomainError::AccessDenied.into());
            }
            ClassEgressFence::revalidate(part, &auth, &admitted.policy, metadata)?;
        }
        if used.len() != metadata.len() {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        let mut selectors = vec![
            RevocationSelector::Principal(auth.principal().clone()),
            RevocationSelector::Principal(PrincipalId::parse(&resource.owner_id)?),
            RevocationSelector::Grant(auth.grant().clone()),
            RevocationSelector::ProviderResource(ProviderResourceId::parse(&resource.id)?),
        ];
        if let Some(credential) = &snapshot.credential {
            selectors.push(RevocationSelector::Credential(CredentialId::parse(
                &credential.id,
            )?));
        }
        let expires_at_ms=match auth.credential().ok_or(DomainError::AuthenticationFailed)? {
            AuthenticatedCredential::Session(id)=>{selectors.push(RevocationSelector::Session(id.clone()));Some(rows!(tx,(i64,),fetch_one,"SELECT expires_at FROM sessions WHERE session_id=$1","SELECT expires_at FROM v1_control.sessions WHERE session_id=$1";id.as_str())?.0)},
            AuthenticatedCredential::Pat(id)=>rows!(tx,(Option<i64>,),fetch_one,"SELECT expires_at FROM pats WHERE token_id=$1","SELECT expires_at FROM v1_control.pats WHERE token_id=$1";id.as_str())?.0,
            AuthenticatedCredential::OAuth{token,grant,family}=>{selectors.push(RevocationSelector::OAuthAccess(token.clone()));selectors.push(RevocationSelector::OAuthGrant(grant.clone()));if let Some(family)=family{selectors.push(RevocationSelector::OAuthFamily(family.clone()));}Some(rows!(tx,(i64,),fetch_one,"SELECT expires_at FROM oauth_access_tokens WHERE token_id=$1","SELECT expires_at FROM v1_control.oauth_access_tokens WHERE token_id=$1";token.as_str())?.0)},
            AuthenticatedCredential::TrustedNone=>None,
            AuthenticatedCredential::ScheduledRun{schedule,run,..}=>{
                selectors.push(RevocationSelector::Schedule(schedule.clone()));
                selectors.push(RevocationSelector::ScheduledRun(run.clone()));
                Some(rows!(tx,(i64,),fetch_one,"SELECT expires_at FROM agent_schedule_runs WHERE run_id=$1","SELECT expires_at FROM v1_control.agent_schedule_runs WHERE run_id=$1";run.as_str())?.0)
            },
        };
        for space in spaces.keys() {
            selectors.push(RevocationSelector::Space(space.clone()));
            selectors.push(RevocationSelector::Membership {
                space: space.clone(),
                principal: auth.principal().clone(),
            });
        }
        let expires_at_ms = policies
            .values()
            .filter_map(|policy| policy.expires_at_ms)
            .chain(expires_at_ms)
            .min();
        Ok(Validated {
            auth,
            selectors,
            spaces: spaces.into_keys().collect(),
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
