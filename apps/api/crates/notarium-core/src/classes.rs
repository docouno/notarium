//! Classified content cannot cross secondary surfaces through a raw-text port.
use crate::{
    DomainError, DomainResult,
    auth::{EngineAuthContext, ResourceFacts, Space, SpaceKind},
    document::{ChunkDescriptor, render_chunk},
    error::ValidationReason,
    ids::{
        AbilityId, ChatThreadId, ContentDigest, FolderId, ModelProfileId, PrincipalId,
        ProviderResourceId, RevisionId, SpaceId, ThreadEntrySeq,
    },
    model::{AbilityResourceRef, FolderRef, HistoryScope, Lifecycle, NoteRef},
    ports::{AbilityPlacement, ChatProvenance},
    span::ByteSpan,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fmt, sync::Arc};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DocClass {
    UserDoc,
    EncryptedNote,
    AgentMemory,
    Skill,
    Profile,
}
impl DocClass {
    pub fn all() -> BTreeSet<Self> {
        [
            Self::UserDoc,
            Self::EncryptedNote,
            Self::AgentMemory,
            Self::Skill,
            Self::Profile,
        ]
        .into()
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum AbilityKind {
    Role,
    Skill,
}

#[derive(Clone)]
struct DocumentFacts {
    recorded: ResourceFacts,
    current: Option<Box<(ResourceFacts, Lifecycle)>>,
}
impl DocumentFacts {
    fn new(recorded: ResourceFacts) -> Self {
        Self {
            recorded,
            current: None,
        }
    }

    fn iter(&self) -> impl Iterator<Item = &ResourceFacts> {
        std::iter::once(&self.recorded).chain(self.current.as_deref().map(|(facts, _)| facts))
    }

    fn bind_current(
        &mut self,
        recorded_lifecycle: Lifecycle,
        facts: ResourceFacts,
        lifecycle: Lifecycle,
    ) -> DomainResult<()> {
        if self.recorded.space.id != facts.space.id || self.current.is_some() {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        if self.recorded != facts || recorded_lifecycle != lifecycle {
            self.current = Some(Box::new((facts, lifecycle)));
        }
        Ok(())
    }

    fn in_project(&self, project: &crate::model::FolderRef) -> bool {
        self.recorded.space.id == project.space_id
            && self
                .iter()
                .all(|facts| facts.ancestor_folders.contains(&project.folder_id))
    }

    fn authorize(&self, auth: &EngineAuthContext) -> DomainResult<()> {
        if let Some((current, _)) = self.current.as_deref() {
            auth.can_view_resource(current)?;
        }
        auth.authorize_read(&self.recorded)
    }

    fn allow_egress(&self, lifecycle: Lifecycle, auth: &EngineAuthContext) -> DomainResult<()> {
        if self
            .iter()
            .any(|facts| facts.class == DocClass::EncryptedNote)
        {
            return Err(DomainError::validation(
                ValidationReason::ClassEgressForbidden,
            ));
        }
        if lifecycle != Lifecycle::Active
            || self
                .current
                .as_deref()
                .is_some_and(|(_, now)| *now != Lifecycle::Active)
        {
            return Err(DomainError::ResourceNotFound);
        }
        self.authorize(auth)
    }

    fn allow_provider(&self, policy: &ProviderPolicy) -> DomainResult<()> {
        self.iter().try_for_each(|facts| {
            ClassEgressFence::provider_policy(&facts.space, facts.class, policy)
        })
    }
}

/// Canonical metadata can be admitted without loading a document's carrier.
/// The owning adapter attests provenance and current resource facts.
/// ```compile_fail
/// use notarium_core::classes::ClassifiedMetadata;
/// let _: ClassifiedMetadata = serde_json::from_str("{}").unwrap();
/// ```
#[derive(Clone)]
pub struct ClassifiedMetadata {
    reference: NoteRef,
    revision: RevisionId,
    facts: DocumentFacts,
    lifecycle: Lifecycle,
    digest: ContentDigest,
}
impl fmt::Debug for ClassifiedMetadata {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClassifiedMetadata")
            .field("reference", &self.reference)
            .field("revision", &self.revision)
            .field("class", &self.facts.recorded.class)
            .finish_non_exhaustive()
    }
}
impl ClassifiedMetadata {
    pub fn from_canonical(
        reference: NoteRef,
        revision: RevisionId,
        facts: ResourceFacts,
        lifecycle: Lifecycle,
        digest: ContentDigest,
    ) -> DomainResult<Self> {
        if reference.space_id != facts.space.id {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        Ok(Self {
            reference,
            revision,
            facts: DocumentFacts::new(facts),
            lifecycle,
            digest,
        })
    }
    pub fn bind_current(&mut self, facts: ResourceFacts, lifecycle: Lifecycle) -> DomainResult<()> {
        self.facts.bind_current(self.lifecycle, facts, lifecycle)
    }
    pub fn reference(&self) -> &NoteRef {
        &self.reference
    }
    pub fn revision(&self) -> &RevisionId {
        &self.revision
    }
    pub fn class(&self) -> DocClass {
        self.facts.recorded.class
    }
    pub fn lifecycle(&self) -> Lifecycle {
        self.lifecycle
    }
    pub fn digest(&self) -> ContentDigest {
        self.digest
    }
    pub fn origin(&self) -> ProviderOrigin {
        ProviderOrigin::Note {
            reference: self.reference.clone(),
            revision: self.revision.clone(),
            digest: self.digest,
        }
    }
    pub fn in_project(&self, project: &FolderRef) -> bool {
        self.facts.in_project(project)
    }
    pub fn listing(&self, auth: &EngineAuthContext) -> DomainResult<ListedDocument> {
        self.facts.authorize(auth)?;
        if self.lifecycle == Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(ListedDocument(self.clone()))
    }
}

/// An active, readable secondary card; it conveys no whole-text capability.
/// ```compile_fail
/// use notarium_core::classes::SearchMetadata;
/// let _: SearchMetadata = serde_json::from_str("{}").unwrap();
/// ```
#[derive(Clone, Debug)]
pub struct SearchMetadata(ClassifiedMetadata);
impl SearchMetadata {
    pub fn provenance(&self) -> &ClassifiedMetadata {
        &self.0
    }
}

/// Canonical ownership must establish these facts before calling the constructor.
#[derive(Clone)]
pub struct ClassifiedDocument {
    reference: NoteRef,
    revision: RevisionId,
    facts: DocumentFacts,
    lifecycle: Lifecycle,
    content: String,
    digest: ContentDigest,
}
impl fmt::Debug for ClassifiedDocument {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClassifiedDocument")
            .field("reference", &self.reference)
            .field("revision", &self.revision)
            .field("class", &self.facts.recorded.class)
            .finish_non_exhaustive()
    }
}
impl ClassifiedDocument {
    pub fn from_canonical(
        reference: NoteRef,
        revision: RevisionId,
        facts: ResourceFacts,
        lifecycle: Lifecycle,
        content: String,
        digest: ContentDigest,
    ) -> DomainResult<Self> {
        if reference.space_id != facts.space.id {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        Ok(Self {
            reference,
            revision,
            facts: DocumentFacts::new(facts),
            lifecycle,
            content,
            digest,
        })
    }
    /// Bind current canonical placement and class to a historical document.
    /// This additional restriction follows the carrier and any derived metadata.
    pub fn bind_current_facts(&mut self, current: ResourceFacts) -> DomainResult<()> {
        self.bind_current(current, self.lifecycle)
    }
    pub fn bind_current(&mut self, facts: ResourceFacts, lifecycle: Lifecycle) -> DomainResult<()> {
        self.facts.bind_current(self.lifecycle, facts, lifecycle)
    }
    pub fn reference(&self) -> &NoteRef {
        &self.reference
    }
    pub fn revision(&self) -> &RevisionId {
        &self.revision
    }
    pub fn class(&self) -> DocClass {
        self.facts.recorded.class
    }
    pub fn lifecycle(&self) -> Lifecycle {
        self.lifecycle
    }
    pub fn listing(&self, auth: &EngineAuthContext) -> DomainResult<ListedDocument> {
        self.metadata().listing(auth)
    }
    pub fn metadata(&self) -> ClassifiedMetadata {
        ClassifiedMetadata {
            reference: self.reference.clone(),
            revision: self.revision.clone(),
            facts: self.facts.clone(),
            lifecycle: self.lifecycle,
            digest: self.digest,
        }
    }
    pub fn digest(&self) -> ContentDigest {
        self.digest
    }
    pub fn origin(&self) -> ProviderOrigin {
        ProviderOrigin::Note {
            reference: self.reference.clone(),
            revision: self.revision.clone(),
            digest: self.digest,
        }
    }
    pub fn in_project(&self, project: &FolderRef) -> bool {
        self.facts.in_project(project)
    }
    pub fn explicit_read<'a>(&'a self, auth: &EngineAuthContext) -> DomainResult<&'a str> {
        self.facts.authorize(auth)?;
        if self.lifecycle == Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(&self.content)
    }
}

#[derive(Clone, Debug)]
pub struct ListedDocument(ClassifiedMetadata);
impl ListedDocument {
    pub fn reference(&self) -> &NoteRef {
        self.0.reference()
    }
    pub fn revision(&self) -> &RevisionId {
        self.0.revision()
    }
    pub fn class(&self) -> DocClass {
        self.0.class()
    }
    pub fn lifecycle(&self) -> Lifecycle {
        self.0.lifecycle()
    }
    pub fn provenance(&self) -> &ClassifiedMetadata {
        &self.0
    }
}

/// Protected auxiliary files retain package provenance without inventing NoteIds.
#[derive(Clone)]
pub struct ClassifiedAbilityResource {
    reference: AbilityResourceRef,
    provenance: AbilityResourceProvenance,
    lifecycle: Lifecycle,
    content: String,
    digest: ContentDigest,
}
impl ClassifiedAbilityResource {
    pub fn from_canonical(
        reference: AbilityResourceRef,
        provenance: AbilityResourceProvenance,
        lifecycle: Lifecycle,
        content: String,
        digest: ContentDigest,
    ) -> DomainResult<Self> {
        provenance.validate(&reference)?;
        Ok(Self {
            reference,
            provenance,
            lifecycle,
            content,
            digest,
        })
    }
    pub fn reference(&self) -> &AbilityResourceRef {
        &self.reference
    }
    pub fn placement(&self) -> &AbilityPlacement {
        &self.provenance.current.placement
    }
    pub fn in_project(&self, project: &FolderRef) -> bool {
        self.provenance.in_project(project)
    }
    pub fn digest(&self) -> ContentDigest {
        self.digest
    }
    pub fn origin(&self) -> ProviderOrigin {
        ProviderOrigin::Ability {
            reference: self.reference.clone(),
            placement: self.placement().clone(),
            digest: self.digest,
        }
    }
    pub fn lifecycle(&self) -> Lifecycle {
        self.lifecycle
    }
    pub fn explicit_read<'a>(&'a self, auth: &EngineAuthContext) -> DomainResult<&'a str> {
        self.provenance.authorize(auth)?;
        if self.lifecycle == Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(&self.content)
    }
}

