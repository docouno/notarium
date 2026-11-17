use super::{
    AuthenticationMode, ControlService,
    authority::*,
    commands::{Command, SavedResult},
    passwords::normalize_account,
};
use crate::{
    auth::{password, token},
    error::{database, invalid, unavailable},
    store::{
        Transaction,
        lease::OperationBudget,
        statements::{execute, read_rows, rows},
        target::*,
    },
};
use notarium_core::{
    auth::{SpaceKind, SpaceLifecycle},
    error::{CommitEffect, PortError, ValidationReason},
    ids::*,
    ports::{control::*, *},
    receipt::AccountCommandIdentity,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PendingSpace {
    version: u8,
    owner: PrincipalId,
    actor: PrincipalId,
    key: CommandKey,
    hash: ContentDigest,
    expected: ControlRevision,
    space: SpaceId,
    kind: SpaceKind,
    name: String,
}
fn identity(user: &PrincipalId, space: &SpaceId) -> AccountCommandIdentity {
    let bytes = token::digest(format!("notarium:personal-space:v1:{user}:{space}").as_bytes());
    AccountCommandIdentity {
        owner: user.clone(),
        actor: user.clone(),
        key: CommandKey::from_bytes(bytes[..16].try_into().expect("digest prefix")),
        hash: ContentDigest::from_bytes(bytes),
        expected: ControlRevision::ZERO,
    }
}
fn operation_id(identity: &AccountCommandIdentity) -> RequestId {
    let bytes = token::digest(
        format!(
            "notarium:space-operation:v1:{}:{}:{}",
            identity.owner, identity.actor, identity.key
        )
        .as_bytes(),
    );
    RequestId::from_bytes(bytes[..16].try_into().expect("digest prefix"))
}
pub(super) async fn stage_personal(
    tx: &mut Transaction,
    current: &UsersRow,
    now: i64,
) -> Result<RequestId, PortError> {
    let owner = PrincipalId::parse(&current.user_id)?;
    let space = SpaceId::parse(
        current
            .personal_space_id
            .as_deref()
            .ok_or_else(|| invalid(ValidationReason::InvalidState))?,
    )?;
    stage_space(
        tx,
        identity(&owner, &space),
        CreateSpace {
            id: space,
            kind: SpaceKind::Personal,
            name: "Personal".into(),
        },
        now,
    )
    .await
}
pub(super) async fn stage_space(
    tx: &mut Transaction,
    identity: AccountCommandIdentity,
    space: CreateSpace,
    now: i64,
) -> Result<RequestId, PortError> {
    let id = operation_id(&identity);
    let data = PendingSpace {
        version: 1,
        owner: identity.owner.clone(),
        actor: identity.actor,
        key: identity.key,
        hash: identity.hash,
        expected: identity.expected,
        space: space.id.clone(),
        kind: space.kind,
        name: space.name,
    };
    let payload =
        serde_json::to_string(&data).map_err(|_| invalid(ValidationReason::InvalidState))?;
    let rows = [
        TargetRecord::from(SpaceAdmissionRow {
            space_id: space.id.to_string(),
            state: "pending".into(),
            admission_epoch: 0,
            revision: 0,
        }),
        TargetRecord::from(SpaceMembersRow {
            space_id: space.id.to_string(),
            user_id: identity.owner.to_string(),
            role: "owner".into(),
            admission: "pending".into(),
            revision: 0,
            created_at: now,
        }),
        TargetRecord::from(ControlOperationsRow {
            operation_id: id.to_string(),
            command_key: id.to_string(),
            kind: "create-space".into(),
            target_space: space.id.to_string(),
            state: "pending".into(),
            payload_hash: blake3::hash(payload.as_bytes()).as_bytes().to_vec(),
            payload,
            canonical_receipt: None,
            next_action: "ensure-space".into(),
            updated_at: now,
        }),
    ];
    for record in rows {
        record.validate()?;
        record.insert_or_conflict(tx).await?;
    }
    Ok(id)
}
impl ControlService {
    pub(super) async fn resume_pending_spaces(
        &self,
        budget: &OperationBudget,
    ) -> Result<(), PortError> {
        loop {
            let pending=budget.run(async {read_rows!(&self.store.backend,ControlOperationsRow,fetch_optional,
                "SELECT * FROM control_operations WHERE state!='committed' AND kind='create-space' ORDER BY updated_at,operation_id LIMIT 1",
                "SELECT * FROM v1_control.control_operations WHERE state!='committed' AND kind='create-space' ORDER BY updated_at,operation_id LIMIT 1";)
            },CommitEffect::NotCommitted).await?;
            let Some(pending) = pending else {
                return Ok(());
            };
            self.finish_space_operation(budget, &RequestId::parse(&pending.operation_id)?)
                .await?;
        }
    }
    pub(super) async fn finish_space_operation(
        &self,
        budget: &OperationBudget,
        id: &RequestId,
    ) -> Result<CatalogSpace, PortError> {
        let work=async {
            let row=budget.run(async{read_rows!(&self.store.backend,ControlOperationsRow,fetch_one,
                "SELECT * FROM control_operations WHERE operation_id=$1","SELECT * FROM v1_control.control_operations WHERE operation_id=$1";id.as_str())
            },CommitEffect::Unknown).await?;
            if row.kind!="create-space" || row.payload_hash!=blake3::hash(row.payload.as_bytes()).as_bytes() {return Err(invalid(ValidationReason::InvalidState));}
            let pending:PendingSpace=serde_json::from_str(&row.payload).map_err(|_|invalid(ValidationReason::InvalidState))?;
            if pending.version!=1 || pending.space.as_str()!=row.target_space {return Err(invalid(ValidationReason::InvalidState));}
            if row.state=="committed" {
                let (space,history,last_seq)=serde_json::from_str(row.canonical_receipt.as_deref().ok_or_else(||invalid(ValidationReason::InvalidState))?).map_err(|_|invalid(ValidationReason::InvalidState))?;
                let catalog=CatalogSpace{space,history,last_seq};
                if catalog.space.id!=pending.space || catalog.history.space_id!=pending.space || catalog.space.kind!=pending.kind || catalog.space.lifecycle!=SpaceLifecycle::Active {return Err(invalid(ValidationReason::InvalidState));}
                return Ok(catalog);
            }
            let identity=AccountCommandIdentity{owner:pending.owner.clone(),actor:pending.actor,key:pending.key,hash:pending.hash,expected:pending.expected};
            if operation_id(&identity)!=*id {return Err(invalid(ValidationReason::InvalidState));}
            let catalog=budget.run(self.catalog.ensure_space(budget.context(id.clone()),EnsureCatalogSpace{identity,owner:pending.owner.clone(),space:CreateSpace{id:pending.space.clone(),kind:pending.kind,name:pending.name}}),CommitEffect::Unknown).await?;
            if catalog.space.id!=pending.space || catalog.history.space_id!=pending.space || catalog.space.kind!=pending.kind || catalog.space.lifecycle!=SpaceLifecycle::Active {return Err(invalid(ValidationReason::InvalidState));}
            let receipt=serde_json::to_string(&(catalog.space.clone(),catalog.history.clone(),catalog.last_seq)).map_err(|_|invalid(ValidationReason::InvalidState))?;
            let mut tx=self.store.write(budget.clone()).await?;
            budget.run(async {
                // Recheck the durable operation after the external call. A
                // concurrent recovery may already have completed this phase.
                let current=rows!(tx.inner_mut(),ControlOperationsRow,fetch_one,"SELECT * FROM control_operations WHERE operation_id=$1","SELECT * FROM v1_control.control_operations WHERE operation_id=$1 FOR UPDATE";id.as_str())?;
                if current.payload_hash!=row.payload_hash {return Err(invalid(ValidationReason::InvalidState));}
                if current.state=="committed" {return Ok(());}
                let changed=execute!(tx.inner_mut(),"UPDATE space_admission SET state='active' WHERE space_id=$1 AND state='pending'","UPDATE v1_control.space_admission SET state='active' WHERE space_id=$1 AND state='pending'";pending.space.as_str())?;
                if changed!=1 {return Err(invalid(ValidationReason::InvalidState));}
                execute!(tx.inner_mut(),"UPDATE space_members SET admission='active' WHERE space_id=$1 AND user_id=$2 AND admission='pending'","UPDATE v1_control.space_members SET admission='active' WHERE space_id=$1 AND user_id=$2 AND admission='pending'";pending.space.as_str(),pending.owner.as_str())?;
                execute!(tx.inner_mut(),"UPDATE control_operations SET state='committed',canonical_receipt=$1,next_action='done',updated_at=$2 WHERE operation_id=$3","UPDATE v1_control.control_operations SET state='committed',canonical_receipt=$1,next_action='done',updated_at=$2 WHERE operation_id=$3";&receipt,self.clock.now_ms()?,id.as_str())?;
                Ok(())
            },CommitEffect::Unknown).await?;
            budget.run(tx.commit(),CommitEffect::Unknown).await?;
            Ok(catalog)
        }.await;
        work.map_err(|_: PortError| {
            unavailable("control pending space operation", CommitEffect::Unknown)
        })
    }
    pub async fn bootstrap(
        &self,
        authorization: EmptyRootAuthorization,
        ctx: CallBudget,
        request: BootstrapAccount,
    ) -> Result<BootstrapAccountResult, PortError> {
        if authorization.installation() != &self.installation {
            return Err(access_denied());
        }
        let budget = OperationBudget::new(ctx);
        let (username, email, display_name) =
            normalize_account(request.username, request.email, request.display_name)?;
        let exists = budget
            .run(
                async {
                    read_rows!(&self.store.backend,(i64,),fetch_one,
            "SELECT count(*) FROM (SELECT 1 FROM users LIMIT 1) existing",
            "SELECT count(*) FROM (SELECT 1 FROM v1_control.users LIMIT 1) existing";)
                },
                CommitEffect::NotCommitted,
            )
            .await?
            .0;
        if exists != 0 {
            return Err(access_denied());
        }
        let (id, password_hash) = match &self.config.authentication {
            AuthenticationMode::Password => (
                PrincipalId::from_bytes(token::random()?),
                Some(
                    budget
                        .run(
                            password::hash(request.password.ok_or_else(denied)?),
                            CommitEffect::NotCommitted,
                        )
                        .await?,
                ),
            ),
            AuthenticationMode::TrustedNone { owner } => {
                if request.password.is_some() {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                (owner.clone(), None)
            }
        };
        let mut tx = self.store.write(budget.clone()).await?;
        let (account,operation,auth_version,original_hash)=budget.run(async {
            if let Transaction::Postgres(inner)=tx.inner_mut() {
                sqlx::query("SELECT pg_advisory_xact_lock($1)").bind(0x4e54_424f_4f54_i64).execute(&mut **inner).await.map_err(database)?;
            }
            let count=rows!(tx.inner_mut(),(i64,),fetch_one,"SELECT count(*) FROM (SELECT 1 FROM users LIMIT 1) existing","SELECT count(*) FROM (SELECT 1 FROM v1_control.users LIMIT 1) existing";)?.0;
            if count!=0 {return Err(access_denied());}
            let row=UsersRow{user_id:id.to_string(),username,email,display_name,password_hash,is_admin:1,disabled_at:None,personal_space_id:Some(SpaceId::from_bytes(token::random()?).to_string()),revision:0,metadata_revision:0,auth_version:0,created_at:self.clock.now_ms()?};
            let record=TargetRecord::from(row.clone());
            record.validate()?;
            record.insert_or_conflict(tx.inner_mut()).await?;
            let operation=stage_personal(tx.inner_mut(),&row,row.created_at).await?;
            Ok((account_info(&row)?,operation,row.auth_version,row.password_hash))
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        self.finish_space_operation(&budget, &operation).await?;
        let session = if matches!(self.config.authentication, AuthenticationMode::Password) {
            let work = async {
                let mut tx = self.store.write(budget.clone()).await?;
                let issued = budget
                    .run(
                        async {
                            let current = user(tx.inner_mut(), id.as_str()).await?;
                            if current.disabled_at.is_some()
                                || current.auth_version != auth_version
                                || current.password_hash != original_hash
                            {
                                return Err(denied());
                            }
                            mint_session(tx.inner_mut(), &current, self.clock.now_ms()?).await
                        },
                        CommitEffect::Unknown,
                    )
                    .await?;
                budget.run(tx.commit(), CommitEffect::Unknown).await?;
                Ok(issued)
            }
            .await;
            Some(work.map_err(|_: PortError| {
                unavailable("control bootstrap committed", CommitEffect::Unknown)
            })?)
        } else {
            None
        };
        let account = session
            .as_ref()
            .map(|session| session.account.clone())
            .unwrap_or(account);
        Ok(BootstrapAccountResult { account, session })
    }
    pub async fn create_account(
        &self,
        ctx: AccountContext,
        request: AccountMutation<NewAccount>,
    ) -> Result<ControlCommit<AccountInfo>, PortError> {
        let (username, email, display_name) = normalize_account(
            request.input.username,
            request.input.email,
            request.input.display_name,
        )?;
        let command = Command::new(
            request.identity,
            "create-account",
            (&username, &email, &display_name),
        )?;
        command.require(ctx.auth().principal(), ctx.auth().principal())?;
        let budget = OperationBudget::new(ctx.budget.clone());
        let mut tx = self.store.write(budget.clone()).await?;
        let (revision,saved)=budget.run(async {
            let (actor,_)=self.manager(tx.inner_mut(),ctx.auth(),ctx.auth().principal()).await?;
            if actor.is_admin!=1 {return Err(access_denied());}
            if let Some(replay)=command.replay::<AccountInfo>(tx.inner_mut()).await? {return Ok(replay);}
            expect_revision(&actor,command.identity.expected)?;
            let now=self.clock.now_ms()?;
            let row=UsersRow{user_id:PrincipalId::from_bytes(token::random()?).to_string(),username,email,display_name,password_hash:None,is_admin:0,disabled_at:None,personal_space_id:Some(SpaceId::from_bytes(token::random()?).to_string()),revision:0,metadata_revision:0,auth_version:0,created_at:now};
            let record=TargetRecord::from(row.clone());
            record.validate()?;
            record.insert_or_conflict(tx.inner_mut()).await?;
            stage_personal(tx.inner_mut(),&row,now).await?;
            let revision=next(actor.revision)?;
            execute!(tx.inner_mut(),"UPDATE users SET revision=$1 WHERE user_id=$2","UPDATE v1_control.users SET revision=$1 WHERE user_id=$2";revision,&actor.user_id)?;
            let revision=ControlRevision::new(revision as u64)?;
            let saved=SavedResult{value:account_info(&row)?,events:vec![]};
            command.save(tx.inner_mut(),revision,&saved,now).await?;
            Ok((revision,saved))
        },CommitEffect::NotCommitted).await?;
        budget.run(tx.commit(), CommitEffect::Unknown).await?;
        let space = saved
            .value
            .personal_space
            .as_ref()
            .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
        self.finish_space_operation(&budget, &operation_id(&identity(&saved.value.id, space)))
            .await?;
        Ok(ControlCommit {
            revision,
            value: saved.value,
        })
    }
}
