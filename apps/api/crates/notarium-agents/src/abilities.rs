//! The built-in ability packages and their composition with the owned catalog.
mod builtins;

use notarium_core::{
    DomainError,
    auth::{PrincipalKind, SpaceLifecycle},
    classes::{
        CanonicalMetadataContent, ProviderCurrentContent, ProviderOrigin, SystemAbilityContent,
    },
    error::{PortError, ValidationReason},
    ids::*,
    model::{FolderRef, HistoryScope, NoteRef},
    ports::{
        AccountContext, CallBudget, Cancellation, MemoryTarget, MemoryTargetSnapshot, PortFuture,
        ResolvedMemoryTarget, SpaceContext,
        catalog::{
            CatalogDisclosure, CatalogFolder, CatalogNote, CatalogSpace, ControlCatalogPort,
            EnsureCatalogSpace, ScheduleAbilityLease,
        },
        control::*,
        provider::{
            MAX_PROVIDER_ORIGINS, ProviderEgressCatalogPort, ProviderEgressDependencies,
            ProviderEgressLease, ProviderEgressRequest,
        },
    },
};
use serde::Serialize;
use std::{collections::BTreeSet, sync::Arc};

use builtins::{BUILTINS, Builtin, digest};

const SYSTEM_CURSOR_PREFIX: &str = "system-v1:";
const MAX_CATALOG_CURSOR_BYTES: usize = 2048;

/// Adds the shipped packages to the same precedence and admission path as
/// owned packages. Both control and provider construction use this catalog.
pub struct SystemAbilityCatalog<C: ?Sized> {
    owned: Arc<C>,
}

impl<C: ?Sized> SystemAbilityCatalog<C> {
    pub fn new(owned: Arc<C>) -> Self {
        Self { owned }
    }
}

/// Whether a name is reserved for a built-in package.
pub(crate) fn is_reserved_ability_name(name: &str) -> bool {
    let key = notarium_syntax::unicode::lookup_key(name);
    BUILTINS.iter().any(|builtin| builtin.name == key)
}

/// Stable catalog emission ordinal of a shipped built-in ability so provider
/// pagination cursors stay strictly monotonic with `system_page`.
pub(crate) fn system_ability_rank(id: &AbilityId) -> Option<usize> {
    BUILTINS.iter().position(|builtin| builtin.id() == *id)
}

/// Reads the exact built-in revision. The text is a typed system source so it
/// can be pinned and checked again by the provider rather than cast to a prompt.
pub fn read_system_ability(
    ctx: &AccountContext,
    reference: &AbilityRef,
) -> Result<SystemAbilityContent, PortError> {
    let builtin = get_builtin(ctx, &reference.identity())?;
    let current = builtin.reference();
    if &current != reference {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(SystemAbilityContent::new(
        current.id,
        current.revision,
        digest(builtin.instructions.as_bytes()),
        builtin.instructions,
    )?)
}

fn get_builtin(
    ctx: &AccountContext,
    identity: &AbilityIdentity,
) -> Result<&'static Builtin, PortError> {
    if identity.placement != AbilityPlacement::System {
        return Err(DomainError::ResourceNotFound.into());
    }
    BUILTINS
        .iter()
        .find(|builtin| builtin.id() == identity.id && visible(ctx, builtin))
        .ok_or_else(|| DomainError::ResourceNotFound.into())
}

fn visible(ctx: &AccountContext, builtin: &Builtin) -> bool {
    match ctx.auth().kind() {
        PrincipalKind::Keeper(_) => ctx.auth().readonly_abilities().contains(&builtin.id()),
        _ => true,
    }
}

fn invalid(reason: ValidationReason) -> PortError {
    DomainError::validation(reason).into()
}

fn cursor_scope(ctx: &AccountContext, query: &AbilityQuery) -> Result<ContentDigest, PortError> {
    #[derive(Serialize)]
    struct Scope<'a> {
        principal: &'a PrincipalId,
        grant: &'a GrantId,
        project: &'a Option<FolderRef>,
        kind: Option<notarium_core::classes::AbilityKind>,
        name: &'a Option<String>,
        authoring: bool,
        visible_revisions: Vec<RevisionId>,
    }
    let scope = Scope {
        principal: ctx.auth().principal(),
        grant: ctx.auth().grant(),
        project: &query.project,
        kind: query.kind,
        name: &query.name,
        authoring: query.authoring,
        visible_revisions: BUILTINS
            .iter()
            .filter(|item| visible(ctx, item))
            .map(Builtin::revision)
            .collect(),
    };
    let bytes = serde_json::to_vec(&scope).map_err(|_| invalid(ValidationReason::InvalidState))?;
    Ok(digest(&bytes))
}