#[derive(Clone, Debug)]
pub struct AbilityResourceLocation {
    pub placement: AbilityPlacement,
    pub facts: ResourceFacts,
}

/// An immutable package may have been published at a different location from
/// its current entrypoint. Reading it requires rights at both locations.
#[derive(Clone, Debug)]
pub struct AbilityResourceProvenance {
    pub current: AbilityResourceLocation,
    pub published: AbilityResourceLocation,
}

impl AbilityResourceProvenance {
    fn locations(&self) -> [&AbilityResourceLocation; 2] {
        [&self.current, &self.published]
    }

    fn validate(&self, reference: &AbilityResourceRef) -> DomainResult<()> {
        if self.locations().into_iter().all(|location| {
            let facts = &location.facts;
            facts.space.id == reference.space
                && facts.class == DocClass::Skill
                && facts.ability_package.as_ref() == Some(&reference.ability)
                && ability_placement_matches(&location.placement, facts)
        }) {
            Ok(())
        } else {
            Err(DomainError::validation(ValidationReason::ScopeMismatch))
        }
    }

    fn authorize(&self, auth: &EngineAuthContext) -> DomainResult<()> {
        if self.locations().into_iter().any(|location| {
            matches!(&location.placement, AbilityPlacement::OwnedPersonal(owner) if owner != auth.principal())
        }) {
            return Err(DomainError::ResourceNotFound);
        }
        auth.can_view_resource(&self.current.facts)?;
        auth.authorize_read(&self.published.facts)
    }

