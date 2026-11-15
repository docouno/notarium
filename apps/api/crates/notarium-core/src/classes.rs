//! Classified content cannot cross secondary surfaces through a raw-text port.
use crate::{
    DomainError, DomainResult,
    auth::{EngineAuthContext, ResourceFacts, Space, SpaceKind},
    error::ValidationReason,
    ids::{ChatThreadId, ContentDigest, ProviderResourceId, RevisionId, SpaceId, ThreadEntrySeq},
    model::{AbilityResourceRef, Lifecycle, NoteRef},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fmt};

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

/// Canonical ownership must establish these facts before calling the constructor.
#[derive(Clone)]
pub struct ClassifiedDocument {
    reference: NoteRef,
    revision: RevisionId,
    facts: ResourceFacts,
    lifecycle: Lifecycle,
    content: String,
    digest: ContentDigest,
}
impl fmt::Debug for ClassifiedDocument {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClassifiedDocument")
            .field("reference", &self.reference)
            .field("revision", &self.revision)
            .field("class", &self.facts.class)
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
            facts,
            lifecycle,
            content,
            digest,
        })
    }
    pub fn reference(&self) -> &NoteRef {
        &self.reference
    }
    pub fn revision(&self) -> &RevisionId {
        &self.revision
    }
    pub fn class(&self) -> DocClass {
        self.facts.class
    }
    pub fn lifecycle(&self) -> Lifecycle {
        self.lifecycle
    }
    pub fn listing(&self, auth: &EngineAuthContext) -> DomainResult<ListedDocument> {
        self.explicit_read(auth)?;
        Ok(ListedDocument {
            reference: self.reference.clone(),
            revision: self.revision.clone(),
            class: self.class(),
            lifecycle: self.lifecycle,
        })
    }
    pub fn digest(&self) -> ContentDigest {
        self.digest
    }
    pub fn explicit_read<'a>(&'a self, auth: &EngineAuthContext) -> DomainResult<&'a str> {
        auth.authorize_read(&self.facts)?;
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
}
impl CanonicalChatContent {
    pub fn from_canonical(
        space: Space,
        thread: ChatThreadId,
        entry: ThreadEntrySeq,
        tainted: bool,
        text: String,
    ) -> Self {
        Self {
            space,
            thread,
            entry,
            tainted,
            text,
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
    Chat(ProviderChatContent),
    Ability(ProviderAbilityContent),
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
        auth.authorize_chat_read(&entry.space, entry.tainted)?;
        let permitted = match &policy.audience {
            ProviderAudience::Personal { consented } => {
                *consented && entry.space.kind == SpaceKind::Personal
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
                    && space == &entry.space.id
                    && !entry.tainted
            }
        };
        if !permitted {
            return Err(DomainError::validation(
                ValidationReason::ProviderConsentRequired,
            ));
        }
        Ok(ProviderChatContent {
            entry,
            provider: policy.provider.clone(),
        })
    }
    fn check(document: &ClassifiedDocument, auth: &EngineAuthContext) -> DomainResult<()> {
        if document.class() == DocClass::EncryptedNote {
            return Err(DomainError::validation(
                ValidationReason::ClassEgressForbidden,
            ));
        }
        if document.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound);
        }
        auth.authorize_read(&document.facts)
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
        Self::provider_policy(&document.facts.space, document.class(), policy)?;
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
