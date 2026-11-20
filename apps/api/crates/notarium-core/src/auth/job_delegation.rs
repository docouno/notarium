use super::*;
use crate::model::HistoryScope;

/// Durable identifiers and ceilings for a deferred archive job. Decoding these
/// facts confers no authority. Execution requires a matching, freshly attested
/// credential from the authentication owner.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct JobDelegation {
    scope: HistoryScope,
    principal: PrincipalId,
    grant: GrantId,
    credential: CredentialReference,
    role: SpaceRole,
    read_classes: BTreeSet<DocClass>,
    write_classes: BTreeSet<DocClass>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CredentialReference {
    Session {
        id: AuthSessionId,
    },
    Pat {
        id: CredentialTokenId,
    },
    OAuth {
        token: CredentialTokenId,
        grant: OAuthGrantId,
        family: Option<OAuthFamilyId>,
    },
    TrustedNone,
}

impl JobDelegation {
    pub fn capture(auth: &EngineAuthContext, scope: &HistoryScope) -> Option<Self> {
        let grant = auth.spaces.get(&scope.space_id)?;
        if auth.taint.is_tainted()
            || grant.project_root.is_some()
            || auth
                .write_space
                .as_ref()
                .is_some_and(|id| id != &scope.space_id)
        {
            return None;
        }
        let credential = match auth.credential.as_ref()? {
            AuthenticatedCredential::Session(id) => CredentialReference::Session { id: id.clone() },
            AuthenticatedCredential::Pat(id) => CredentialReference::Pat { id: id.clone() },
            AuthenticatedCredential::OAuth {
                token,
                grant,
                family,
            } => CredentialReference::OAuth {
                token: token.clone(),
                grant: grant.clone(),
                family: family.clone(),
            },
            AuthenticatedCredential::TrustedNone => CredentialReference::TrustedNone,
            AuthenticatedCredential::ScheduledRun { .. } => return None,
        };
        // Deferred effects outlive the request, while a derived run's grant
        // is bounded by that run and its branch taint.
        if matches!(
            auth.kind,
            PrincipalKind::AgentRun(_) | PrincipalKind::Keeper(_)
        ) {
            return None;
        }
        Some(Self {
            scope: scope.clone(),
            principal: auth.principal.clone(),
            grant: auth.grant.clone(),
            credential,
            role: grant.role,
            read_classes: grant.read_classes.clone(),
            write_classes: grant.write_classes.clone(),
        })
    }

    pub fn scope(&self) -> &HistoryScope {
        &self.scope
    }

    pub fn principal(&self) -> &PrincipalId {
        &self.principal
    }

    pub fn grant(&self) -> &GrantId {
        &self.grant
    }

    /// Only the authentication owner may verify this reference against its DB.
    pub fn credential_reference(&self) -> AuthenticatedCredential {
        match &self.credential {
            CredentialReference::Session { id } => AuthenticatedCredential::Session(id.clone()),
            CredentialReference::Pat { id } => AuthenticatedCredential::Pat(id.clone()),
            CredentialReference::OAuth {
                token,
                grant,
                family,
            } => AuthenticatedCredential::OAuth {
                token: token.clone(),
                grant: grant.clone(),
                family: family.clone(),
            },
            CredentialReference::TrustedNone => AuthenticatedCredential::TrustedNone,
        }
    }

    pub fn limit(&self, current: &EngineAuthContext) -> DomainResult<EngineAuthContext> {
        if current.principal != self.principal
            || current.grant != self.grant
            || current.credential.as_ref() != Some(&self.credential_reference())
            || current
                .write_space
                .as_ref()
                .is_some_and(|id| id != &self.scope.space_id)
        {
            return Err(DomainError::AuthenticationFailed);
        }
        let mut limited = current.narrow(BTreeMap::from([(
            self.scope.space_id.clone(),
            SpaceGrant {
                role: self.role,
                read_classes: self.read_classes.clone(),
                write_classes: self.write_classes.clone(),
                project_root: None,
            },
        )]))?;
        limited.write_space = Some(self.scope.space_id.clone());
        Ok(limited)
    }
}