    fn in_project(&self, project: &FolderRef) -> bool {
        self.locations()
            .into_iter()
            .all(|location| ability_in_project(&location.placement, project))
    }
}

fn ability_placement_matches(placement: &AbilityPlacement, facts: &ResourceFacts) -> bool {
    match placement {
        AbilityPlacement::OwnedProject(project) => {
            project.space_id == facts.space.id
                && facts.ancestor_folders.contains(&project.folder_id)
        }
        AbilityPlacement::OwnedSpace(space) => {
            *space == facts.space.id && facts.space.kind == SpaceKind::Shared
        }
        AbilityPlacement::OwnedPersonal(_) => facts.space.kind == SpaceKind::Personal,
        AbilityPlacement::System => false,
    }
}

fn ability_in_project(placement: &AbilityPlacement, project: &FolderRef) -> bool {
    match placement {
        AbilityPlacement::OwnedProject(folder) => folder == project,
        AbilityPlacement::OwnedSpace(space) => space == &project.space_id,
        AbilityPlacement::OwnedPersonal(_) | AbilityPlacement::System => false,
    }
}
impl fmt::Debug for ClassifiedAbilityResource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClassifiedAbilityResource")
            .field("reference", &self.reference)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub enum ProviderAudience {
    Personal {
        consented: bool,
    },
    Shared {
        space: SpaceId,
        attached: bool,
        space_consented: bool,
        sender_consented: bool,
    },
}
#[derive(Clone, Debug)]
pub struct ProviderPolicy {
    pub provider: ProviderResourceId,
    pub audience: ProviderAudience,
    pub allowed_classes: BTreeSet<DocClass>,
}
macro_rules! content_wrapper {
    ($name:ident) => {
        #[derive(Clone, Debug)]
        pub struct $name(ClassifiedDocument);
        impl $name {
            pub fn text(&self) -> &str {
                &self.0.content
            }
            pub fn provenance(&self) -> &ClassifiedDocument {
                &self.0
            }
        }
    };
}
content_wrapper!(ProjectionContent);
content_wrapper!(SearchContent);

/// A source-bound extraction result, preserving the original canonical identity.
/// Token count/key/model are assertions of the trusted tokenizer owner; text and
/// source ranges are checked here and cannot introduce foreign content.
#[derive(Clone)]
pub struct ContentPart {
    document: Arc<ClassifiedDocument>,
    chunk: ChunkDescriptor,
}
impl ContentPart {
    pub fn from_chunk(
        document: Arc<ClassifiedDocument>,
        chunk: ChunkDescriptor,
    ) -> DomainResult<Self> {
        if chunk.source != document.digest
            || chunk.spans.is_empty()
            || render_chunk(&document.content, &chunk.context, &chunk.spans)? != chunk.text
        {
            return Err(DomainError::validation(ValidationReason::SourceMismatch));
        }
        if chunk.tokens == 0 || chunk.tokens > 512 {
            return Err(DomainError::validation(
                ValidationReason::TokenBudgetExceeded,
            ));
        }
        Ok(Self { document, chunk })
    }
    pub fn provenance(&self) -> &ClassifiedDocument {
        &self.document
    }
    pub fn model(&self) -> &ModelProfileId {
        &self.chunk.model
    }
    pub fn key(&self) -> ContentDigest {
        self.chunk.key
    }
    pub fn tokens(&self) -> u32 {
        self.chunk.tokens
    }
    pub fn spans(&self) -> &[ByteSpan] {
        &self.chunk.spans
    }
    pub fn context(&self) -> &[ByteSpan] {
        &self.chunk.context
    }
}
impl fmt::Debug for ContentPart {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ContentPart")
            .field("document", &self.document)
            .field("model", &self.chunk.model)
            .field("key", &self.chunk.key)
            .field("tokens", &self.chunk.tokens)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Debug)]
