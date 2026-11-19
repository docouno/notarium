//! Classified content cannot cross secondary surfaces through a raw-text port.
use crate::{
    DomainError, DomainResult,
    auth::{EngineAuthContext, ResourceFacts, Space, SpaceKind},
    document::{ChunkDescriptor, render_chunk},
    error::ValidationReason,
    ids::{
        ChatThreadId, ContentDigest, ModelProfileId, ProviderResourceId, RevisionId, SpaceId,
        ThreadEntrySeq,
    },
    model::{AbilityResourceRef, Lifecycle, NoteRef},
    ports::{ServiceAuthority, ServicePurpose},
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

    fn check_egress(&self, lifecycle: Lifecycle) -> DomainResult<()> {
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
        Ok(())
    }

    fn allow_egress(&self, lifecycle: Lifecycle, auth: &EngineAuthContext) -> DomainResult<()> {
        self.check_egress(lifecycle)?;
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
    pub fn listing(&self, auth: &EngineAuthContext) -> DomainResult<ListedDocument> {
        self.facts.authorize(auth)?;
        if self.lifecycle == Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(ListedDocument {
            reference: self.reference.clone(),
            revision: self.revision.clone(),
            class: self.class(),
            lifecycle: self.lifecycle,
        })
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
    pub fn explicit_read<'a>(&'a self, auth: &EngineAuthContext) -> DomainResult<&'a str> {
        self.facts.authorize(auth)?;
        if self.lifecycle == Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(&self.content)
    }
}

#[derive(Clone, Debug)]
pub struct ListedDocument {
    reference: NoteRef,
    revision: RevisionId,
    class: DocClass,
    lifecycle: Lifecycle,
}
impl ListedDocument {
    pub fn reference(&self) -> &NoteRef {
        &self.reference
    }
    pub fn revision(&self) -> &RevisionId {
        &self.revision
    }
    pub fn class(&self) -> DocClass {
        self.class
    }
    pub fn lifecycle(&self) -> Lifecycle {
        self.lifecycle
    }
}

/// Protected auxiliary files retain package provenance without inventing NoteIds.
#[derive(Clone)]
pub struct ClassifiedAbilityResource {
    reference: AbilityResourceRef,
    facts: ResourceFacts,
    lifecycle: Lifecycle,
    content: String,
    digest: ContentDigest,
}
impl ClassifiedAbilityResource {
    pub fn from_canonical(
        reference: AbilityResourceRef,
        facts: ResourceFacts,
        lifecycle: Lifecycle,
        content: String,
        digest: ContentDigest,
    ) -> DomainResult<Self> {
        if reference.space != facts.space.id
            || facts.class != DocClass::Skill
            || facts.ability_package.as_ref() != Some(&reference.ability)
        {
            return Err(DomainError::validation(ValidationReason::ScopeMismatch));
        }
        Ok(Self {
            reference,
            facts,
            lifecycle,
            content,
            digest,
        })
    }
    pub fn reference(&self) -> &AbilityResourceRef {
        &self.reference
    }
    pub fn digest(&self) -> ContentDigest {
        self.digest
    }
    pub fn lifecycle(&self) -> Lifecycle {
        self.lifecycle
    }
    pub fn explicit_read<'a>(&'a self, auth: &EngineAuthContext) -> DomainResult<&'a str> {
        auth.authorize_read(&self.facts)?;
        if self.lifecycle == Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound);
        }
        Ok(&self.content)
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
        }
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
}
impl ProviderChatContent {
    pub fn text(&self) -> &str {
        &self.entry.text
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
        digest: ContentDigest,
    },
    Chat {
        space: SpaceId,
        thread: ChatThreadId,
        entry: ThreadEntrySeq,
        digest: ContentDigest,
        project: Option<crate::ids::FolderId>,
    },
}
#[derive(Clone, Debug)]
pub enum ProviderCurrentContent {
    Note(ClassifiedMetadata),
    Ability {
        reference: AbilityResourceRef,
        digest: ContentDigest,
        facts: ResourceFacts,
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
    },
}
impl ProviderCurrentContent {
    pub fn origin(&self) -> ProviderOrigin {
        match self {
            Self::Note(value) => ProviderOrigin::Note {
                reference: value.reference.clone(),
                revision: value.revision.clone(),
                digest: value.digest,
            },
            Self::Ability {
                reference, digest, ..
            } => ProviderOrigin::Ability {
                reference: reference.clone(),
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
        }
    }
    pub fn space(&self) -> &Space {
        match self {
            Self::Note(value) => &value.facts.recorded.space,
            Self::Ability { facts, .. } => &facts.space,
            Self::Chat { space, .. } => space,
        }
    }
    /// Project-only consent is usable only with current canonical placement.
    pub fn in_project(&self, project: &crate::model::FolderRef) -> bool {
        if self.space().id != project.space_id {
            return false;
        }
        match self {
            Self::Note(value) => value.facts.in_project(project),
            Self::Ability { facts, .. } => facts.ancestor_folders.contains(&project.folder_id),
            Self::Chat {
                project: current, ..
            } => current.as_ref() == Some(&project.folder_id),
        }
    }
}
impl ProviderMessage {
    /// Scope of the content as admitted, retained until dispatch even if a note moves.
    pub fn in_project(&self, project: &crate::model::FolderRef) -> bool {
        match self {
            Self::Document(value) => value.provenance().facts.in_project(project),
            Self::Part(value) => value.provenance().facts.in_project(project),
            Self::Ability(value) => {
                let facts = &value.resource.facts;
                facts.space.id == project.space_id
                    && facts.ancestor_folders.contains(&project.folder_id)
            }
            Self::Chat(value) => {
                value.entry.space.id == project.space_id
                    && value.entry.project.as_ref() == Some(&project.folder_id)
            }
        }
    }