fn system_page(
    ctx: &AccountContext,
    query: &AbilityQuery,
    cursor: Option<&str>,
    limit: usize,
) -> Result<ControlPage<AbilityDescriptor>, PortError> {
    let scope = cursor_scope(ctx, query)?.to_hex();
    let offset = if let Some(cursor) = cursor {
        let (saved, offset) = cursor
            .split_once(':')
            .ok_or_else(|| invalid(ValidationReason::CursorStale))?;
        if saved != scope {
            return Err(invalid(ValidationReason::CursorStale));
        }
        offset
            .parse::<usize>()
            .ok()
            .filter(|offset| *offset < BUILTINS.len())
            .ok_or_else(|| invalid(ValidationReason::CursorStale))?
    } else {
        0
    };
    let mut matching = BUILTINS
        .iter()
        .filter(|item| {
            query.kind.is_none_or(|kind| kind == item.kind)
                && query.name.as_deref().is_none_or(|name| name == item.name)
                && visible(ctx, item)
        })
        .skip(offset);
    let items: Vec<_> = matching
        .by_ref()
        .take(limit)
        .map(Builtin::descriptor)
        .collect();
    let continuation = matching
        .next()
        .map(|_| format!("{SYSTEM_CURSOR_PREFIX}{scope}:{}", offset + items.len()));
    if cursor.is_some() && items.is_empty() {
        return Err(invalid(ValidationReason::CursorStale));
    }
    Ok(ControlPage {
        items,
        continuation,
    })
}