pub struct SearchPart(ContentPart);
impl SearchPart {
    pub fn text(&self) -> &str {
        &self.0.chunk.text
    }
    pub fn part(&self) -> &ContentPart {
        &self.0
    }
    pub fn provenance(&self) -> &ClassifiedDocument {
        self.0.provenance()
    }
    pub fn in_project(&self, project: &FolderRef) -> bool {
        self.provenance().in_project(project)
    }
}
#[derive(Clone, Debug)]
pub struct ProviderPart {
    part: ContentPart,
    provider: ProviderResourceId,
}
impl ProviderPart {
    pub fn text(&self) -> &str {
        &self.part.chunk.text
    }
    pub fn part(&self) -> &ContentPart {
        &self.part
    }
    pub fn provenance(&self) -> &ClassifiedDocument {
        self.part.provenance()
    }
    pub fn provider(&self) -> &ProviderResourceId {
        &self.provider
    }
}
#[derive(Clone, Debug)]
pub struct ProviderContent {
    document: ClassifiedDocument,
    provider: ProviderResourceId,
}
impl ProviderContent {
    pub fn text(&self) -> &str {
        &self.document.content
    }
    pub fn provenance(&self) -> &ClassifiedDocument {
        &self.document
    }
    pub fn provider(&self) -> &ProviderResourceId {
        &self.provider
    }
}
pub struct ClassEgressFence;

/// Trusted chat owner supplies the committed entry, after branch admission.
/// This wrapper is not deserializable and must not be used to relabel note text.
#[derive(Clone)]
pub struct CanonicalChatContent {
    pub space: Space,
    pub thread: ChatThreadId,
    pub entry: ThreadEntrySeq,
    tainted: bool,
    text: String,
    digest: ContentDigest,
    project: Option<crate::ids::FolderId>,
    provenance: Option<ChatProvenance>,
    group_author: Option<PrincipalId>,
}
impl CanonicalChatContent {
    pub fn from_canonical(
        space: Space,
        thread: ChatThreadId,
        entry: ThreadEntrySeq,
        tainted: bool,
        text: String,
        digest: ContentDigest,
        project: Option<crate::ids::FolderId>,
    ) -> Self {
        Self {
            space,
            thread,
            entry,
            tainted,
            text,
            digest,
            project,
            provenance: None,
            group_author: None,
        }
    }
    pub fn with_provenance(mut self, provenance: Option<ChatProvenance>) -> Self {
        self.provenance = provenance;
        self
    }
    /// The canonical reader adds this only to a human message in a group chat.
    pub fn with_group_author(mut self, author: PrincipalId) -> Self {
        self.group_author = Some(author);
        self
    }
    pub fn digest(&self) -> ContentDigest {
        self.digest
    }
    pub fn provenance(&self) -> Option<&ChatProvenance> {
        self.provenance.as_ref()
    }
}
impl fmt::Debug for CanonicalChatContent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CanonicalChatContent")
            .field("space", &self.space.id)
            .field("thread", &self.thread)
            .field("entry", &self.entry)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Debug)]
pub struct ProviderChatContent {
    entry: CanonicalChatContent,
    provider: ProviderResourceId,
    rendered_group_message: Option<String>,
}
impl ProviderChatContent {
    pub fn text(&self) -> &str {
        self.rendered_group_message
            .as_deref()
            .unwrap_or(&self.entry.text)
    }
    pub fn provenance(&self) -> &CanonicalChatContent {
        &self.entry
    }
    pub fn provider(&self) -> &ProviderResourceId {
        &self.provider
    }
}
#[derive(Clone, Debug)]
pub enum ProviderMessage {
    Document(ProviderContent),
    Part(ProviderPart),
    Chat(ProviderChatContent),
    Ability(ProviderAbilityContent),
    SystemAbility(ProviderSystemAbilityContent),
    Metadata(ProviderMetadataContent),
}
/// A metadata-only identity for acquiring current canonical egress authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ProviderOrigin {
    Note {
        reference: NoteRef,
        revision: RevisionId,
        digest: ContentDigest,
    },
    Ability {
        reference: AbilityResourceRef,
        placement: AbilityPlacement,
        digest: ContentDigest,
    },
    Chat {
        space: SpaceId,
        thread: ChatThreadId,
        entry: ThreadEntrySeq,
        digest: ContentDigest,
        project: Option<crate::ids::FolderId>,
    },
    SystemAbility {
        ability: AbilityId,
        revision: RevisionId,
        digest: ContentDigest,
    },
    Folder {
        history: HistoryScope,
        reference: FolderRef,
        revision: RevisionId,
        digest: ContentDigest,
    },
    Space {
        history: HistoryScope,
        digest: ContentDigest,
    },
}
impl ProviderOrigin {
    pub fn owning_project(&self) -> Option<&FolderRef> {
        match self {
            Self::Ability {
                placement: AbilityPlacement::OwnedProject(project),
                ..
            } => Some(project),
            _ => None,
        }
    }

