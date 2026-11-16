use super::super::{authority::next, commands::Command};
use super::{ProviderService, records::*};
use crate::{
    error::invalid,
    keyring::{EnvelopeAddress, KeyringWitness},
    store::{
        lease::OperationBudget,
        statements::{execute, rows},
        target::*,
    },
};
use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::*,
    ports::{control::*, *},
};
use std::collections::BTreeMap;

impl ProviderService {
    pub async fn create_credential(
        &self,
        mut ctx: AccountContext,
        request: AccountMutation<NewProviderCredential>,
    ) -> Result<ControlCommit<ProviderCredentialInfo>, PortError> {
        let mut input = request.input;
        name(&input.name)?;
        injection(&mut input.injection)?;
        secret(input.secret.expose())?;
        limits(input.limits)?;
        let command = Command::new(
            request.identity,
            "create-provider-credential",
            (
                &input.id,
                &input.name,
                &input.injection,
                input.limits,
                crate::auth::token::digest(input.secret.expose().as_bytes()),
            ),
        )?;
        let budget = OperationBudget::new(ctx.budget.clone());
        self.management(&ctx).await?;
        let sealed = self
            .keyring
            .seal(
                budget.context(ctx.budget.request.clone()),
                EnvelopeAddress::credential(&input.id),
                input.secret,
            )
            .await?;
        ctx.budget = budget.context(ctx.budget.request.clone());
        self.mutate(ctx, command, move |tx, owner, now| {
            Box::pin(async move {
                sealed.witness.verify(tx).await?;
                let row = CredentialsRow {
                    id: input.id.to_string(),
                    owner_id: owner.user_id.clone(),
                    name: input.name,
                    kind: "provider-header-v1".into(),
                    secret: sealed.encrypted,
                    injection: json(&input.injection)?,
                    disabled_at: None,
                    rpm: input.limits.requests_per_minute.map(i64::from),
                    tpm: input.limits.tokens_per_minute.map(|n| n as i64),
                    consent_epoch: 1,
                    runtime_epoch: 1,
                    revision: 0,
                    created_at: now,
                    updated_at: now,
                };
                let record = TargetRecord::from(row.clone());
                record.validate()?;
                record.insert_or_conflict(tx).await?;
                Ok((credential_info(&row)?, vec![]))
            })
        })
        .await
    }
    pub async fn update_credential(
        &self,
        mut ctx: AccountContext,
        request: AccountMutation<UpdateProviderCredential>,
    ) -> Result<ControlCommit<ProviderCredentialInfo>, PortError> {
        let mut input = request.input;
        name(&input.name)?;
        injection(&mut input.injection)?;
        limits(input.limits)?;
        if let Some(value) = &input.secret {
            secret(value.expose())?;
        }
        let command = Command::new(
            request.identity,
            "update-provider-credential",
            (
                &input.id,
                input.expected,
                &input.name,
                &input.injection,
                input.limits,
                input.disabled,
                input
                    .secret
                    .as_ref()
                    .map(|value| crate::auth::token::digest(value.expose().as_bytes())),
            ),
        )?;
        let budget = OperationBudget::new(ctx.budget.clone());
        self.management(&ctx).await?;
        let sealed = if let Some(value) = input.secret {
            Some(
                self.keyring
                    .seal(
                        budget.context(ctx.budget.request.clone()),
                        EnvelopeAddress::credential(&input.id),
                        value,
                    )
                    .await?,
            )
        } else {
            None
        };
        ctx.budget = budget.context(ctx.budget.request.clone());
        self.mutate(ctx,command,move |tx,owner,now| Box::pin(async move {
            let mut row=credential(tx,input.id.as_str()).await?;
            owned(&owner.user_id,&row.owner_id)?;revision(row.revision,input.expected)?;
            let old:CredentialInjection=parse(&row.injection)?;
            if old!=input.injection || input.disabled!=row.disabled_at.is_some() { row.consent_epoch=next(row.consent_epoch)?; }
            row.runtime_epoch=next(row.runtime_epoch)?;row.revision=next(row.revision)?;
            row.name=input.name;row.injection=json(&input.injection)?;row.disabled_at=input.disabled.then_some(now);row.updated_at=now;
            row.rpm=input.limits.requests_per_minute.map(i64::from);row.tpm=input.limits.tokens_per_minute.map(|n|n as i64);
            if let Some(sealed)=sealed {sealed.witness.verify(tx).await?;row.secret=sealed.encrypted;}
            TargetRecord::from(row.clone()).validate()?;
            execute!(tx,"UPDATE credentials SET name=$1,secret=$2,injection=$3,disabled_at=$4,rpm=$5,tpm=$6,consent_epoch=$7,runtime_epoch=$8,revision=$9,updated_at=$10 WHERE id=$11","UPDATE v1_control.credentials SET name=$1,secret=$2,injection=$3,disabled_at=$4,rpm=$5,tpm=$6,consent_epoch=$7,runtime_epoch=$8,revision=$9,updated_at=$10 WHERE id=$11";&row.name,&row.secret,&row.injection,row.disabled_at,row.rpm,row.tpm,row.consent_epoch,row.runtime_epoch,row.revision,row.updated_at,&row.id)?;
            Ok((credential_info(&row)?,vec![RevocationSelector::Credential(input.id)]))
        })).await
    }
    pub async fn delete_credential(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteProviderCredential>,
    ) -> Result<ControlCommit<()>, PortError> {
        let input = request.input;
        let command = Command::new(
            request.identity,
            "delete-provider-credential",
            (&input.credential, input.expected),
        )?;
        self.mutate(ctx,command,move |tx,owner,_| Box::pin(async move {
            let row=credential(tx,input.credential.as_str()).await?;owned(&owner.user_id,&row.owner_id)?;revision(row.revision,input.expected)?;
            let referenced=rows!(tx,(i64,),fetch_one,"SELECT count(*) FROM provider_resources WHERE credential_id=$1","SELECT count(*) FROM v1_control.provider_resources WHERE credential_id=$1";input.credential.as_str())?.0;
            if referenced!=0 {return Err(invalid(ValidationReason::InvalidState));}
            execute!(tx,"DELETE FROM credentials WHERE id=$1","DELETE FROM v1_control.credentials WHERE id=$1";input.credential.as_str())?;
            Ok(((),vec![RevocationSelector::Credential(input.credential)]))
        })).await
    }
    async fn prepare_resource(
        &self,
        ctx: &AccountContext,
        mut spec: ProviderResourceSpec,
    ) -> Result<
        (
            ProviderResourcesRow,
            Vec<KeyringWitness>,
            Vec<(String, [u8; 32])>,
        ),
        PortError,
    > {
        name(&spec.name)?;
        limits(spec.limits)?;
        if !(1..=120_000).contains(&spec.timeout_ms) || spec.headers.len() > 16 {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        // Validate the original base before URL normalization can hide userinfo,
        // ambiguous numeric addresses, escapes or a forbidden query/fragment.
        let url = self
            .outbound
            .check_endpoint(scope(spec.id.clone(), spec.wire, 1, None), &spec.base_url)?;
        let parsed = url::Url::parse(&url).map_err(|_| invalid(ValidationReason::InvalidQuery))?;
        if parsed.query().is_some() || parsed.fragment().is_some() {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        let mut bytes = 0usize;
        let mut unique = std::collections::BTreeSet::new();
        for value in &mut spec.headers {
            value.name = header(&value.name)?;
            secret(value.value.expose())?;
            bytes = bytes
                .checked_add(value.name.len() + value.value.expose().len() + 4)
                .ok_or_else(|| invalid(ValidationReason::InvalidLimit))?;
            if !unique.insert(value.name.clone())
                || bytes
                    > if spec.credential.is_some() {
                        6 * 1024
                    } else {
                        12 * 1024
                    }
            {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
        }
        let budget = OperationBudget::new(ctx.budget.clone());
        self.management(ctx).await?;
        let mut headers = BTreeMap::new();
        let mut witnesses = Vec::new();
        let mut fingerprints = Vec::new();
        for value in spec.headers {
            fingerprints.push((
                value.name.clone(),
                crate::auth::token::digest(value.value.expose().as_bytes()),
            ));
            let sealed = self
                .keyring
                .seal(
                    budget.context(ctx.budget.request.clone()),
                    EnvelopeAddress::resource_header(&spec.id, &value.name)?,
                    value.value,
                )
                .await?;
            headers.insert(value.name, sealed.encrypted);
            witnesses.push(sealed.witness);
        }
        fingerprints.sort_by(|a, b| a.0.cmp(&b.0));
        let row = ProviderResourcesRow {
            id: spec.id.to_string(),
            owner_id: ctx.auth().principal().to_string(),
            name: spec.name,
            wire: wire_name(spec.wire).into(),
            base_url: url,
            headers: json(&headers)?,
            credential_id: spec.credential.map(|id| id.to_string()),
            consent_epoch: 1,
            runtime_epoch: 1,
            default_model: None,
            timeouts: json(&Timeouts {
                version: 1,
                total_ms: spec.timeout_ms,
            })?,
            rpm: spec.limits.requests_per_minute.map(i64::from),
            tpm: spec.limits.tokens_per_minute.map(|n| n as i64),
            disabled_at: None,
            revision: 0,
        };
        if row.headers.len() > 65536 {
            return Err(invalid(ValidationReason::InvalidLimit));
        }
        TargetRecord::from(row.clone()).validate()?;
        Ok((row, witnesses, fingerprints))
    }
    pub async fn create_resource(
        &self,
        mut ctx: AccountContext,
        request: AccountMutation<ProviderResourceSpec>,
    ) -> Result<ControlCommit<ProviderResourceInfo>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let (row, witnesses, fingerprints) = self.prepare_resource(&ctx, request.input).await?;
        let command = Command::new(
            request.identity,
            "create-provider-resource",
            (resource_info(&row)?, fingerprints),
        )?;
        ctx.budget = budget.context(ctx.budget.request.clone());
        self.mutate(ctx, command, move |tx, owner, _| {
            Box::pin(async move {
                if let Some(id) = &row.credential_id {
                    let c = credential(tx, id).await?;
                    owned(&owner.user_id, &c.owner_id)?;
                    check_injection(&row, &c)?;
                }
                for witness in witnesses {
                    witness.verify(tx).await?;
                }
                TargetRecord::from(row.clone())
                    .insert_or_conflict(tx)
                    .await?;
                Ok((resource_info(&row)?, vec![]))
            })
        })
        .await
    }
    pub async fn update_resource(
        &self,
        mut ctx: AccountContext,
        request: AccountMutation<UpdateProviderResource>,
    ) -> Result<ControlCommit<ProviderResourceInfo>, PortError> {
        let budget = OperationBudget::new(ctx.budget.clone());
        let input = request.input;
        let resource_id = input.spec.id.clone();
        let (mut row, witnesses, fingerprints) = self.prepare_resource(&ctx, input.spec).await?;
        let command = Command::new(
            request.identity,
            "update-provider-resource",
            (
                resource_info(&row)?,
                input.expected,
                input.disabled,
                fingerprints,
            ),
        )?;
        ctx.budget = budget.context(ctx.budget.request.clone());
        let committed = self.mutate(ctx,command,move |tx,owner,now|Box::pin(async move {
            let old=resource(tx,&row.id).await?;owned(&owner.user_id,&old.owner_id)?;revision(old.revision,input.expected)?;
            if let Some(id)=&row.credential_id {let c=credential(tx,id).await?;owned(&owner.user_id,&c.owner_id)?;check_injection(&row,&c)?;}
            for witness in witnesses {witness.verify(tx).await?;}
            // Custom header values can change upstream identity. Conservatively
            // require new disclosure even when their encrypted values differ
            // only because the caller supplied the same secret again.
            let disclosure_changed=row.base_url!=old.base_url || row.wire!=old.wire || row.credential_id!=old.credential_id || row.headers!="{}" || row.headers!=old.headers || input.disabled!=old.disabled_at.is_some();
            row.consent_epoch=if disclosure_changed {next(old.consent_epoch)?} else {old.consent_epoch};
            row.runtime_epoch=next(old.runtime_epoch)?;row.revision=next(old.revision)?;row.default_model=old.default_model;row.disabled_at=input.disabled.then_some(now);
            execute!(tx,"UPDATE provider_resources SET name=$1,wire=$2,base_url=$3,headers=$4,credential_id=$5,consent_epoch=$6,runtime_epoch=$7,timeouts=$8,rpm=$9,tpm=$10,disabled_at=$11,revision=$12 WHERE id=$13","UPDATE v1_control.provider_resources SET name=$1,wire=$2,base_url=$3,headers=$4,credential_id=$5,consent_epoch=$6,runtime_epoch=$7,timeouts=$8,rpm=$9,tpm=$10,disabled_at=$11,revision=$12 WHERE id=$13";&row.name,&row.wire,&row.base_url,&row.headers,&row.credential_id,row.consent_epoch,row.runtime_epoch,&row.timeouts,row.rpm,row.tpm,row.disabled_at,row.revision,&row.id)?;
            Ok((resource_info(&row)?,vec![RevocationSelector::ProviderResource(ProviderResourceId::parse(&row.id)?)]))
        })).await?;
        self.outbound.invalidate_provider(&resource_id)?;
        Ok(committed)
    }
    pub async fn delete_resource(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteProviderResource>,
    ) -> Result<ControlCommit<()>, PortError> {
        let input = request.input;
        let resource_id = input.resource.clone();
        let command = Command::new(
            request.identity,
            "delete-provider-resource",
            (&input.resource, input.expected),
        )?;
        let committed = self.mutate(ctx,command,move |tx,owner,_|Box::pin(async move {
            let row=resource(tx,input.resource.as_str()).await?;owned(&owner.user_id,&row.owner_id)?;revision(row.revision,input.expected)?;
            execute!(tx,"DELETE FROM provider_preferences WHERE resource_id=$1","DELETE FROM v1_control.provider_preferences WHERE resource_id=$1";input.resource.as_str())?;
            execute!(tx,"DELETE FROM provider_attachments WHERE resource_id=$1","DELETE FROM v1_control.provider_attachments WHERE resource_id=$1";input.resource.as_str())?;
            execute!(tx,"DELETE FROM provider_resources WHERE id=$1","DELETE FROM v1_control.provider_resources WHERE id=$1";input.resource.as_str())?;
            Ok(((),vec![RevocationSelector::ProviderResource(input.resource)]))
        })).await?;
        self.outbound.invalidate_provider(&resource_id)?;
        Ok(committed)
    }
    pub async fn put_model(
        &self,
        ctx: AccountContext,
        request: AccountMutation<PutProviderModel>,
    ) -> Result<ControlCommit<ProviderModelInfo>, PortError> {
        let input = request.input;
        model_spec(&input.model)?;
        let command = Command::new(
            request.identity,
            "put-provider-model",
            (&input.resource, input.expected, &input.model, input.default),
        )?;
        self.mutate(ctx,command,move |tx,owner,_|Box::pin(async move {
            let mut resource=resource(tx,input.resource.as_str()).await?;owned(&owner.user_id,&resource.owner_id)?;revision(resource.revision,input.expected)?;
            let old=rows!(tx,ProviderModelsRow,fetch_optional,"SELECT * FROM provider_models WHERE resource_id=$1 AND model_id=$2","SELECT * FROM v1_control.provider_models WHERE resource_id=$1 AND model_id=$2";input.resource.as_str(),input.model.id.as_str())?;
            let (kind,dimension)=match input.model.kind {ProviderModelKind::Completion=>("completion",None),ProviderModelKind::Embedding{dimension}=>("embedding",Some(i64::from(dimension)))};
            let row=ProviderModelsRow{resource_id:input.resource.to_string(),model_id:input.model.id.to_string(),wire_model_name:input.model.wire_name,kind:kind.into(),tokenizer_profile:"conservative-model-cap-v1".into(),max_input:i64::from(input.model.max_input_tokens),max_output:i64::from(input.model.max_output_tokens),dimension,capabilities:json(&Capabilities{version:1,tools:input.model.tools})?,revision:old.as_ref().map_or(Ok(0),|old|next(old.revision))?};
            TargetRecord::from(row.clone()).validate()?;
            if old.is_some() {
                execute!(tx,"UPDATE provider_models SET wire_model_name=$1,kind=$2,tokenizer_profile=$3,max_input=$4,max_output=$5,dimension=$6,capabilities=$7,revision=$8 WHERE resource_id=$9 AND model_id=$10","UPDATE v1_control.provider_models SET wire_model_name=$1,kind=$2,tokenizer_profile=$3,max_input=$4,max_output=$5,dimension=$6,capabilities=$7,revision=$8 WHERE resource_id=$9 AND model_id=$10";&row.wire_model_name,&row.kind,&row.tokenizer_profile,row.max_input,row.max_output,row.dimension,&row.capabilities,row.revision,&row.resource_id,&row.model_id)?;
            } else {TargetRecord::from(row.clone()).insert(tx).await?;}
            resource.consent_epoch=next(resource.consent_epoch)?;resource.runtime_epoch=next(resource.runtime_epoch)?;resource.revision=next(resource.revision)?;
            if input.default {resource.default_model=Some(row.model_id.clone());}
            execute!(tx,"UPDATE provider_resources SET consent_epoch=$1,runtime_epoch=$2,revision=$3,default_model=$4 WHERE id=$5","UPDATE v1_control.provider_resources SET consent_epoch=$1,runtime_epoch=$2,revision=$3,default_model=$4 WHERE id=$5";resource.consent_epoch,resource.runtime_epoch,resource.revision,&resource.default_model,&resource.id)?;
            Ok((model_info(&row)?,vec![RevocationSelector::ProviderResource(input.resource)]))
        })).await
    }
    pub async fn delete_model(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteProviderModel>,
    ) -> Result<ControlCommit<()>, PortError> {
        let input = request.input;
        let command = Command::new(
            request.identity,
            "delete-provider-model",
            (&input.resource, &input.model, input.expected),
        )?;
        self.mutate(ctx,command,move |tx,owner,_|Box::pin(async move {
            let resource=resource(tx,input.resource.as_str()).await?;owned(&owner.user_id,&resource.owner_id)?;revision(resource.revision,input.expected)?;
            model(tx,input.resource.as_str(),input.model.as_str()).await?;
            execute!(tx,"DELETE FROM provider_preferences WHERE resource_id=$1 AND model_id=$2","DELETE FROM v1_control.provider_preferences WHERE resource_id=$1 AND model_id=$2";input.resource.as_str(),input.model.as_str())?;
            execute!(tx,"DELETE FROM provider_models WHERE resource_id=$1 AND model_id=$2","DELETE FROM v1_control.provider_models WHERE resource_id=$1 AND model_id=$2";input.resource.as_str(),input.model.as_str())?;
            let default=resource.default_model.filter(|id| id!=input.model.as_str());
            execute!(tx,"UPDATE provider_resources SET consent_epoch=$1,runtime_epoch=$2,revision=$3,default_model=$4 WHERE id=$5","UPDATE v1_control.provider_resources SET consent_epoch=$1,runtime_epoch=$2,revision=$3,default_model=$4 WHERE id=$5";next(resource.consent_epoch)?,next(resource.runtime_epoch)?,next(resource.revision)?,default,input.resource.as_str())?;
            Ok(((),vec![RevocationSelector::ProviderResource(input.resource)]))
        })).await
    }
}
fn check_injection(
    row: &ProviderResourcesRow,
    credential: &CredentialsRow,
) -> Result<(), PortError> {
    if credential.disabled_at.is_some() {
        return Err(DomainError::AccessDenied.into());
    }
    let headers: BTreeMap<String, String> = parse(&row.headers)?;
    let injection: CredentialInjection = parse(&credential.injection)?;
    if headers.contains_key(&injection.header) {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(())
}