    pub fn origin(&self) -> ProviderOrigin {
        match self {
            Self::Document(value) => {
                ProviderCurrentContent::Note(value.provenance().metadata()).origin()
            }
            Self::Part(value) => {
                ProviderCurrentContent::Note(value.part().provenance().metadata()).origin()
            }
            Self::Ability(value) => ProviderOrigin::Ability {
                reference: value.resource.reference.clone(),
                digest: value.resource.digest,
            },
            Self::Chat(value) => ProviderOrigin::Chat {
                space: value.entry.space.id.clone(),
                thread: value.entry.thread.clone(),
                entry: value.entry.entry,
                digest: value.entry.digest,
                project: value.entry.project.clone(),
            },
        }
    }
    pub fn text(&self) -> &str {
        match self {
            Self::Document(value) => value.text(),
            Self::Part(value) => value.text(),
            Self::Chat(value) => value.text(),
            Self::Ability(value) => value.text(),
        }
    }
    pub fn provider(&self) -> &ProviderResourceId {
        match self {
            Self::Document(value) => value.provider(),
            Self::Part(value) => value.provider(),
            Self::Chat(value) => value.provider(),
            Self::Ability(value) => value.provider(),
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
impl ClassEgressFence {
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
                ProviderMessage::Ability(_),
                ProviderCurrentContent::Ability {
                    reference,
                    facts,
                    lifecycle,
                    ..
                },
            ) => {
                Self::check_metadata(facts, *lifecycle, auth)?;
                if facts.class != DocClass::Skill
                    || facts.ability_package.as_ref() != Some(&reference.ability)
                    || facts.space.id != reference.space
                {
                    return Err(DomainError::validation(ValidationReason::ClassMismatch));
                }
                Self::provider_policy(&facts.space, facts.class, policy)
            }
            (
                ProviderMessage::Chat(value),
                ProviderCurrentContent::Chat {
                    space,
                    project,
                    lifecycle,
                    tainted,
                    ..
                },
            ) => {
                if *lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound);
                }
                Self::check_chat(
                    space,
                    project.as_ref(),
                    value.entry.tainted || *tainted,
                    auth,
                    policy,
                )
            }
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
        if resource.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound);
        }
        auth.authorize_read(&resource.facts)?;
        Self::provider_policy(&resource.facts.space, DocClass::Skill, policy)?;
        Ok(ProviderAbilityContent {
            resource,
            provider: policy.provider.clone(),
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
    fn check_metadata(
        facts: &ResourceFacts,
        lifecycle: Lifecycle,
        auth: &EngineAuthContext,
    ) -> DomainResult<()> {
        if facts.class == DocClass::EncryptedNote {
            return Err(DomainError::validation(
                ValidationReason::ClassEgressForbidden,
            ));
        }
        if lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound);
        }
        auth.authorize_read(facts)
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
    pub fn index_for_search(
        document: ClassifiedDocument,
        authority: &ServiceAuthority,
    ) -> DomainResult<SearchContent> {
        authority.require(ServicePurpose::Search)?;
        document.facts.check_egress(document.lifecycle)?;
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
        let permitted = match &policy.audience {
            ProviderAudience::Personal { consented } => {
                *consented && space.kind == SpaceKind::Personal
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
                    && attached_space == &space.id
                    && class != DocClass::Profile
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