    pub fn space_id(&self) -> Option<&SpaceId> {
        match self {
            Self::Note { reference, .. } => Some(&reference.space_id),
            Self::Ability { reference, .. } => Some(&reference.space),
            Self::Chat { space, .. } => Some(space),
            Self::Folder { history, .. } | Self::Space { history, .. } => Some(&history.space_id),
            Self::SystemAbility { .. } => None,
        }
    }
}
#[derive(Clone, Debug)]
pub enum ProviderCurrentContent {
    Note(ClassifiedMetadata),
    Ability {
        reference: AbilityResourceRef,
        digest: ContentDigest,
        provenance: AbilityResourceProvenance,
        lifecycle: Lifecycle,
    },
    Chat {
        space: Space,
        thread: ChatThreadId,
        entry: ThreadEntrySeq,
        digest: ContentDigest,
        project: Option<crate::ids::FolderId>,
        lifecycle: Lifecycle,
        tainted: bool,
        provenance: Option<ChatProvenance>,
        group_author: Option<PrincipalId>,
    },
    SystemAbility {
        ability: AbilityId,
        revision: RevisionId,
        digest: ContentDigest,
    },
    Folder {
        history: HistoryScope,
        reference: FolderRef,
        revision: RevisionId,
        digest: ContentDigest,
        space: Space,
        lifecycle: Lifecycle,
        ancestor_folders: Vec<FolderId>,
    },
    Space {
        history: HistoryScope,
        digest: ContentDigest,
        space: Space,
        root: FolderId,
    },
}
impl ProviderCurrentContent {
    pub fn origin(&self) -> ProviderOrigin {
        match self {
            Self::Note(value) => value.origin(),
            Self::Ability {
                reference,
                provenance,
                digest,
                ..
            } => ProviderOrigin::Ability {
                reference: reference.clone(),
                placement: provenance.current.placement.clone(),
                digest: *digest,
            },
            Self::Chat {
                space,
                thread,
                entry,
                digest,
                project,
                ..
            } => ProviderOrigin::Chat {
                space: space.id.clone(),
                thread: thread.clone(),
                entry: *entry,
                digest: *digest,
                project: project.clone(),
            },
            Self::SystemAbility {
                ability,
                revision,
                digest,
            } => ProviderOrigin::SystemAbility {
                ability: ability.clone(),
                revision: revision.clone(),
                digest: *digest,
            },
            Self::Folder {
                history,
                reference,
                revision,
                digest,
                ..
            } => ProviderOrigin::Folder {
                history: history.clone(),
                reference: reference.clone(),
                revision: revision.clone(),
                digest: *digest,
            },
            Self::Space {
                history, digest, ..
            } => ProviderOrigin::Space {
                history: history.clone(),
                digest: *digest,
            },
        }
    }
    pub fn space(&self) -> Option<&Space> {
        match self {
            Self::Note(value) => Some(&value.facts.recorded.space),
            Self::Ability { provenance, .. } => Some(&provenance.current.facts.space),
            Self::Chat { space, .. } | Self::Folder { space, .. } | Self::Space { space, .. } => {
                Some(space)
            }
            Self::SystemAbility { .. } => None,
        }
    }
    /// Project-only consent is usable only with current canonical placement.
    pub fn in_project(&self, project: &crate::model::FolderRef) -> bool {
        match self {
            Self::Note(value) => value.in_project(project),
            Self::Ability { provenance, .. } => provenance.in_project(project),
            Self::Chat {
                space,
                project: current,
                ..
            } => space.id == project.space_id && current.as_ref() == Some(&project.folder_id),
            Self::Folder {
                reference,
                ancestor_folders,
                ..
            } => {
                reference.space_id == project.space_id
                    && (reference == project || ancestor_folders.contains(&project.folder_id))
            }
            Self::SystemAbility { .. } => true,
            Self::Space { .. } => false,
        }
    }
    pub fn provenance(&self) -> Option<&ChatProvenance> {
        match self {
            Self::Chat { provenance, .. } => provenance.as_ref(),
            _ => None,
        }
    }
}
impl ProviderMessage {
    /// Scope of the content as admitted, retained until dispatch even if a note moves.
    pub fn in_project(&self, project: &crate::model::FolderRef) -> bool {
        match self {
            Self::Document(value) => value.provenance().in_project(project),
            Self::Part(value) => value.provenance().in_project(project),
            Self::Ability(value) => value.resource.in_project(project),
            Self::Chat(value) => {
                value.entry.space.id == project.space_id
                    && value.entry.project.as_ref() == Some(&project.folder_id)
            }
            Self::SystemAbility(_) => true,
            Self::Metadata(value) => value.content.current.in_project(project),
        }
    }

    pub fn origin(&self) -> ProviderOrigin {
        match self {
            Self::Document(value) => value.provenance().origin(),
            Self::Part(value) => value.provenance().origin(),
            Self::Ability(value) => value.resource.origin(),
            Self::Chat(value) => ProviderOrigin::Chat {
                space: value.entry.space.id.clone(),
                thread: value.entry.thread.clone(),
                entry: value.entry.entry,
                digest: value.entry.digest,
                project: value.entry.project.clone(),
            },
            Self::SystemAbility(value) => value.content.origin(),
            Self::Metadata(value) => value.content.current.origin(),
        }
    }
    pub fn text(&self) -> &str {
        match self {
            Self::Document(value) => value.text(),
            Self::Part(value) => value.text(),
            Self::Chat(value) => value.text(),
            Self::Ability(value) => value.text(),
            Self::SystemAbility(value) => value.text(),
            Self::Metadata(value) => &value.content.text,
        }
    }
    pub fn provider(&self) -> &ProviderResourceId {
        match self {
            Self::Document(value) => value.provider(),
            Self::Part(value) => value.provider(),
            Self::Chat(value) => value.provider(),
            Self::Ability(value) => value.provider(),
            Self::SystemAbility(value) => value.provider(),
            Self::Metadata(value) => &value.provider,
        }
    }
    pub fn provenance(&self) -> Option<&ChatProvenance> {
        match self {
            Self::Chat(value) => value.entry.provenance(),
            _ => None,
        }
    }
}
#[derive(Clone, Debug)]
pub struct ProviderAbilityContent {
    resource: ClassifiedAbilityResource,
    provider: ProviderResourceId,
}
impl ProviderAbilityContent {
    pub fn text(&self) -> &str {
        &self.resource.content
    }
    pub fn provenance(&self) -> &ClassifiedAbilityResource {
        &self.resource
    }
    pub fn provider(&self) -> &ProviderResourceId {
        &self.provider
    }
}

