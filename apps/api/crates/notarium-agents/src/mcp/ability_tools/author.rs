use std::collections::BTreeMap;

use notarium_core::{
    auth::{SpaceKind, SpaceRole},
    model::{HistoryScope, NoteRef},
    patch::{CarrierEditOrigin, CarrierPatchPlan},
    receipt::{CausalBasis, ReceiptSet},
};
use notarium_syntax::{carrier::Carrier, frontmatter::FieldEdit, patch, unicode};

use super::*;
use crate::abilities::is_reserved_ability_name;

#[derive(Deserialize)]
#[serde(tag = "home", rename_all = "lowercase")]
enum Placement {
    Personal,
    Space { space: String },
    Project { project: String },
}
#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
enum Availability {
    AllProjects,
    SelectedProjects { projects: Vec<String> },
}
#[derive(Deserialize)]
struct Attachment {
    #[serde(rename = "ref")]
    reference: String,
    label: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreateArgs {
    kind: Kind,
    name: String,
    description: String,
    instructions: String,
    placement: Placement,
    attachments: Option<Vec<Attachment>>,
    availability: Option<Availability>,
    session: Option<EpisodeId>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Home {
    Space,
}
#[derive(Deserialize)]
struct Destination {
    home: Home,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EditArgs {
    #[serde(rename = "ref")]
    reference: String,
    version_token: Option<String>,
    description: Option<String>,
    instructions: Option<String>,
    attachments: Option<Vec<Attachment>>,
    availability: Option<Availability>,
    enabled: Option<bool>,
    home: Option<Destination>,
    session: Option<EpisodeId>,
}
#[derive(Deserialize)]
pub(super) struct DeleteArgs {
    #[serde(rename = "ref")]
    reference: String,
    session: Option<EpisodeId>,
}

#[derive(Clone, Serialize, Deserialize)]
struct NewHome {
    scope: HistoryScope,
    parent: Option<FolderId>,
    placement: AbilityPlacement,
}

async fn new_home(call: &ToolCallContext<'_>, input: &Placement) -> Result<NewHome, PortError> {
    let (scope, placement) = match input {
        Placement::Personal => {
            let principal = call.registry.control.whoami(call.account()).await?;
            let space = principal
                .personal_space
                .ok_or(DomainError::ResourceNotFound)?;
            let scope = session::space(call, &space).await?;
            (scope, AbilityPlacement::OwnedPersonal(principal.principal))
        }
        Placement::Space { space } => {
            let scope = session::resolve_space(call, space).await?;
            let record = call
                .registry
                .catalog
                .space(call.budget(), scope.scope().space_id.clone())
                .await?;
            scope.check_current(&record.history)?;
            if record.space.kind != SpaceKind::Shared {
                return Err(invalid(ValidationReason::ScopeMismatch));
            }
            let placement = AbilityPlacement::OwnedSpace(record.space.id);
            (scope, placement)
        }
        Placement::Project { project } => {
            let project = session::resolve_project(call, project).await?.folder;
            let scope = session::space(call, &project.space_id).await?;
            (scope, AbilityPlacement::OwnedProject(project))
        }
    };
    let parent = match &placement {
        AbilityPlacement::OwnedProject(project) => Some(project.folder_id.clone()),
        _ => None,
    };
    require_skill_write(scope.auth(), &scope.scope().space_id)?;
    Ok(NewHome {
        scope: scope.scope().clone(),
        parent,
        placement,
    })
}

fn require_skill_write(
    auth: &notarium_core::auth::EngineAuthContext,
    space: &SpaceId,
) -> Result<(), PortError> {
    auth.authorize_ability_mutation()?;
    let grant = auth
        .spaces()
        .get(space)
        .ok_or(DomainError::ResourceNotFound)?;
    if grant.role == SpaceRole::Viewer || !grant.write_classes.contains(&DocClass::Skill) {
        return Err(DomainError::SpaceReadOnly.into());
    }
    Ok(())
}

async fn writer(
    call: &ToolCallContext<'_>,
    history: &HistoryScope,
) -> Result<SpaceContext, PortError> {
    call.registry
        .control
        .fence_canonical_effect(
            call.auth.clone(),
            call.space(history.clone())?,
            CanonicalEffect::AbilityAuthoring,
        )
        .await
}

async fn select_projects(
    call: &ToolCallContext<'_>,
    selection: Option<&Availability>,
    space: &SpaceId,
) -> Result<AbilityProjects, PortError> {
    match selection {
        Some(Availability::SelectedProjects { projects }) => {
            if projects.len() > 200 {
                return Err(invalid(ValidationReason::InvalidLimit));
            }
            let target_space = session::readable_space(call, space).await?;
            let mut resolved = Vec::with_capacity(projects.len());
            for handle in projects {
                let project =
                    match session::resolve_project_in_space(call, &target_space, handle).await? {
                        Some(project) => project.folder,
                        None => session::resolve_project(call, handle).await?.folder,
                    };
                if &project.space_id != space || resolved.contains(&project) {
                    return Err(invalid(ValidationReason::ScopeMismatch));
                }
                resolved.push(project);
            }
            resolved.sort_by(|left, right| {
                (&left.space_id, &left.folder_id).cmp(&(&right.space_id, &right.folder_id))
            });
            Ok(AbilityProjects::Selected(resolved))
        }
        Some(Availability::AllProjects) | None => Ok(AbilityProjects::All),
    }
}

async fn resolve_skills(
    call: &ToolCallContext<'_>,
    requested: &[Attachment],
) -> Result<Vec<AbilityRef>, PortError> {
    if requested.len() > MAX_ATTACHED_SKILLS {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let mut skills: Vec<AbilityRef> = Vec::with_capacity(requested.len());
    for attachment in requested {
        let inspection = inspect(call, &attachment.reference).await?;
        let descriptor = inspection.descriptor;
        if descriptor.kind != AbilityKind::Skill || !descriptor.healthy {
            return Err(invalid(ValidationReason::InvalidState));
        }
        if skills
            .iter()
            .any(|other| other.identity() == descriptor.reference.identity())
        {
            return Err(invalid(ValidationReason::DuplicateKey));
        }
        skills.push(descriptor.reference);
    }
    Ok(skills)
}

fn format_attachments(
    requested: &[Attachment],
    skills: &[AbilityRef],
) -> Result<Vec<AuthoredAttachment>, PortError> {
    if requested.len() != skills.len() {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    Ok(requested
        .iter()
        .zip(skills)
        .map(|(input, skill)| AuthoredAttachment {
            identity: skill.identity(),
            label: input.label.clone(),
        })
        .collect())
}

fn set(key: &str, value: YamlValue) -> FieldEdit {
    FieldEdit::Set {
        key: key.into(),
        value,
    }
}

fn json_as_yaml(value: Value) -> Result<YamlValue, PortError> {
    Ok(match value {
        Value::Null => YamlValue::Null,
        Value::Bool(value) => YamlValue::Bool(value),
        Value::String(value) => YamlValue::String(value),
        Value::Array(values) => YamlValue::Sequence(
            values
                .into_iter()
                .map(json_as_yaml)
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(values) => YamlValue::Mapping(
            values
                .into_iter()
                .map(|(key, value)| Ok((key, json_as_yaml(value)?)))
                .collect::<Result<_, PortError>>()?,
        ),
        Value::Number(_) => return Err(invalid(ValidationReason::InvalidState)),
    })
}

fn metadata_edit(
    existing: Option<&YamlValue>,
    kind: AbilityKind,
    attachments: &[AuthoredAttachment],
) -> Result<FieldEdit, PortError> {
    let mut metadata = match existing {
        None => BTreeMap::new(),
        Some(YamlValue::Mapping(value)) => value.clone(),
        Some(_) => return Err(invalid(ValidationReason::FmNotWritable)),
    };
    let mut notarium = match metadata.remove("notarium") {
        None => BTreeMap::new(),
        Some(YamlValue::Mapping(value)) => value,
        Some(_) => return Err(invalid(ValidationReason::FmNotWritable)),
    };
    notarium.insert("kind".into(), YamlValue::String(kind_name(kind).into()));
    if kind == AbilityKind::Role {
        let value = serde_json::to_value(attachments)
            .map_err(|_| invalid(ValidationReason::InvalidState))?;
        notarium.insert("skills".into(), json_as_yaml(value)?);
    }
    metadata.insert("notarium".into(), YamlValue::Mapping(notarium));
    Ok(set("metadata", YamlValue::Mapping(metadata)))
}

fn created_carrier(
    args: &CreateArgs,
    kind: AbilityKind,
    attachments: &[AuthoredAttachment],
) -> Result<String, PortError> {
    let initial = format!("---\n---\n{}", args.instructions);
    let plan = frontmatter::patch_frontmatter(
        &initial,
        DocClass::Skill,
        &[
            set("name", YamlValue::String(args.name.clone())),
            set("description", YamlValue::String(args.description.clone())),
            metadata_edit(None, kind, attachments)?,
        ],
    )?;
    Ok(patch::apply(&initial, &plan)?)
}

fn authored_patch(
    source: &str,
    args: &EditArgs,
    kind: AbilityKind,
    attachments: Option<&[AuthoredAttachment]>,
) -> Result<CarrierPatchPlan, PortError> {
    let mut edited = Vec::new();
    if let Some(description) = &args.description {
        edited.push(set("description", YamlValue::String(description.clone())));
    }
    if let Some(attachments) = attachments {
        let original = frontmatter::analyze(source, DocClass::Skill)?;
        edited.push(metadata_edit(
            original
                .fields
                .as_ref()
                .and_then(|fields| fields.get("metadata")),
            kind,
            attachments,
        )?);
    }
    let carrier = Carrier::scan(source)?;
    let mut changes = if edited.is_empty() {
        Vec::new()
    } else {
        frontmatter::patch_frontmatter(source, DocClass::Skill, &edited)?
            .edits
            .into_iter()
            .map(|edit| (edit.origin, edit.bytes.0, edit.replacement))
            .collect()
    };
    if let Some(instructions) = &args.instructions {
        changes.push((CarrierEditOrigin::Body, carrier.body, instructions.clone()));
    }
    Ok(patch::plan(source, carrier.body, changes)?)
}

fn stable_id(call: &ToolCallContext<'_>, label: &str) -> [u8; 16] {
    let key = call.command_key(label, 0);
    let hash = blake3::hash(key.as_str().as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&hash.as_bytes()[..16]);
    bytes
}

async fn ability_folder(
    call: &ToolCallContext<'_>,
    history: &HistoryScope,
    parent: Option<FolderId>,
) -> Result<notarium_core::ports::EnsuredFolder, PortError> {
    call.registry
        .engine
        .ensure_folder_path(
            writer(call, history).await?,
            Mutation {
                identity: call.command_identity(history, "ability-folder", 0),
                preconditions: Preconditions::default(),
                input: EnsureFolderPath {
                    base: parent,
                    path: ".abilities".into(),
                },
            },
        )
        .await
}

fn post_commit_step_error(label: &str, error: PortError, committed: bool) -> PortError {
    if committed && matches!(error, PortError::Domain(DomainError::RateLimited { .. })) {
        return super::super::note_tools::post_commit_error(label, error);
    }
    super::super::note_tools::batch_operational_error(label, error, committed)
}

fn post_commit_ability_error(label: &str, error: PortError) -> PortError {
    if matches!(error, PortError::Domain(DomainError::AuthenticationFailed)) {
        return error;
    }
    super::super::note_tools::post_commit_error(label, error)
}

#[allow(clippy::too_many_arguments)]
fn committed_response(
    reference: &AbilityRef,
    binding_revision: ControlRevision,
    preference_revision: Option<ControlRevision>,
    name: &str,
    kind: AbilityKind,
    projects: &AbilityProjects,
    enabled: bool,
    healthy: bool,
    outcome: &str,
) -> Result<Value, PortError> {
    let version = Version {
        package: reference.revision.clone(),
        binding: binding_revision,
        preference: preference_revision,
    };
    Ok(json!({
        "ref": reference_token(reference)?,
        "versionToken": version.encode()?,
        "name": name,
        "kind": kind_name(kind),
        "availability": availability(projects),
        "enabled": enabled,
        "healthy": healthy,
        "outcome": outcome,
    }))
}

#[derive(Serialize, Deserialize)]
struct CreatePlan {
    home: NewHome,
    skills: Vec<AbilityRef>,
    availability: AbilityProjects,
    account_revision: ControlRevision,
}

pub(super) async fn create(
    call: &ToolCallContext<'_>,
    args: CreateArgs,
) -> Result<Value, PortError> {
    call.auth.authorize_ability_mutation()?;
    if call.auth.taint().is_tainted() {
        return Err(DomainError::CrossSpaceTainted.into());
    }
    let kind = AbilityKind::from(args.kind);
    let slug = unicode::lookup_key(&args.name);
    unicode::validate_component(&slug)?;
    if slug == "index" {
        return Err(invalid(ValidationReason::InvalidPathComponent));
    }
    if slug.is_empty() || slug.len() > 128 || is_reserved_ability_name(&slug) {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    if args.description.trim().is_empty() {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    unicode::validate_content(&args.description)?;
    unicode::validate_content(&args.instructions)?;
    let attachments = args.attachments.as_deref().unwrap_or_default();
    if kind == AbilityKind::Skill
        && (!attachments.is_empty() || matches!(args.placement, Placement::Project { .. }))
    {
        return Err(invalid(ValidationReason::ScopeMismatch));
    }
    for attachment in attachments {
        if let Some(label) = &attachment.label {
            unicode::validate_content(label)?;
        }
    }
    load_episode(call, args.session.as_ref()).await?;
    let (plan, plan_replayed): (CreatePlan, bool) = {
        let mut invoked_fresh = false;
        let plan = call
            .journal("create-ability-plan", || async {
                invoked_fresh = true;
                let home = new_home(call, &args.placement).await?;
                if let AbilityPlacement::OwnedProject(project) = &home.placement {
                    session::project_for_folder(call, project).await?;
                }
                let skills = resolve_skills(call, attachments).await?;
                let availability =
                    select_projects(call, args.availability.as_ref(), &home.scope.space_id).await?;
                // Pre-check active ability slug conflicts in the target placement
                // BEFORE journaling the plan or creating `.abilities/` / the
                // entrypoint note, so a deterministic `PathConflict` never persists
                // a journal record that would skip the pre-check on retry.
                let slot_project = match &home.placement {
                    AbilityPlacement::OwnedProject(project) => Some(project.clone()),
                    _ => None,
                };
                let space_account = notarium_core::ports::AccountContext::new(
                    call.auth.restrict_to_space(&home.scope.space_id)?,
                    call.budget(),
                );
                const MAX_SLUG_CHECK_PAGES: usize = 64;
                let mut cursor: Option<String> = None;
                for _ in 0..MAX_SLUG_CHECK_PAGES {
                    let existing_same_slug = call
                        .registry
                        .catalog
                        .abilities(
                            space_account.clone(),
                            AbilityQuery {
                                page: ControlPageRequest::new(200, cursor.clone())?,
                                project: slot_project.clone(),
                                kind: None,
                                name: Some(slug.clone()),
                                authoring: true,
                            },
                        )
                        .await?;
                    if existing_same_slug
                        .items
                        .iter()
                        .any(|item| item.reference.placement == home.placement)
                    {
                        return Err(DomainError::PathConflict {
                            target: notarium_core::model::PathTarget {
                                space_id: home.scope.space_id.clone(),
                                parent: home.parent.clone(),
                                component: slug.clone(),
                            },
                        }
                        .into());
                    }
                    match existing_same_slug.continuation {
                        Some(next) => {
                            if cursor.as_ref() == Some(&next) {
                                return Err(invalid(ValidationReason::InvalidState));
                            }
                            cursor = Some(next);
                        }
                        None => {
                            cursor = None;
                            break;
                        }
                    }
                }
                if cursor.is_some() {
                    return Err(invalid(ValidationReason::BudgetExceeded));
                }
                Ok(CreatePlan {
                    home,
                    skills,
                    availability,
                    account_revision: ControlRevision::ZERO,
                })
            })
            .await?;
        (plan, !invoked_fresh)
    };
    const CREATE_LABEL: &str = "notarium.mcp.create-ability.v1";
    if plan_replayed && let AbilityPlacement::OwnedProject(project) = &plan.home.placement {
        let live_opt = match call
            .registry
            .catalog
            .folder(call.account(), project.clone())
            .await
        {
            Ok(folder) => Some(folder),
            Err(PortError::Domain(DomainError::ResourceNotFound)) => None,
            Err(error) => {
                return Err(super::super::note_tools::batch_operational_error(
                    CREATE_LABEL,
                    error,
                    true,
                ));
            }
        };
        if let Some(folder) = live_opt {
            if folder.reference != *project
                || folder.lifecycle == notarium_core::model::Lifecycle::Purged
            {
                return Err(DomainError::ResourceNotFound.into());
            }
        } else {
            let trashed = call
                .registry
                .catalog
                .trashed_folder_ancestry(call.account(), project.clone())
                .await
                .map_err(|error| {
                    super::super::note_tools::batch_operational_error(CREATE_LABEL, error, true)
                })?;
            if trashed.reference != *project {
                return Err(DomainError::ResourceNotFound.into());
            }
        }
    }
    let carrier = created_carrier(&args, kind, &format_attachments(attachments, &plan.skills)?)?;
    let ensured_parent = ensure_ability_folder_journaled(
        call,
        &plan.home.scope,
        plan.home.parent.clone(),
        "create-ability-folder",
        CREATE_LABEL,
    )
    .await
    .map_err(|error| {
        super::super::note_tools::batch_operational_error(CREATE_LABEL, error, plan_replayed)
    })?;
    let parent = ensured_parent.folder();
    let folder_created = ensured_parent.created();
    let prior_committed = plan_replayed || folder_created;
    let note_id = NoteId::from_bytes(stable_id(call, "ability-entrypoint-id"));
    let ability_id = AbilityId::from_bytes(stable_id(call, "ability-package-id"));
    let entrypoint = call
        .registry
        .engine
        .create_note(
            writer(call, &plan.home.scope).await.map_err(|error| {
                super::super::note_tools::batch_operational_error(
                    CREATE_LABEL,
                    error,
                    prior_committed,
                )
            })?,
            Mutation {
                identity: call.command_identity(&plan.home.scope, "create-ability-entrypoint", 0),
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: note_id.clone(),
                    parent: Some(parent),
                    class: DocClass::Skill,
                    slug: slug.clone(),
                    carrier,
                    folder_page: false,
                },
            },
        )
        .await
        .map_err(|error| {
            super::super::note_tools::batch_operational_error(CREATE_LABEL, error, prior_committed)
        })?;
    let created = call
        .registry
        .engine
        .publish_ability_package(
            writer(call, &plan.home.scope)
                .await
                .map_err(|error| post_commit_ability_error(CREATE_LABEL, error))?,
            Mutation {
                identity: call.command_identity(&plan.home.scope, "publish-ability-package", 0),
                preconditions: Preconditions::default(),
                input: PublishAbilityPackage {
                    ability: ability_id.clone(),
                    kind,
                    entrypoint: note_id,
                    files: vec![],
                    attached_skills: plan.skills,
                    expected_package_revision: None,
                    expected_entrypoint_revision: Some(entrypoint.value.revision),
                    requires_explicit_binding: matches!(
                        plan.availability,
                        AbilityProjects::Selected(_)
                    ),
                },
            },
        )
        .await
        .map_err(|error| post_commit_ability_error(CREATE_LABEL, error))?;
    let reference = AbilityRef {
        id: ability_id,
        placement: plan.home.placement,
        revision: created.value.revision,
    };
    call.registry
        .control
        .update_ability_binding(
            call.account(),
            AccountMutation {
                identity: call.account_identity(
                    plan.account_revision,
                    "initial-ability-binding",
                    0,
                ),
                input: AbilityBindingUpdate {
                    ability: reference.clone(),
                    enabled: true,
                    projects: plan.availability.clone(),
                    expected: AbilityOverlayGuard::Authored(None),
                },
            },
        )
        .await
        .map_err(|error| post_commit_ability_error(CREATE_LABEL, error))?;
    committed_response(
        &reference,
        ControlRevision::new(1)?,
        None,
        &slug,
        kind,
        &plan.availability,
        true,
        true,
        "created",
    )
}

#[derive(Serialize, Deserialize)]
struct EditPlan {
    scope: HistoryScope,
    entrypoint: NoteId,
    original: AbilityRef,
    previous_note: RevisionId,
    kind: Kind,
    overlays: AbilityOverlayState,
    initial_availability: AbilityProjects,
    initial_healthy: bool,
    #[serde(default)]
    initial_attached_skills: Vec<AbilityRef>,
    #[serde(default)]
    has_auxiliary_files: bool,
    requested_skills: Option<Vec<AbilityRef>>,
    requested_availability: Option<AbilityProjects>,
    account_revision: ControlRevision,
    promote: bool,
}

#[derive(Serialize, Deserialize)]
struct PackageReplayOutcome {
    revision: RevisionId,
    authored_changed: bool,
}

fn kind_value(kind: AbilityKind) -> Kind {
    match kind {
        AbilityKind::Role => Kind::Role,
        AbilityKind::Skill => Kind::Skill,
    }
}

fn read_note_request(note: NoteId, revision: Option<RevisionId>) -> GetNote {
    GetNote {
        note,
        revision,
        causal: CausalBasis::Exact(ReceiptSet::default()),
    }
}

async fn edit_plan(call: &ToolCallContext<'_>, args: &EditArgs) -> Result<EditPlan, PortError> {
    let inspection = inspect(call, &args.reference).await?;
    let descriptor = inspection.descriptor.clone();
    let entry = descriptor
        .entrypoint
        .as_ref()
        .ok_or(DomainError::AbilityWriteForbidden)?;
    let scope = session::space(call, &entry.space_id).await?;
    require_skill_write(scope.auth(), &entry.space_id)?;
    if let Some(token) = &args.version_token {
        let supplied = Version::decode(token)?;
        let current = Version::from_inspection(&inspection);
        if supplied.package != current.package {
            return Err(DomainError::RevisionConflict {
                current: current.package,
                lineage: None,
            }
            .into());
        }
        if supplied.binding != current.binding {
            return Err(DomainError::ControlRevisionConflict {
                current: current.binding,
            }
            .into());
        }
        if supplied.preference != current.preference {
            return Err(DomainError::ControlRevisionConflict {
                current: current.preference.unwrap_or(ControlRevision::ZERO),
            }
            .into());
        }
    }
    let authored =
        args.description.is_some() || args.instructions.is_some() || args.attachments.is_some();
    if authored && args.version_token.is_none() {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    if !descriptor.healthy && (authored || args.home.is_some()) {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let promote = if let Some(Destination { home: Home::Space }) = args.home {
        match &descriptor.reference.placement {
            AbilityPlacement::OwnedSpace(_) => false,
            AbilityPlacement::OwnedProject(project) => {
                let record = call
                    .registry
                    .catalog
                    .space(call.budget(), project.space_id.clone())
                    .await?;
                scope.check_current(&record.history)?;
                if record.space.kind != SpaceKind::Shared {
                    return Err(invalid(ValidationReason::ScopeMismatch));
                }
                true
            }
            _ => return Err(invalid(ValidationReason::ScopeMismatch)),
        }
    } else {
        false
    };
    let requested_skills = match &args.attachments {
        Some(attachments) => {
            if descriptor.kind == AbilityKind::Skill && !attachments.is_empty() {
                return Err(invalid(ValidationReason::ScopeMismatch));
            }
            Some(resolve_skills(call, attachments).await?)
        }
        None => None,
    };
    let requested_availability = if let Some(value) = &args.availability {
        let projects = select_projects(call, Some(value), &entry.space_id).await?;
        (promote || projects != inspection.availability).then_some(projects)
    } else {
        None
    };
    let note = call
        .registry
        .engine
        .get_note_metadata(
            scope.clone(),
            read_note_request(entry.note_id.clone(), None),
        )
        .await?;
    ClassEgressFence::mcp_note_metadata(&note.metadata, scope.auth())?;
    Ok(EditPlan {
        scope: scope.scope().clone(),
        entrypoint: entry.note_id.clone(),
        original: descriptor.reference,
        previous_note: note.metadata.revision().clone(),
        kind: kind_value(descriptor.kind),
        overlays: inspection.overlays,
        initial_availability: inspection.availability,
        initial_healthy: descriptor.healthy,
        initial_attached_skills: descriptor.attached_skills,
        has_auxiliary_files: !descriptor.auxiliary_files.is_empty(),
        requested_skills,
        requested_availability,
        account_revision: ControlRevision::ZERO,
        promote,
    })
}

async fn original_package(
    call: &ToolCallContext<'_>,
    plan: &EditPlan,
    allow_promoted: bool,
) -> Result<AbilityDescriptor, PortError> {
    if (plan.promote || allow_promoted)
        && matches!(plan.original.placement, AbilityPlacement::OwnedProject(_))
    {
        let relocated = AbilityRef {
            placement: AbilityPlacement::OwnedSpace(plan.scope.space_id.clone()),
            ..plan.original.clone()
        };
        match call
            .registry
            .catalog
            .ability(call.account(), relocated)
            .await
        {
            Ok(value) => return Ok(value),
            Err(PortError::Domain(DomainError::ResourceNotFound)) => (),
            Err(error) => return Err(error),
        }
    }
    call.registry
        .catalog
        .ability(call.account(), plan.original.clone())
        .await
}

async fn original_slug(
    call: &ToolCallContext<'_>,
    plan: &EditPlan,
    allow_promoted: bool,
) -> Result<String, PortError> {
    match original_package(call, plan, allow_promoted).await {
        Ok(package) => return Ok(package.name),
        Err(PortError::Domain(DomainError::ResourceNotFound)) => (),
        Err(error) => return Err(error),
    }
    let scope = call.space(plan.scope.clone())?;
    let note = call
        .registry
        .engine
        .get_note_metadata(
            scope.clone(),
            read_note_request(plan.entrypoint.clone(), Some(plan.previous_note.clone())),
        )
        .await?;
    note.metadata.listing(scope.auth())?;
    let path = note
        .provenance
        .as_ref()
        .map(|meta| meta.path.as_str())
        .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
    let file = path.rsplit('/').next().unwrap_or(path);
    let stem = file.strip_suffix(".md").unwrap_or(file);
    Ok(notarium_syntax::unicode::lookup_key(stem))
}

async fn auxiliary_files(
    call: &ToolCallContext<'_>,
    plan: &EditPlan,
    package: &AbilityDescriptor,
) -> Result<Vec<AbilityFile>, PortError> {
    let mut files = Vec::with_capacity(package.auxiliary_files.len());
    for path in &package.auxiliary_files {
        let scope = call.space(plan.scope.clone())?;
        let resource = call
            .registry
            .engine
            .read_ability_resource(
                scope.clone(),
                ReadAbilityResource {
                    ability: plan.original.id.clone(),
                    package_revision: plan.original.revision.clone(),
                    resource: AbilityResourceName::Auxiliary(path.clone()),
                },
            )
            .await?;
        files.push(AbilityFile {
            path: path.clone(),
            content: ClassEgressFence::mcp_ability(&resource, scope.auth())?.to_owned(),
            digest: resource.digest(),
        });
    }
    Ok(files)
}

fn change_step(step: &str, outcome: &str, error: Option<&PortError>) -> Value {
    let mut value = json!({"step":step,"outcome":outcome});
    if let Some(error) = error {
        value["error"] = json!({"code":error.code()});
        if let PortError::Domain(DomainError::ValidationFailed { diagnostic }) = error {
            value["error"]["reason"] = json!(diagnostic.reason);
        }
    }
    value
}

fn is_partial_step_error(error: &PortError) -> bool {
    matches!(
        error,
        PortError::Domain(domain)
            if !matches!(
                domain,
                DomainError::RateLimited { .. } | DomainError::AuthenticationFailed
            )
    )
}

fn edit_result(
    reference: &AbilityRef,
    binding_revision: ControlRevision,
    preference_revision: Option<ControlRevision>,
    steps: Vec<Value>,
    error: Option<&PortError>,
) -> Result<Value, PortError> {
    let version = Version {
        package: reference.revision.clone(),
        binding: binding_revision,
        preference: preference_revision,
    };
    Ok(json!({
        "ref": reference_token(reference)?,
        "versionToken": version.encode()?,
        "steps": steps,
        "outcome": if error.is_some() { "partial" } else { "updated" },
    }))
}

pub(super) async fn edit(call: &ToolCallContext<'_>, args: EditArgs) -> Result<Value, PortError> {
    call.auth.authorize_ability_mutation()?;
    if call.auth.taint().is_tainted() {
        return Err(DomainError::CrossSpaceTainted.into());
    }
    let authored =
        args.description.is_some() || args.instructions.is_some() || args.attachments.is_some();
    if let Some(token) = &args.version_token {
        let _ = Version::decode(token)?;
    }
    if authored && args.version_token.is_none() {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    if let Some(description) = &args.description {
        if description.trim().is_empty() {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        unicode::validate_content(description)?;
    }
    if let Some(instructions) = &args.instructions {
        unicode::validate_content(instructions)?;
    }
    if let Some(attachments) = &args.attachments {
        for attachment in attachments {
            if let Some(label) = &attachment.label {
                unicode::validate_content(label)?;
            }
        }
    }
    load_episode(call, args.session.as_ref()).await?;
    let (plan, plan_replayed): (EditPlan, bool) = {
        let mut invoked_fresh = false;
        let plan = call
            .journal("edit-ability-plan", || async {
                invoked_fresh = true;
                edit_plan(call, &args).await
            })
            .await?;
        (plan, !invoked_fresh)
    };
    let mut reference = plan.original.clone();
    let mut steps = Vec::new();
    let mut authored_changed = false;
    let mut folder_ensured = false;
    let mut carrier_edited = false;
    let mut carrier_moved = false;
    let mut published = false;
    let mut promotion = None;
    let mut resolved_slug: Option<String> = None;
    let mut phase = if authored { "authored" } else { "home" };
    let package_result: Result<(), PortError> = async {
        if !authored && !plan.promote {
            return Ok(());
        }
        let mut trashed_replay = false;
        let mut trashed_live_parent: Option<FolderId> = None;
        let journaled_outcome = if plan_replayed {
            call.lookup_journal_with_key::<PackageReplayOutcome>(
                "edit-ability-package-outcome",
                &call.request_key,
                call.request_hash,
            )
            .await?
        } else {
            None
        };
        if let Some(done) = &journaled_outcome {
            // Package publication already committed before a prior failure;
            // mark `published` before any follow-up read so a transient failure
            // in `original_package` still escalates to `CommitEffect::Unknown`.
            authored_changed = done.authored_changed;
            published = authored_changed || plan.promote;
        }
        let (orig_slug, orig_attached_skills, files, already_published) =
            match original_package(call, &plan, plan_replayed).await {
                Ok(original) => {
                    if let Some(done) = journaled_outcome {
                        (
                            original.name,
                            original.attached_skills,
                            Vec::new(),
                            Some(done),
                        )
                    } else {
                        let files = auxiliary_files(call, &plan, &original).await?;
                        (original.name, original.attached_skills, files, None)
                    }
                }
                Err(PortError::Domain(DomainError::ResourceNotFound)) if plan_replayed => {
                    let scope = call.space(plan.scope.clone())?;
                    require_skill_write(scope.auth(), &plan.scope.space_id)?;
                    let live = call
                        .registry
                        .engine
                        .get_note_metadata(
                            scope.clone(),
                            GetNote {
                                note: plan.entrypoint.clone(),
                                revision: None,
                                causal: CausalBasis::Await(Default::default()),
                            },
                        )
                        .await?;
                    if live.metadata.lifecycle() != notarium_core::model::Lifecycle::Trashed {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    live.metadata.listing(scope.auth())?;
                    trashed_live_parent = live.parent.clone();
                    let slug = original_slug(call, &plan, plan_replayed).await?;
                    trashed_replay = true;
                    (
                        slug,
                        plan.initial_attached_skills.clone(),
                        Vec::new(),
                        journaled_outcome,
                    )
                }
                Err(error) => return Err(error),
            };
        resolved_slug = Some(orig_slug.clone());
        if let Some(done) = already_published {
            authored_changed = done.authored_changed;
            reference.revision = done.revision;
            published = authored_changed || plan.promote;
            if plan.promote {
                phase = "home";
            }
        } else {
            let attachments = args
                .attachments
                .as_deref()
                .zip(plan.requested_skills.as_deref())
                .map(|(inputs, skills)| format_attachments(inputs, skills))
                .transpose()?;
            let skills = plan
                .requested_skills
                .clone()
                .unwrap_or(orig_attached_skills.clone());
            if skills.iter().any(|skill| skill.id == plan.original.id) {
                return Err(invalid(ValidationReason::DuplicateKey));
            }
            let mut note_revision = plan.previous_note.clone();
            let pending_patch = if authored {
                let scope = call.space(plan.scope.clone())?;
                let snapshot = call
                    .registry
                    .engine
                    .get_note(
                        scope.clone(),
                        read_note_request(plan.entrypoint.clone(), Some(note_revision.clone())),
                    )
                    .await?;
                let source = if trashed_replay {
                    snapshot.document.explicit_read(scope.auth())?
                } else {
                    if plan.promote {
                        // Verify source carrier writability (including folder write-locks)
                        // before promote creates a Space-root `.abilities` folder.
                        snapshot
                            .document
                            .metadata()
                            .authorize_current_write(scope.auth())?;
                    }
                    ClassEgressFence::mcp_note(&snapshot.document, scope.auth())?
                };
                let patch =
                    authored_patch(source, &args, plan.kind.into(), attachments.as_deref())?;
                authored_changed = !patch.edits.is_empty() || skills != orig_attached_skills;
                (!patch.edits.is_empty()).then_some(patch)
            } else {
                None
            };
            if plan.promote {
                phase = "home";
                if !authored && !trashed_replay {
                    let scope = call.space(plan.scope.clone())?;
                    let live = call
                        .registry
                        .engine
                        .get_note_metadata(
                            scope.clone(),
                            GetNote {
                                note: plan.entrypoint.clone(),
                                revision: None,
                                causal: CausalBasis::Await(Default::default()),
                            },
                        )
                        .await?;
                    live.metadata.authorize_current_write(scope.auth())?;
                }
                let journaled_parent = if plan_replayed {
                    call.lookup_journal_with_key::<JournaledAbilityFolder>(
                        "edit-ability-promote-folder",
                        &call.request_key,
                        call.request_hash,
                    )
                    .await?
                } else {
                    None
                };
                let parent = if let Some(saved) = journaled_parent {
                    folder_ensured = saved.created();
                    saved.folder()
                } else if trashed_replay {
                    if call
                        .lookup_journal_with_key::<bool>(
                            "edit-ability-promote-folder-existed",
                            &call.request_key,
                            call.request_hash,
                        )
                        .await?
                        == Some(false)
                    {
                        folder_ensured = true;
                    }
                    let scope = call.space(plan.scope.clone())?;
                    if let Some(found) = call
                        .registry
                        .engine
                        .resolve_folder_path(scope, None, ".abilities".to_owned())
                        .await?
                    {
                        found.reference.folder_id
                    } else {
                        trashed_live_parent
                            .clone()
                            .ok_or(DomainError::ResourceNotFound)?
                    }
                } else {
                    let ensured = ensure_ability_folder_journaled(
                        call,
                        &plan.scope,
                        None,
                        "edit-ability-promote-folder",
                        "notarium.mcp.edit-ability.v1",
                    )
                    .await?;
                    folder_ensured = ensured.created();
                    ensured.folder()
                };
                let settled = call
                    .registry
                    .engine
                    .move_note(
                        writer(call, &plan.scope).await?,
                        Mutation {
                            identity: call.command_identity(&plan.scope, "move-ability-carrier", 0),
                            preconditions: Preconditions {
                                revision: Some(note_revision.clone()),
                                ..Default::default()
                            },
                            input: MoveNote {
                                note: plan.entrypoint.clone(),
                                parent: Some(parent),
                                slug: orig_slug,
                            },
                        },
                    )
                    .await?;
                note_revision = settled.value.revision;
                carrier_moved = true;
            }
            if let Some(patch) = pending_patch {
                phase = "authored";
                let edited = call
                    .registry
                    .engine
                    .edit_note(
                        writer(call, &plan.scope).await?,
                        Mutation {
                            identity: call.command_identity(&plan.scope, "edit-ability-carrier", 0),
                            preconditions: Preconditions {
                                revision: Some(note_revision),
                                ..Default::default()
                            },
                            input: EditNote {
                                note: plan.entrypoint.clone(),
                                plan: patch,
                            },
                        },
                    )
                    .await?;
                note_revision = edited.value.revision;
                carrier_edited = true;
                if plan.promote {
                    phase = "home";
                }
            }
            if authored_changed || plan.promote {
                if trashed_replay && plan.has_auxiliary_files {
                    return Err(super::super::note_tools::post_commit_error(
                        "notarium.mcp.edit-ability.v1",
                        DomainError::ResourceNotFound.into(),
                    ));
                }
                let package = call
                    .registry
                    .engine
                    .publish_ability_package(
                        writer(call, &plan.scope).await?,
                        Mutation {
                            identity: call.command_identity(
                                &plan.scope,
                                "republish-ability-package",
                                0,
                            ),
                            preconditions: Preconditions::default(),
                            input: PublishAbilityPackage {
                                ability: plan.original.id.clone(),
                                kind: plan.kind.into(),
                                entrypoint: plan.entrypoint.clone(),
                                files,
                                attached_skills: skills,
                                expected_package_revision: Some(plan.original.revision.clone()),
                                expected_entrypoint_revision: Some(note_revision),
                                requires_explicit_binding: false,
                            },
                        },
                    )
                    .await?;
                reference.revision = package.value.revision.clone();
                published = true;
                let _ = call
                    .record_journal_with_key(
                        "edit-ability-package-outcome",
                        &call.request_key,
                        call.request_hash,
                        &PackageReplayOutcome {
                            revision: package.value.revision,
                            authored_changed,
                        },
                    )
                    .await
                    .map_err(|error| {
                        post_commit_ability_error("notarium.mcp.edit-ability.v1", error)
                    })?;
            }
        }
        if plan.promote {
            let destination = AbilityRef {
                placement: AbilityPlacement::OwnedSpace(plan.scope.space_id.clone()),
                ..reference.clone()
            };
            let result = call
                .registry
                .control
                .set_ability_trail(
                    call.account(),
                    AccountMutation {
                        identity: call.account_identity(
                            plan.account_revision,
                            "adopt-promoted-ability",
                            0,
                        ),
                        input: AbilityTrailMutation::AdoptPromotion(AdoptAbilityPromotion {
                            source: plan.original.clone(),
                            destination: destination.clone(),
                        }),
                    },
                )
                .await?;
            let AbilityTrailResult::Promoted(promoted) = result.value else {
                return Err(invalid(ValidationReason::InvalidState));
            };
            reference = destination;
            promotion = Some(promoted);
        }
        Ok(())
    }
    .await;
    const EDIT_LABEL: &str = "notarium.mcp.edit-ability.v1";
    if let Err(error) = package_result {
        let partial_package = carrier_edited || carrier_moved || published;
        if !partial_package || !is_partial_step_error(&error) {
            return Err(post_commit_step_error(
                EDIT_LABEL,
                error,
                partial_package || folder_ensured || plan_replayed,
            ));
        }
        let uncommitted_promotion = plan.promote && promotion.is_none();
        let report_ref = if uncommitted_promotion {
            &plan.original
        } else {
            &reference
        };
        for step in ["authored", "home", "availability", "enabled"] {
            steps.push(
                if step == "authored" && authored_changed && published && !uncommitted_promotion {
                    change_step(step, "applied", None)
                } else if step == phase
                    || (step == "authored"
                        && (carrier_edited || (authored_changed && uncommitted_promotion)))
                {
                    change_step(step, "failed", Some(&error))
                } else {
                    change_step(step, "skipped", None)
                },
            );
        }
        let partial_overlays = promotion
            .as_ref()
            .map_or(&plan.overlays, |settled| &settled.destination);
        let partial_binding_rev = partial_overlays
            .binding_revision
            .unwrap_or(ControlRevision::ZERO);
        return edit_result(
            report_ref,
            partial_binding_rev,
            partial_overlays.preference_revision,
            steps,
            Some(&error),
        );
    }
    let mut applied_any = authored_changed || promotion.is_some();
    steps.push(change_step(
        "authored",
        if authored_changed {
            "applied"
        } else {
            "skipped"
        },
        None,
    ));
    steps.push(change_step(
        "home",
        if promotion.is_some() {
            "applied"
        } else {
            "skipped"
        },
        None,
    ));

    let overlays = promotion
        .as_ref()
        .map_or(&plan.overlays, |settled| &settled.destination);
    let mut committed_binding_rev = overlays.binding_revision.unwrap_or(ControlRevision::ZERO);
    let mut committed_availability = promotion
        .as_ref()
        .and_then(|settled| settled.destination.availability.clone())
        .unwrap_or_else(|| plan.initial_availability.clone());
    if let Some(availability) = plan.requested_availability.clone() {
        let result = if let Some(promotion) = &promotion
            && promotion.source.binding_revision != plan.overlays.binding_revision
        {
            Err(DomainError::ControlRevisionConflict {
                current: promotion
                    .source
                    .binding_revision
                    .unwrap_or(ControlRevision::ZERO),
            }
            .into())
        } else {
            call.registry
                .control
                .update_ability_binding(
                    call.account(),
                    AccountMutation {
                        identity: call.account_identity(
                            plan.account_revision,
                            "edit-ability-binding",
                            0,
                        ),
                        input: AbilityBindingUpdate {
                            ability: reference.clone(),
                            enabled: overlays.binding_enabled,
                            projects: availability.clone(),
                            expected: AbilityOverlayGuard::Authored(overlays.binding_revision),
                        },
                    },
                )
                .await
        };
        match result {
            Ok(_) => {
                applied_any = true;
                let next_rev = overlays
                    .binding_revision
                    .map_or(0, ControlRevision::get)
                    .checked_add(1)
                    .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
                committed_binding_rev = ControlRevision::new(next_rev)?;
                committed_availability = availability;
                steps.push(change_step("availability", "applied", None));
            }
            Err(error) => {
                if !applied_any || !is_partial_step_error(&error) {
                    return Err(post_commit_step_error(
                        EDIT_LABEL,
                        error,
                        applied_any || plan_replayed,
                    ));
                }
                steps.push(change_step("availability", "failed", Some(&error)));
                steps.push(change_step("enabled", "skipped", None));
                return edit_result(
                    &reference,
                    committed_binding_rev,
                    overlays.preference_revision,
                    steps,
                    Some(&error),
                );
            }
        }
    } else {
        steps.push(change_step("availability", "skipped", None));
    }

    let mut committed_preference_enabled = overlays.preference_enabled;
    let mut committed_preference_rev = overlays.preference_revision;
    let promotion_preference_conflict = promotion
        .as_ref()
        .filter(|settled| settled.source.preference_revision != plan.overlays.preference_revision)
        .map(|settled| {
            settled
                .source
                .preference_revision
                .unwrap_or(ControlRevision::ZERO)
        });
    if let Some(enabled) = args.enabled.filter(|enabled| {
        promotion_preference_conflict.is_some() || *enabled != overlays.preference_enabled
    }) {
        let result = async {
            if let Some(current) = promotion_preference_conflict {
                return Err(DomainError::ControlRevisionConflict { current }.into());
            }
            call.registry
                .control
                .set_ability_preference(
                    call.account(),
                    AccountMutation {
                        identity: call.account_identity(
                            plan.account_revision,
                            "edit-ability-preference",
                            0,
                        ),
                        input: AbilityPreferenceChange {
                            preference: AbilityPreferenceUpdate {
                                ability: reference.clone(),
                                enabled,
                            },
                            expected: AbilityPreferenceGuard::Authored(
                                overlays.preference_revision,
                            ),
                        },
                    },
                )
                .await
        }
        .await;
        match result {
            Ok(commit) => {
                applied_any = true;
                committed_preference_enabled = enabled;
                committed_preference_rev = Some(commit.revision);
                steps.push(change_step("enabled", "applied", None));
            }
            Err(error) => {
                if !applied_any || !is_partial_step_error(&error) {
                    return Err(post_commit_step_error(
                        EDIT_LABEL,
                        error,
                        applied_any || plan_replayed,
                    ));
                }
                steps.push(change_step("enabled", "failed", Some(&error)));
                return edit_result(
                    &reference,
                    committed_binding_rev,
                    committed_preference_rev,
                    steps,
                    Some(&error),
                );
            }
        }
    } else {
        steps.push(change_step("enabled", "skipped", None));
    }
    let committed_healthy = if authored_changed || promotion.is_some() {
        true
    } else {
        plan.initial_healthy
    };
    let committed_enabled = overlays.binding_enabled && committed_preference_enabled;
    let slug = match resolved_slug {
        Some(slug) => slug,
        None => original_slug(call, &plan, plan_replayed)
            .await
            .map_err(|error| {
                if applied_any {
                    post_commit_ability_error(EDIT_LABEL, error)
                } else {
                    post_commit_step_error(EDIT_LABEL, error, false)
                }
            })?,
    };
    let mut result = committed_response(
        &reference,
        committed_binding_rev,
        committed_preference_rev,
        &slug,
        AbilityKind::from(plan.kind),
        &committed_availability,
        committed_enabled,
        committed_healthy,
        "updated",
    )?;
    result["steps"] = json!(steps);
    Ok(result)
}

#[derive(Serialize, Deserialize)]
struct TrashPlan {
    scope: HistoryScope,
    reference: AbilityRef,
    entrypoint: NoteRef,
    note_revision: RevisionId,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum JournaledAbilityFolder {
    Detailed { folder: FolderId, created: bool },
    Legacy(FolderId),
}

impl JournaledAbilityFolder {
    fn folder(&self) -> FolderId {
        match self {
            Self::Detailed { folder, .. } | Self::Legacy(folder) => folder.clone(),
        }
    }

    fn created(&self) -> bool {
        match self {
            Self::Detailed { created, .. } => *created,
            Self::Legacy(_) => true,
        }
    }
}

async fn ensure_ability_folder_journaled(
    call: &ToolCallContext<'_>,
    scope: &HistoryScope,
    parent: Option<FolderId>,
    label: &str,
    err_label: &str,
) -> Result<JournaledAbilityFolder, PortError> {
    if let Some(saved) = call
        .lookup_journal_with_key::<JournaledAbilityFolder>(
            label,
            &call.request_key,
            call.request_hash,
        )
        .await?
    {
        return Ok(saved);
    }
    let existed_label = format!("{label}-existed");
    let mut existed_replayed = true;
    let existed: bool = call
        .journal_with_key(
            &existed_label,
            &call.request_key,
            call.request_hash,
            || async {
                existed_replayed = false;
                let space = call.space(scope.clone())?;
                super::super::note_tools::live_folder_exists_at(
                    call,
                    &space,
                    parent.as_ref(),
                    ".abilities",
                )
                .await
            },
        )
        .await
        .map_err(|error| {
            super::super::note_tools::batch_operational_error(err_label, error, false)
        })?;
    let ensured = ability_folder(call, scope, parent).await.map_err(|error| {
        super::super::note_tools::batch_operational_error(
            err_label,
            error,
            existed_replayed && !existed,
        )
    })?;
    let recorded = JournaledAbilityFolder::Detailed {
        folder: ensured.folder.folder_id,
        created: ensured.created,
    };
    call.record_journal_with_key(label, &call.request_key, call.request_hash, &recorded)
        .await
        .map_err(|error| {
            if recorded.created() {
                post_commit_ability_error(err_label, error)
            } else {
                super::super::note_tools::batch_operational_error(err_label, error, false)
            }
        })
}

pub(super) async fn trash(
    call: &ToolCallContext<'_>,
    args: DeleteArgs,
) -> Result<Value, PortError> {
    call.auth.authorize_ability_mutation()?;
    if call.auth.taint().is_tainted() {
        return Err(DomainError::CrossSpaceTainted.into());
    }
    load_episode(call, args.session.as_ref()).await?;
    let plan: TrashPlan = call
        .journal("trash-ability-plan", || async {
            let inspected = inspect(call, &args.reference).await?;
            let descriptor = inspected.descriptor;
            let entrypoint = descriptor
                .entrypoint
                .ok_or(DomainError::AbilityWriteForbidden)?;
            if !descriptor.auxiliary_files.is_empty() {
                return Err(invalid(ValidationReason::InvalidState));
            }
            let scope = session::space(call, &entrypoint.space_id).await?;
            require_skill_write(scope.auth(), &entrypoint.space_id)?;
            let note = call
                .registry
                .engine
                .get_note_metadata(
                    scope.clone(),
                    read_note_request(entrypoint.note_id.clone(), None),
                )
                .await?;
            ClassEgressFence::mcp_note_metadata(&note.metadata, scope.auth())?;
            Ok(TrashPlan {
                scope: scope.scope().clone(),
                reference: descriptor.reference,
                entrypoint,
                note_revision: note.metadata.revision().clone(),
            })
        })
        .await?;
    let result = call
        .registry
        .engine
        .trash_ability_package(
            writer(call, &plan.scope).await?,
            Mutation {
                identity: call.command_identity(&plan.scope, "trash-ability-package", 0),
                preconditions: Preconditions {
                    revision: Some(plan.note_revision),
                    ..Default::default()
                },
                input: TrashAbilityPackage {
                    ability: plan.reference.id.clone(),
                    entrypoint: plan.entrypoint.note_id.clone(),
                    package_revision: plan.reference.revision.clone(),
                },
            },
        )
        .await?;
    const TRASH_LABEL: &str = "notarium.mcp.trash-ability-receipt.v1";
    plan.scope
        .check(result.receipt.scope())
        .map_err(|error| super::super::note_tools::post_commit_error(TRASH_LABEL, error.into()))?;
    if result.value.note != plan.entrypoint.note_id {
        return Err(super::super::note_tools::post_commit_error(
            TRASH_LABEL,
            invalid(ValidationReason::SourceMismatch),
        ));
    }
    Ok(
        json!({"ref":reference_token(&plan.reference)?,"noteId":plan.entrypoint.note_id,"versionToken":result.value.revision,"outcome":"trashed"}),
    )
}
