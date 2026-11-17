//! Typed context references. None of these preferences grant content authority.
use super::{PortFuture, context::*, control::*};
use crate::{ids::*, model::*};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ContextScope {
    Personal,
    Space(SpaceId),
    Project(FolderRef),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PutContextSet {
    pub id: ContextSetId,
    pub home: SpaceId,
    pub name: String,
    pub notes: Vec<NoteRef>,
    /// None creates a new identity; edits compare the existing bundle revision.
    pub expected: Option<ControlRevision>,
}
#[derive(Clone, Debug)]
pub struct ContextSetInfo {
    pub id: ContextSetId,
    pub owner: PrincipalId,
    pub home: SpaceId,
    pub name: String,
    pub notes: Vec<NoteRef>,
    pub unavailable: u16,
    pub revision: ControlRevision,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeleteContextSet {
    pub id: ContextSetId,
    pub expected: ControlRevision,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContextScopeInfo {
    pub scope: ContextScope,
    pub revision: ControlRevision,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ContextEntry {
    Set(ContextSetId),
    Note(NoteRef),
}
#[derive(Clone, Debug)]
pub struct ContextEntryInfo {
    pub entry: ContextEntry,
    pub rank: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetContextAttachment {
    pub scope: ContextScope,
    pub expected: ControlRevision,
    pub set: ContextSetId,
    /// The reviewed bundle revision when attaching; detaching only compares scope.
    pub set_revision: ControlRevision,
    pub attached: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetContextPin {
    pub scope: ContextScope,
    pub expected: ControlRevision,
    pub note: NoteRef,
    pub pinned: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContextRank {
    pub entry: ContextEntry,
    pub rank: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetContextOrder {
    pub scope: ContextScope,
    pub expected: ControlRevision,
    pub entries: Vec<ContextRank>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FavoriteRef {
    Note(NoteRef),
    Folder(FolderRef),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetFavorite {
    pub reference: FavoriteRef,
    pub saved: bool,
    pub rank: i64,
}
#[derive(Clone, Debug)]
pub struct FavoriteInfo {
    pub reference: FavoriteRef,
    pub rank: i64,
}

pub trait ContextAdminPort: Send + Sync {
    fn put_context_set(
        &self,
        ctx: AccountContext,
        request: AccountMutation<PutContextSet>,
    ) -> PortFuture<'_, ControlCommit<ContextSetInfo>>;
    fn get_context_set(
        &self,
        ctx: AccountContext,
        id: ContextSetId,
    ) -> PortFuture<'_, ContextSetInfo>;
    fn list_context_sets(
        &self,
        ctx: AccountContext,
        home: SpaceId,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ContextSetInfo>>;
    fn delete_context_set(
        &self,
        ctx: AccountContext,
        request: AccountMutation<DeleteContextSet>,
    ) -> PortFuture<'_, ControlCommit<()>>;
    fn context_scope(
        &self,
        ctx: AccountContext,
        scope: ContextScope,
    ) -> PortFuture<'_, ContextScopeInfo>;
    fn list_context_entries(
        &self,
        ctx: AccountContext,
        scope: ContextScope,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<ContextEntryInfo>>;
    fn set_context_attachment(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetContextAttachment>,
    ) -> PortFuture<'_, ControlCommit<ContextScopeInfo>>;
    fn set_context_pin(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetContextPin>,
    ) -> PortFuture<'_, ControlCommit<ContextScopeInfo>>;
    fn set_context_order(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetContextOrder>,
    ) -> PortFuture<'_, ControlCommit<ContextScopeInfo>>;
    fn set_favorite(
        &self,
        ctx: AccountContext,
        request: AccountMutation<SetFavorite>,
    ) -> PortFuture<'_, ControlCommit<()>>;
    fn list_favorites(
        &self,
        ctx: AccountContext,
        page: ControlPageRequest,
    ) -> PortFuture<'_, ControlPage<FavoriteInfo>>;
}