/// An immutable package shipped with the application. The catalog verifies
/// the revision and digest against the shipped inventory again at dispatch.
#[derive(Clone)]
pub struct SystemAbilityContent {
    ability: AbilityId,
    revision: RevisionId,
    digest: ContentDigest,
    text: &'static str,
}

impl SystemAbilityContent {
    pub fn new(
        ability: AbilityId,
        revision: RevisionId,
        digest: ContentDigest,
        text: &'static str,
    ) -> DomainResult<Self> {
        if text.len() > 256 * 1024 || text.contains('\0') {
            return Err(DomainError::validation(ValidationReason::InvalidLimit));
        }
        Ok(Self {
            ability,
            revision,
            digest,
            text,
        })
    }

    pub fn text(&self) -> &'static str {
        self.text
    }

    pub fn origin(&self) -> ProviderOrigin {
        ProviderOrigin::SystemAbility {
            ability: self.ability.clone(),
            revision: self.revision.clone(),
            digest: self.digest,
        }
    }
}

impl fmt::Debug for SystemAbilityContent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SystemAbilityContent")
            .field("ability", &self.ability)
            .field("revision", &self.revision)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct ProviderSystemAbilityContent {
    content: SystemAbilityContent,
    provider: ProviderResourceId,
}

impl ProviderSystemAbilityContent {
    pub fn text(&self) -> &str {
        self.content.text()
    }
    pub fn provider(&self) -> &ProviderResourceId {
        &self.provider
    }
}

/// Folder and space metadata owned by the canonical catalog.
#[derive(Clone)]
pub struct CanonicalMetadataContent {
    current: ProviderCurrentContent,
    text: String,
}

impl CanonicalMetadataContent {
    pub fn from_canonical(current: ProviderCurrentContent, text: String) -> DomainResult<Self> {
        match current {
            ProviderCurrentContent::Folder { .. } | ProviderCurrentContent::Space { .. } => {
                Ok(Self { current, text })
            }
            _ => Err(DomainError::validation(ValidationReason::SourceMismatch)),
        }
    }

    pub fn current(&self) -> &ProviderCurrentContent {
        &self.current
    }
}

impl fmt::Debug for CanonicalMetadataContent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CanonicalMetadataContent")
            .field("origin", &self.current.origin())
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug)]
pub struct ProviderMetadataContent {
    content: CanonicalMetadataContent,
    provider: ProviderResourceId,
}