impl<C: ControlCatalogPort + ?Sized> ControlCatalogPort for SystemAbilityCatalog<C> {
    fn space(&self, budget: CallBudget, space: SpaceId) -> PortFuture<'_, CatalogSpace> {
        self.owned.space(budget, space)
    }

    fn agent_run_has_head(
        &self,
        budget: CallBudget,
        space: SpaceId,
        run: AgentRunId,
    ) -> PortFuture<'_, bool> {
        self.owned.agent_run_has_head(budget, space, run)
    }

    fn projects(
        &self,
        ctx: SpaceContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ProjectInfo>> {
        self.owned.projects(ctx, page)
    }

    fn project(&self, ctx: SpaceContext, project: FolderRef) -> PortFuture<'_, ProjectInfo> {
        self.owned.project(ctx, project)
    }

    fn project_by_slug(&self, ctx: SpaceContext, slug: String) -> PortFuture<'_, ProjectInfo> {
        self.owned.project_by_slug(ctx, slug)
    }

    fn abilities(
        &self,
        ctx: AccountContext,
        query: AbilityQuery,
    ) -> PortFuture<'_, ControlPage<AbilityDescriptor>> {
        Box::pin(async move {
            let limit = usize::from(query.page.limit());
            let cursor = query.page.continuation();
            if cursor.is_some_and(|cursor| cursor.len() > MAX_CATALOG_CURSOR_BYTES) {
                return Err(invalid(ValidationReason::CursorStale));
            }
            if let Some(cursor) =
                cursor.and_then(|cursor| cursor.strip_prefix(SYSTEM_CURSOR_PREFIX))
            {
                return system_page(&ctx, &query, Some(cursor), limit);
            }

            let mut page = self.owned.abilities(ctx.clone(), query.clone()).await?;
            if page.items.len() > limit
                || page
                    .items
                    .iter()
                    .any(|item| item.reference.placement == AbilityPlacement::System)
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            if let Some(cursor) = &page.continuation {
                // The owned catalog's continuation is already bounded and
                // bound to its snapshot. Forward it without changing its bytes.
                if cursor.is_empty()
                    || cursor.len() > MAX_CATALOG_CURSOR_BYTES
                    || cursor.starts_with(SYSTEM_CURSOR_PREFIX)
                {
                    return Err(invalid(ValidationReason::InvalidState));
                }
                return Ok(page);
            }
            let system = system_page(&ctx, &query, None, limit - page.items.len())?;
            page.items.extend(system.items);
            page.continuation = system.continuation;
            Ok(page)
        })
    }

    fn ability(
        &self,
        ctx: AccountContext,
        reference: AbilityRef,
    ) -> PortFuture<'_, AbilityDescriptor> {
        if reference.placement != AbilityPlacement::System {
            return self.owned.ability(ctx, reference);
        }
        Box::pin(async move {
            let item = get_builtin(&ctx, &reference.identity())?;
            if item.reference() != reference {
                return Err(DomainError::ResourceNotFound.into());
            }
            Ok(item.descriptor())
        })
    }

    fn current_ability(
        &self,
        ctx: AccountContext,
        identity: AbilityIdentity,
    ) -> PortFuture<'_, AbilityDescriptor> {
        if identity.placement != AbilityPlacement::System {
            return self.owned.current_ability(ctx, identity);
        }
        Box::pin(async move { Ok(get_builtin(&ctx, &identity)?.descriptor()) })
    }

    fn locate_ability(
        &self,
        ctx: AccountContext,
        id: AbilityId,
    ) -> PortFuture<'_, Vec<AbilityDescriptor>> {
        Box::pin(async move {
            let mut found = Vec::new();
            let system_id = AbilityIdentity {
                id: id.clone(),
                placement: AbilityPlacement::System,
            };
            if let Ok(item) = get_builtin(&ctx, &system_id) {
                found.push(item.descriptor());
            }
            let owned = self.owned.locate_ability(ctx, id).await?;
            for item in owned {
                found.push(item);
                if found.len() >= 200 {
                    break;
                }
            }
            Ok(found)
        })
    }

    fn pin_schedule_abilities(
        &self,
        ctx: AccountContext,
        refs: Vec<AbilityRef>,
    ) -> PortFuture<'_, Box<dyn ScheduleAbilityLease>> {
        Box::pin(async move {
            let mut owned = Vec::new();
            let mut abilities = Vec::with_capacity(refs.len());
            for reference in refs {
                if reference.placement == AbilityPlacement::System {
                    abilities.push(self.ability(ctx.clone(), reference).await?);
                } else {
                    owned.push(reference);
                }
            }
            let inner = self.owned.pin_schedule_abilities(ctx, owned).await?;
            abilities.extend_from_slice(inner.abilities());
            Ok(Box::new(SystemScheduleLease { inner, abilities }) as Box<dyn ScheduleAbilityLease>)
        })
    }

    fn note(&self, ctx: AccountContext, note: NoteRef) -> PortFuture<'_, CatalogNote> {
        self.owned.note(ctx, note)
    }

    fn locate_note(&self, ctx: AccountContext, note: NoteId) -> PortFuture<'_, CatalogNote> {
        self.owned.locate_note(ctx, note)
    }

    fn folder(&self, ctx: AccountContext, folder: FolderRef) -> PortFuture<'_, CatalogFolder> {
        self.owned.folder(ctx, folder)
    }

    fn disclosure(
        &self,
        ctx: AccountContext,
        source: CatalogDisclosure,
    ) -> PortFuture<'_, CanonicalMetadataContent> {
        self.owned.disclosure(ctx, source)
    }

    fn folder_disclosures(
        &self,
        ctx: AccountContext,
        folders: Vec<FolderRef>,
    ) -> PortFuture<'_, Vec<CanonicalMetadataContent>> {
        self.owned.folder_disclosures(ctx, folders)
    }

    fn existing_projects(
        &self,
        ctx: AccountContext,
        projects: Vec<FolderRef>,
    ) -> PortFuture<'_, Vec<FolderRef>> {
        self.owned.existing_projects(ctx, projects)
    }

    fn ensure_space(
        &self,
        budget: CallBudget,
        request: EnsureCatalogSpace,
    ) -> PortFuture<'_, CatalogSpace> {
        self.owned.ensure_space(budget, request)
    }

    fn change_lifecycle(
        &self,
        budget: CallBudget,
        identity: notarium_core::receipt::AccountCommandIdentity,
        scope: HistoryScope,
        lifecycle: SpaceLifecycle,
    ) -> PortFuture<'_, CatalogSpace> {
        self.owned
            .change_lifecycle(budget, identity, scope, lifecycle)
    }

    fn resolve_or_ensure_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> PortFuture<'_, ResolvedMemoryTarget> {
        self.owned
            .resolve_or_ensure_memory_target(ctx, target, category)
    }

    fn inspect_memory_target(
        &self,
        ctx: AccountContext,
        target: MemoryTarget,
        category: String,
    ) -> PortFuture<'_, MemoryTargetSnapshot> {
        self.owned.inspect_memory_target(ctx, target, category)
    }
}

struct SystemScheduleLease {
    inner: Box<dyn ScheduleAbilityLease>,
    abilities: Vec<AbilityDescriptor>,
}

impl ScheduleAbilityLease for SystemScheduleLease {
    fn abilities(&self) -> &[AbilityDescriptor] {
        &self.abilities
    }

    fn history(&self) -> &HistoryScope {
        self.inner.history()
    }

    fn close(&mut self) -> PortFuture<'_, ()> {
        self.inner.close()
    }
}

struct SystemEgressLease {
    inner: Box<dyn ProviderEgressLease>,
    current: Vec<ProviderCurrentContent>,
}

impl ProviderEgressLease for SystemEgressLease {
    fn current(&self) -> &[ProviderCurrentContent] {
        &self.current
    }

    fn project(&self) -> Option<&FolderRef> {
        self.inner.project()
    }

    fn secondary_projects(&self) -> &[FolderRef] {
        self.inner.secondary_projects()
    }

    fn project_folders(&self) -> &BTreeSet<FolderId> {
        self.inner.project_folders()
    }