impl ClassEgressFence {
    pub fn mcp_note<'a>(
        document: &'a ClassifiedDocument,
        auth: &EngineAuthContext,
    ) -> DomainResult<&'a str> {
        Self::check(document, auth)?;
        Ok(&document.content)
    }

    pub fn provider_note_metadata(
        metadata: &ClassifiedMetadata,
        auth: &EngineAuthContext,
        policy: &ProviderPolicy,
    ) -> DomainResult<ProviderOrigin> {
        metadata.facts.allow_egress(metadata.lifecycle, auth)?;
        metadata.facts.allow_provider(policy)?;
        Ok(metadata.origin())
    }

    pub fn mcp_note_metadata(
        metadata: &ClassifiedMetadata,
        auth: &EngineAuthContext,
    ) -> DomainResult<ProviderOrigin> {
        metadata.facts.allow_egress(metadata.lifecycle, auth)?;
        Ok(metadata.origin())
    }

    pub fn mcp_ability<'a>(
        resource: &'a ClassifiedAbilityResource,
        auth: &EngineAuthContext,
    ) -> DomainResult<&'a str> {
        Self::check_ability_resource(resource, auth)?;
        Ok(&resource.content)
    }

    pub fn chat_transcript<'a>(
        entry: &'a CanonicalChatContent,
        auth: &EngineAuthContext,
    ) -> DomainResult<&'a str> {
        auth.authorize_chat_read(&entry.space, entry.project.as_ref(), entry.tainted)?;
        Ok(&entry.text)
    }

    pub fn system_ability(
        content: SystemAbilityContent,
        policy: &ProviderPolicy,
    ) -> DomainResult<ProviderSystemAbilityContent> {
        Self::check_system_policy(policy)?;
        Ok(ProviderSystemAbilityContent {
            content,
            provider: policy.provider.clone(),
        })
    }

    pub fn mcp_metadata<'a>(
        content: &'a CanonicalMetadataContent,
        auth: &EngineAuthContext,
    ) -> DomainResult<&'a str> {
        Self::authorize_metadata(&content.current, auth)?;
        Ok(&content.text)
    }

    pub fn provider_metadata(
        content: CanonicalMetadataContent,
        auth: &EngineAuthContext,
        policy: &ProviderPolicy,
    ) -> DomainResult<ProviderMetadataContent> {
        Self::revalidate_origin(auth, policy, &content.current)?;
        Ok(ProviderMetadataContent {
            content,
            provider: policy.provider.clone(),
        })
    }

    fn check_system_policy(policy: &ProviderPolicy) -> DomainResult<()> {
        if !policy.allowed_classes.contains(&DocClass::Skill) {
            return Err(DomainError::validation(
                ValidationReason::ClassEgressForbidden,
            ));
        }
        Self::authorize_audience(None, &policy.audience)
    }

    fn authorize_metadata(
        current: &ProviderCurrentContent,
        auth: &EngineAuthContext,
    ) -> DomainResult<()> {
        match current {
            ProviderCurrentContent::Folder {
                history,
                reference,
                space,
                lifecycle,
                ancestor_folders,
                ..
            } if history.space_id == reference.space_id
                && reference.space_id == space.id
                && *lifecycle == Lifecycle::Active =>
            {
                auth.authorize_folder_read(space, &reference.folder_id, ancestor_folders)
            }
            ProviderCurrentContent::Space {
                history,
                space,
                root,
                ..
            } if history.space_id == space.id => auth.authorize_folder_read(space, root, &[]),
            _ => Err(DomainError::ResourceNotFound),
        }
    }

    /// Recheck an origin used by a persisted derivative, including when no
    /// original bytes from this source occur verbatim in the next prompt.
    pub fn revalidate_origin(
        auth: &EngineAuthContext,
        policy: &ProviderPolicy,
        current: &ProviderCurrentContent,
    ) -> DomainResult<()> {
        match current {
            ProviderCurrentContent::Note(value) => {
                value.facts.allow_egress(value.lifecycle, auth)?;
                value.facts.allow_provider(policy)
            }
            ProviderCurrentContent::Ability {
                reference,
                provenance,
                lifecycle,
                ..
            } => {
                if *lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound);
                }
                provenance.validate(reference)?;
                provenance.authorize(auth)?;
                Self::ability_provider_policy(provenance, policy)
            }
            ProviderCurrentContent::Chat {
                space,
                project,
                lifecycle,
                tainted,
                ..
            } => {
                if *lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound);
                }
                Self::check_chat(space, project.as_ref(), *tainted, auth, policy)
            }
            ProviderCurrentContent::SystemAbility { .. } => Self::check_system_policy(policy),
            ProviderCurrentContent::Folder { space, .. }
            | ProviderCurrentContent::Space { space, .. } => {
                Self::authorize_metadata(current, auth)?;
                Self::authorize_audience(Some(space), &policy.audience)
            }
        }
    }

    /// The caller holds a canonical egress lease and dispatch registration,
    /// and supplies freshly verified control authority and disclosure consent.
    pub fn revalidate(
        message: &ProviderMessage,
        auth: &EngineAuthContext,
        policy: &ProviderPolicy,
        current: &ProviderCurrentContent,
    ) -> DomainResult<()> {
        if message.provider() != &policy.provider || message.origin() != current.origin() {
            return Err(DomainError::validation(ValidationReason::SourceMismatch));
        }
        match (message, current) {
            (ProviderMessage::Document(original), ProviderCurrentContent::Note(value)) => {
                Self::revalidate_note(original.provenance(), value, auth, policy)
            }
            (ProviderMessage::Part(original), ProviderCurrentContent::Note(value)) => {
                Self::revalidate_note(original.provenance(), value, auth, policy)
            }
            (
                ProviderMessage::Chat(value),
                ProviderCurrentContent::Chat {
                    space,
                    project,
                    lifecycle,
                    tainted,
                    group_author,
                    provenance,
                    ..
                },
            ) => {
                if *lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound);
                }
                if &value.entry.group_author != group_author
                    || &value.entry.provenance != provenance
                {
                    return Err(DomainError::validation(ValidationReason::SourceMismatch));
                }
                Self::check_chat(
                    space,
                    project.as_ref(),
                    value.entry.tainted || *tainted,
                    auth,
                    policy,
                )
            }
            (ProviderMessage::Ability(_), ProviderCurrentContent::Ability { .. })
            | (ProviderMessage::SystemAbility(_), ProviderCurrentContent::SystemAbility { .. })
            | (
                ProviderMessage::Metadata(_),
                ProviderCurrentContent::Folder { .. } | ProviderCurrentContent::Space { .. },
            ) => Self::revalidate_origin(auth, policy, current),
            _ => Err(DomainError::validation(ValidationReason::SourceMismatch)),
        }
    }
    fn revalidate_note(
        original: &ClassifiedDocument,
        current: &ClassifiedMetadata,
        auth: &EngineAuthContext,
        policy: &ProviderPolicy,
    ) -> DomainResult<()> {
        Self::check(original, auth)?;
        original.facts.allow_provider(policy)?;
        current.facts.allow_egress(current.lifecycle, auth)?;
        current.facts.allow_provider(policy)
    }

    pub fn search_part(part: ContentPart, auth: &EngineAuthContext) -> DomainResult<SearchPart> {
        Self::check(part.provenance(), auth)?;
        Ok(SearchPart(part))
    }
    pub fn provider_part(
        part: ContentPart,
        auth: &EngineAuthContext,
        policy: &ProviderPolicy,
    ) -> DomainResult<ProviderPart> {
        Self::check(part.provenance(), auth)?;
        part.document.facts.allow_provider(policy)?;
        Ok(ProviderPart {
            part,
            provider: policy.provider.clone(),
        })
    }
    pub fn ability(
        resource: ClassifiedAbilityResource,
        auth: &EngineAuthContext,
        policy: &ProviderPolicy,
    ) -> DomainResult<ProviderAbilityContent> {
        Self::check_ability_resource(&resource, auth)?;
        Self::ability_provider_policy(&resource.provenance, policy)?;
        Ok(ProviderAbilityContent {
            resource,
            provider: policy.provider.clone(),
        })
    }
    fn check_ability_resource(
        resource: &ClassifiedAbilityResource,
        auth: &EngineAuthContext,
    ) -> DomainResult<()> {
        if resource.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound);
        }
        resource.provenance.authorize(auth)
    }
    fn ability_provider_policy(
        provenance: &AbilityResourceProvenance,
        policy: &ProviderPolicy,
    ) -> DomainResult<()> {
        provenance.locations().into_iter().try_for_each(|location| {
            Self::provider_policy(&location.facts.space, DocClass::Skill, policy)
        })
    }
    pub fn chat(
        entry: CanonicalChatContent,
        auth: &EngineAuthContext,
        policy: &ProviderPolicy,
    ) -> DomainResult<ProviderChatContent> {
        Self::check_chat(
            &entry.space,
            entry.project.as_ref(),
            entry.tainted,
            auth,
            policy,
        )?;
        Ok(ProviderChatContent {
            rendered_group_message: entry.group_author.as_ref().map(|author| {
                let text = entry.text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
                format!(
                    "<group_participant_message author=\"{author}\" trusted_instructions=\"false\">{text}</group_participant_message>"
                )
            }),
            entry,
            provider: policy.provider.clone(),
        })
    }
    fn check_chat(
        current: &Space,
        project: Option<&crate::ids::FolderId>,
        tainted: bool,
        auth: &EngineAuthContext,
        policy: &ProviderPolicy,
    ) -> DomainResult<()> {
        auth.authorize_chat_read(current, project, tainted)?;
        let permitted = match &policy.audience {
            ProviderAudience::Personal { consented } => {
                *consented && current.kind == SpaceKind::Personal
            }
            ProviderAudience::Shared {
                space,
                attached,
                space_consented,
                sender_consented,
            } => {
                *attached
                    && *space_consented
                    && *sender_consented
                    && space == &current.id
                    && !tainted
            }
        };
        if !permitted {
            return Err(DomainError::validation(
                ValidationReason::ProviderConsentRequired,
            ));
        }
        Ok(())
    }
    fn check(document: &ClassifiedDocument, auth: &EngineAuthContext) -> DomainResult<()> {
        document.facts.allow_egress(document.lifecycle, auth)
    }
    pub fn search_metadata(
        document: ClassifiedMetadata,
        auth: &EngineAuthContext,
    ) -> DomainResult<SearchMetadata> {
        document.facts.allow_egress(document.lifecycle, auth)?;
        Ok(SearchMetadata(document))
    }
    pub fn projection(
        document: ClassifiedDocument,
        auth: &EngineAuthContext,
    ) -> DomainResult<ProjectionContent> {
        Self::check(&document, auth)?;
        Ok(ProjectionContent(document))
    }
    pub fn search(
        document: ClassifiedDocument,
        auth: &EngineAuthContext,
    ) -> DomainResult<SearchContent> {
        Self::check(&document, auth)?;
        Ok(SearchContent(document))
    }
    pub fn provider(
        document: ClassifiedDocument,
        auth: &EngineAuthContext,
        policy: &ProviderPolicy,
    ) -> DomainResult<ProviderContent> {
        Self::check(&document, auth)?;
        document.facts.allow_provider(policy)?;
        Ok(ProviderContent {
            document,
            provider: policy.provider.clone(),
        })
    }
    fn provider_policy(
        space: &Space,
        class: DocClass,
        policy: &ProviderPolicy,
    ) -> DomainResult<()> {
        if !policy.allowed_classes.contains(&class) {
            return Err(DomainError::validation(
                ValidationReason::ClassEgressForbidden,
            ));
        }
        if class == DocClass::Profile && matches!(policy.audience, ProviderAudience::Shared { .. })
        {
            return Err(DomainError::validation(
                ValidationReason::ProviderConsentRequired,
            ));
        }
        Self::authorize_audience(Some(space), &policy.audience)
    }
    fn authorize_audience(space: Option<&Space>, audience: &ProviderAudience) -> DomainResult<()> {
        let permitted = match audience {
            ProviderAudience::Personal { consented } => {
                *consented && space.is_none_or(|value| value.kind == SpaceKind::Personal)
            }
            ProviderAudience::Shared {
                space: attached_space,
                attached,
                space_consented,
                sender_consented,
            } => {
                *attached
                    && *space_consented
                    && *sender_consented
                    && space.is_none_or(|value| attached_space == &value.id)
            }
        };
        if !permitted {
            return Err(DomainError::validation(
                ValidationReason::ProviderConsentRequired,
            ));
        }
        Ok(())
    }
}

/// Structured field edits never authorize changes to identity, class or routing.
pub fn authorize_field_key(key: &str) -> DomainResult<()> {
    if matches!(
        key,
        "id" | "class" | "space_id" | "folder_id" | "revision_id" | "ability_id" | "__proto__"
    ) {
        Err(DomainError::validation(ValidationReason::ProtectedField))
    } else {
        Ok(())
    }
}