    fn mark_dispatched(&mut self) -> PortFuture<'_, ()> {
        self.inner.mark_dispatched()
    }

    fn close(&mut self) -> PortFuture<'_, ()> {
        self.inner.close()
    }

    fn check(&self) -> notarium_core::DomainResult<()> {
        self.inner.check()
    }
}

impl<C: ProviderEgressCatalogPort + ?Sized> ProviderEgressCatalogPort for SystemAbilityCatalog<C> {
    fn chat_dependencies(
        &self,
        ctx: AccountContext,
        roots: Vec<ProviderOrigin>,
    ) -> PortFuture<'_, ProviderEgressDependencies> {
        self.owned.chat_dependencies(ctx, roots)
    }

    fn acquire_egress(
        &self,
        ctx: AccountContext,
        mut request: ProviderEgressRequest,
        cancellation: Cancellation,
    ) -> PortFuture<'_, Box<dyn ProviderEgressLease>> {
        Box::pin(async move {
            if request.origins.len() > MAX_PROVIDER_ORIGINS {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
            let requested = std::mem::take(&mut request.origins);
            let mut system = Vec::with_capacity(requested.len());
            for origin in requested {
                match origin {
                    ProviderOrigin::SystemAbility {
                        ability,
                        revision,
                        digest: expected,
                    } => {
                        let builtin = get_builtin(
                            &ctx,
                            &AbilityIdentity {
                                id: ability.clone(),
                                placement: AbilityPlacement::System,
                            },
                        )?;
                        let actual = digest(builtin.instructions.as_bytes());
                        if builtin.revision() != revision || actual != expected {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        system.push(Some(ProviderCurrentContent::SystemAbility {
                            ability,
                            revision,
                            digest: actual,
                        }));
                    }
                    other => {
                        request.origins.push(other);
                        system.push(None);
                    }
                }
            }
            let mut inner = self
                .owned
                .acquire_egress(ctx, request, cancellation)
                .await?;
            let current = {
                let mut owned = inner.current().iter().cloned();
                let mapped = system
                    .into_iter()
                    .map(|item| {
                        item.or_else(|| owned.next())
                            .ok_or_else(|| invalid(ValidationReason::InvalidState))
                    })
                    .collect::<Result<Vec<_>, _>>();
                match mapped {
                    Ok(current) if owned.next().is_none() => Ok(current),
                    Ok(_) => Err(invalid(ValidationReason::InvalidState)),
                    Err(error) => Err(error),
                }
            };
            let current = match current {
                Ok(current) => current,
                Err(error) => {
                    let _ = inner.close().await;
                    return Err(error);
                }
            };
            Ok(Box::new(SystemEgressLease { inner, current }) as Box<dyn ProviderEgressLease>)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notarium_core::auth::{EngineAuthContext, SpaceGrant, SpaceRole, VerifiedHuman};
    use notarium_core::classes::DocClass;
    use std::collections::BTreeMap;

    #[test]
    fn system_builtins_and_pages_follow_strictly_monotonic_ranks() {
        let expected_ranks: Vec<usize> = (0..BUILTINS.len()).collect();
        let actual_ranks: Vec<usize> = BUILTINS
            .iter()
            .map(|b| system_ability_rank(&b.id()).expect("builtin rank"))
            .collect();
        assert_eq!(actual_ranks, expected_ranks);
        let mut spaces = BTreeMap::new();
        spaces.insert(
            SpaceId::from_bytes([1; 16]),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        );
        let auth = EngineAuthContext::for_human(
            VerifiedHuman::attest(
                PrincipalId::from_bytes([2; 16]),
                GrantId::from_bytes([3; 16]),
                spaces,
                true,
            )
            .with_human_management(true),
        );
        let ctx = AccountContext::new(
            auth,
            CallBudget {
                request: RequestId::from_bytes([4; 16]),
                cancellation: Cancellation::default(),
                remaining: std::time::Duration::from_secs(5),
            },
        );
        let query = AbilityQuery {
            page: ControlPageRequest::new(1, None).unwrap(),
            project: None,
            kind: None,
            name: None,
            authoring: false,
        };
        for limit in 1..=BUILTINS.len() {
            let mut seen_ranks = Vec::new();
            let mut cursor: Option<String> = None;
            loop {
                let raw_cursor = cursor
                    .as_deref()
                    .and_then(|c| c.strip_prefix(SYSTEM_CURSOR_PREFIX));
                let page = system_page(&ctx, &query, raw_cursor, limit).unwrap();
                seen_ranks.extend(
                    page.items
                        .into_iter()
                        .map(|d| system_ability_rank(&d.reference.id).unwrap()),
                );
                match page.continuation {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
            assert_eq!(
                seen_ranks, expected_ranks,
                "limit={limit} must yield all builtins in strictly monotonic rank order"
            );
        }
    }
}
