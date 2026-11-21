use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
};

use notarium_canonical::domain::common::MAX_FOLDER_DEPTH;
use notarium_core::{
    DomainError, DomainResult,
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, SpaceId, SpaceSeq},
    value::{Timestamp, YamlValue},
};
use notarium_syntax::unicode::lookup_key;

use crate::derived::{CandidateLookupKey, ProjectedFolderAlias, ProjectedLink, ProjectedNoteAlias};

pub(crate) const GLOBAL_FOLDER: i64 = -1;
const STABLE_ID: u32 = 0;
const PATH_FILENAME: u32 = 10;
const PATH_SLUG: u32 = 12;
const FILENAME: u32 = 20;
const AUTHORED_ALIAS: u32 = 50;
const NOTE_ALIAS: u32 = 60;
const FOLDER_ALIAS: u32 = 70;
const TARGET_NAME: u32 = 0;
const TARGET_STABLE_ID: u32 = 1;
const TARGET_LEGACY_OR_NAME: u32 = 2;
const ALIAS_PAGE: u16 = 64;
const MAX_AUTHORED_ALIASES_PER_NOTE: usize = 64;

pub(crate) struct LinkNote {
    pub id: NoteId,
    pub dense_id: u32,
    pub parent: FolderId,
    pub slug_fold: String,
    pub title: String,
    pub created_at: Timestamp,
    pub raw_fields: BTreeMap<String, YamlValue>,
    /// Active and non-encrypted at this cut. Folder ancestry is checked again
    /// here so candidates cannot outlive a change to the containing folder.
    pub visible: bool,
}

pub(crate) struct LinkFolder {
    pub id: FolderId,
    pub dense_id: u32,
    pub parent: Option<FolderId>,
    pub slug_fold: String,
    pub active: bool,
}

struct FolderPosition {
    path: String,
    active: bool,
    depth: usize,
}

pub(crate) struct FolderTopology {
    root: FolderId,
    folders: BTreeMap<FolderId, LinkFolder>,
    positions: BTreeMap<FolderId, FolderPosition>,
    live_paths: BTreeMap<String, FolderId>,
    live_children: BTreeMap<(FolderId, String), FolderId>,
    aliases: BTreeMap<(FolderId, String), BTreeSet<FolderId>>,
    aliases_by_target: BTreeMap<FolderId, BTreeSet<(FolderId, String)>>,
}

impl FolderTopology {
    pub fn build(
        root: FolderId,
        folders: impl IntoIterator<Item = LinkFolder>,
        aliases: impl IntoIterator<Item = ProjectedFolderAlias>,
    ) -> DomainResult<Self> {
        let folders = folders
            .into_iter()
            .map(|folder| (folder.id.clone(), folder))
            .collect::<BTreeMap<_, _>>();
        let root_row = folders.get(&root).ok_or_else(invalid_state)?;
        if root_row.parent.is_some() {
            return Err(invalid_state());
        }
        let mut positions = BTreeMap::from([(
            root.clone(),
            FolderPosition {
                path: String::new(),
                active: root_row.active,
                depth: 0,
            },
        )]);
        for folder in folders.values() {
            let mut lineage = Vec::new();
            let mut current = folder;
            while !positions.contains_key(&current.id) {
                if lineage.len() == MAX_FOLDER_DEPTH {
                    return Err(invalid_state());
                }
                lineage.push(current);
                current = current
                    .parent
                    .as_ref()
                    .and_then(|parent| folders.get(parent))
                    .ok_or_else(invalid_state)?;
            }
            while let Some(child) = lineage.pop() {
                let ancestor = &positions[&current.id];
                let depth = ancestor.depth + 1;
                if depth > MAX_FOLDER_DEPTH {
                    return Err(invalid_state());
                }
                let mut path = ancestor.path.clone();
                if !path.is_empty() {
                    path.push('/');
                }
                path.push_str(&child.slug_fold);
                positions.insert(
                    child.id.clone(),
                    FolderPosition {
                        path,
                        active: child.active && ancestor.active,
                        depth,
                    },
                );
                current = child;
            }
        }
        let mut live_paths = BTreeMap::new();
        let mut live_children = BTreeMap::new();
        let mut live_aliases = BTreeMap::<_, BTreeSet<_>>::new();
        let mut aliases_by_target = BTreeMap::<_, BTreeSet<_>>::new();
        for (id, position) in &positions {
            if !position.active {
                continue;
            }
            if live_paths
                .insert(position.path.clone(), id.clone())
                .is_some()
            {
                return Err(invalid_state());
            }
            let folder = &folders[id];
            if let Some(parent) = folder.parent.as_ref() {
                live_children.insert((parent.clone(), folder.slug_fold.clone()), id.clone());
            }
        }
        for alias in aliases {
            if positions
                .get(&alias.target_folder_id)
                .is_some_and(|position| position.active)
            {
                let address = (alias.old_parent_folder_id, alias.old_slug_fold);
                aliases_by_target
                    .entry(alias.target_folder_id.clone())
                    .or_default()
                    .insert(address.clone());
                live_aliases
                    .entry(address)
                    .or_default()
                    .insert(alias.target_folder_id);
            }
        }
        Ok(Self {
            root,
            folders,
            positions,
            live_paths,
            live_children,
            aliases: live_aliases,
            aliases_by_target,
        })
    }

    pub fn path(&self, id: &FolderId) -> Option<&str> {
        self.positions.get(id).map(|folder| folder.path.as_str())
    }

    pub fn is_active(&self, id: &FolderId) -> bool {
        self.positions.get(id).is_some_and(|folder| folder.active)
    }

    fn active_dense(&self, id: &FolderId) -> Option<i64> {
        self.is_active(id)
            .then(|| i64::from(self.folders[id].dense_id))
    }

    /// Include both addresses of moved folders, including every affected
    /// descendant. Paths of unaffected sibling folders are absent.
    pub fn changed_addresses(&self, next: &Self) -> FolderAddresses {
        let mut result = FolderAddresses::default();
        for id in self.positions.keys().chain(next.positions.keys()) {
            let before = self.path(id);
            let after = next.path(id);
            if before != after || self.is_active(id) != next.is_active(id) {
                result.sources.insert(id.clone());
                result
                    .prefixes
                    .extend(before.into_iter().chain(after).map(str::to_owned));
            }
        }
        // Adding, removing or deactivating a historical path also changes
        // absolute references to that alias even when its target did not move.
        for (key @ (parent, old_slug), targets) in self.aliases.iter().chain(&next.aliases) {
            if self.aliases.get(key) != next.aliases.get(key) {
                for base in self.path(parent).into_iter().chain(next.path(parent)) {
                    result.prefixes.insert(join_path(base, old_slug));
                }
                for target in targets {
                    result.sources.insert(target.clone());
                }
                // The changed address may itself be beneath a historically
                // moved parent. Cover it through that parent's alias prefix.
                self.alias_prefixes(parent, &mut result.prefixes);
                next.alias_prefixes(parent, &mut result.prefixes);
            }
        }
        // Expand historical anchor prefixes, never scanning raw targets for
        // a segment anywhere in the path.
        for id in &result.sources {
            self.alias_prefixes(id, &mut result.prefixes);
            next.alias_prefixes(id, &mut result.prefixes);
        }
        let mut roots = BTreeSet::new();
        for prefix in std::mem::take(&mut result.prefixes) {
            let covered = roots.contains("")
                || prefix
                    .match_indices('/')
                    .any(|(separator, _)| roots.contains(&prefix[..separator]));
            if !covered {
                roots.insert(prefix);
            }
        }
        result.prefixes = roots;
        result
    }

    fn alias_prefixes(&self, id: &FolderId, prefixes: &mut BTreeSet<String>) {
        let mut pending = vec![id.clone()];
        let mut visited = BTreeSet::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id.clone()) {
                continue;
            }
            if let Some(parent) = self
                .folders
                .get(&id)
                .and_then(|folder| folder.parent.as_ref())
            {
                pending.push(parent.clone());
            }
            for (parent, slug) in self.aliases_by_target.get(&id).into_iter().flatten() {
                if let Some(base) = self.path(parent) {
                    prefixes.insert(join_path(base, slug));
                }
                pending.push(parent.clone());
            }
        }
    }

    fn directory(&self, source: &FolderId, raw: &str) -> Option<Directory> {
        let Some((directory, _)) = raw.rsplit_once('/') else {
            return Some(Directory {
                folder: self.active_dense(source),
                prefix: String::new(),
                qualified: false,
            });
        };
        let relative = !raw.starts_with('/');
        let mut parts: Vec<String> = if relative {
            self.path(source)?
                .split('/')
                .filter(|part| !part.is_empty())
                .map(str::to_owned)
                .collect()
        } else {
            Vec::new()
        };
        for part in directory.split('/').filter(|part| !part.is_empty()) {
            match part {
                "." => (),
                ".." => {
                    parts.pop()?;
                }
                part => parts.push(lookup_key(part)),
            }
        }
        let prefix = parts.join("/");
        let folder = self
            .live_paths
            .get(&prefix)
            .and_then(|folder| self.active_dense(folder));
        Some(Directory {
            folder,
            prefix,
            qualified: true,
        })
    }

    fn historical_folder(&self, prefix: &str) -> Option<i64> {
        let mut at = self.root.clone();
        let mut used_alias = false;
        for segment in prefix.split('/').filter(|segment| !segment.is_empty()) {
            let key = (at.clone(), segment.to_owned());
            if let Some(active) = self.live_children.get(&key) {
                at = active.clone();
            } else {
                let targets = self.aliases.get(&key)?;
                if targets.len() != 1 {
                    return None;
                }
                at = targets.first()?.clone();
                used_alias = true;
            }
        }
        used_alias.then(|| self.active_dense(&at)).flatten()
    }
}

#[derive(Default)]
pub(crate) struct FolderAddresses {
    pub sources: BTreeSet<FolderId>,
    pub prefixes: BTreeSet<String>,
}

fn join_path(base: &str, leaf: &str) -> String {
    if base.is_empty() {
        leaf.to_owned()
    } else {
        format!("{base}/{leaf}")
    }
}

struct Directory {
    folder: Option<i64>,
    prefix: String,
    qualified: bool,
}

struct Target<'a> {
    raw: &'a str,
    kind: u32,
    leaf: String,
    directory: Option<Directory>,
    uses_relative_prefix: bool,
}

fn normalized_key(text: &str) -> Option<String> {
    let key = lookup_key(text);
    (!matches!(key.as_str(), "" | "." | "..")).then_some(key)
}

fn target<'a>(raw: &'a str, source: &FolderId, folders: &FolderTopology) -> Target<'a> {
    let kind = if NoteId::parse_v1(raw).is_ok() {
        TARGET_STABLE_ID
    } else if NoteId::parse(raw).is_ok() {
        TARGET_LEGACY_OR_NAME
    } else {
        TARGET_NAME
    };
    let leaf = lookup_key(raw.rsplit('/').next().unwrap_or_default());
    let leaf = leaf.strip_suffix(".md").unwrap_or(&leaf);
    let valid = !matches!(leaf, "" | "." | "..");
    Target {
        raw,
        kind,
        leaf: if valid {
            leaf.to_owned()
        } else {
            String::new()
        },
        directory: valid.then(|| folders.directory(source, raw)).flatten(),
        uses_relative_prefix: valid && raw.contains('/') && !raw.starts_with('/'),
    }
}

pub(crate) fn candidate_keys(
    space: &SpaceId,
    note: &LinkNote,
    folders: &FolderTopology,
) -> Vec<CandidateLookupKey> {
    let Some(folder) = folders.active_dense(&note.parent).filter(|_| note.visible) else {
        return Vec::new();
    };
    let mut keys = BTreeSet::new();
    let mut insert = |tier, scope, raw: &str| {
        if let Some(key) = normalized_key(raw) {
            keys.insert((tier, scope, key));
        }
    };
    insert(STABLE_ID, GLOBAL_FOLDER, note.id.as_str());
    insert(PATH_FILENAME, folder, &note.slug_fold);
    insert(FILENAME, GLOBAL_FOLDER, &note.slug_fold);
    insert(11, folder, &note.title);
    insert(30, GLOBAL_FOLDER, &note.title);
    if let Some(YamlValue::String(slug)) = note.raw_fields.get("slug") {
        insert(PATH_SLUG, folder, slug);
        insert(40, GLOBAL_FOLDER, slug);
    }
    if let Some(YamlValue::Sequence(aliases)) = note.raw_fields.get("aliases") {
        let mut added = 0usize;
        for alias in aliases {
            if let YamlValue::String(alias) = alias {
                if added >= MAX_AUTHORED_ALIASES_PER_NOTE {
                    break;
                }
                insert(AUTHORED_ALIAS, GLOBAL_FOLDER, alias);
                added += 1;
            }
        }
    }
    keys.into_iter()
        .map(
            |(tier, scope_folder_dense_id, leaf_norm_key)| CandidateLookupKey {
                space_id: space.clone(),
                tier,
                scope_folder_dense_id,
                leaf_norm_key,
                target_dense_id: note.dense_id,
                target_note_id: note.id.clone(),
                created_at_sec: note.created_at.unix_seconds(),
                created_at_nsec: note.created_at.nanosecond(),
            },
        )
        .collect()
}

#[cfg(test)]
fn link_row(
    space: &SpaceId,
    note: &LinkNote,
    ordinal: u32,
    raw: String,
    folders: &FolderTopology,
) -> ProjectedLink {
    source_link_row(space, note.dense_id, &note.parent, ordinal, raw, folders)
}

pub(crate) fn source_link_row(
    space: &SpaceId,
    dense: u32,
    parent: &FolderId,
    ordinal: u32,
    raw: String,
    folders: &FolderTopology,
) -> ProjectedLink {
    let target = target(&raw, parent, folders);
    let metadata = target.directory.as_ref();
    ProjectedLink {
        space_id: space.clone(),
        src_dense_id: dense,
        link_ord: ordinal,
        src_folder_id: parent.clone(),
        target_kind_tag: target.kind,
        dir_norm_prefix: metadata.map(|dir| dir.prefix.clone()).unwrap_or_default(),
        leaf_norm_key: target.leaf,
        uses_relative_prefix: target.uses_relative_prefix,
        raw_target: raw,
        resolved_dense_id: None,
        resolved_tier: None,
    }
}

#[derive(Clone, Copy)]
pub(crate) struct CandidateQuery<'a> {
    pub space: &'a SpaceId,
    pub folder: i64,
    pub leaf: &'a str,
    pub min_tier: u32,
    pub max_tier: u32,
    pub exact_note: Option<&'a str>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct CandidatePosition {
    pub tier: u32,
    pub created_at_sec: i64,
    pub created_at_nsec: u32,
    pub note: NoteId,
}

impl From<&CandidateLookupKey> for CandidatePosition {
    fn from(key: &CandidateLookupKey) -> Self {
        Self {
            tier: key.tier,
            created_at_sec: key.created_at_sec,
            created_at_nsec: key.created_at_nsec,
            note: key.target_note_id.clone(),
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct NoteAliasPosition {
    pub parent: FolderId,
    pub slug: String,
    pub seq: SpaceSeq,
    pub note: NoteId,
}

impl From<&ProjectedNoteAlias> for NoteAliasPosition {
    fn from(alias: &ProjectedNoteAlias) -> Self {
        Self {
            parent: alias.old_parent_folder_id.clone(),
            slug: alias.old_slug_fold.clone(),
            seq: alias.created_seq,
            note: alias.target_note_id.clone(),
        }
    }
}

#[derive(Clone, Copy)]
pub(crate) enum AliasKey {
    Slug,
    Title,
}

pub(crate) trait ResolutionIndex: Sync {
    fn candidates(
        &self,
        query: CandidateQuery<'_>,
        after: Option<&CandidatePosition>,
        limit: u16,
    ) -> impl Future<Output = Result<Vec<CandidateLookupKey>, PortError>> + Send;

    fn aliases(
        &self,
        space: &SpaceId,
        selector: AliasKey,
        leaf: &str,
        after: Option<&NoteAliasPosition>,
        limit: u16,
    ) -> impl Future<Output = Result<Vec<ProjectedNoteAlias>, PortError>> + Send;

    fn slot_occupant(
        &self,
        space: &SpaceId,
        parent: &FolderId,
        slug: &str,
    ) -> impl Future<Output = Result<Option<NoteId>, PortError>> + Send;
}

pub(crate) async fn resolve_link(
    row: &mut ProjectedLink,
    folders: &FolderTopology,
    index: &impl ResolutionIndex,
) -> Result<(), PortError> {
    let target = target(&row.raw_target, &row.src_folder_id, folders);
    let resolved = if folders.is_active(&row.src_folder_id) {
        resolve(&row.space_id, &target, folders, index).await?
    } else {
        None
    };
    row.dir_norm_prefix = target
        .directory
        .as_ref()
        .map(|dir| dir.prefix.clone())
        .unwrap_or_default();
    row.uses_relative_prefix = target.uses_relative_prefix;
    row.target_kind_tag = target.kind;
    row.leaf_norm_key = target.leaf;
    row.resolved_dense_id = resolved.map(|(dense, _)| dense);
    row.resolved_tier = resolved.map(|(_, tier)| tier);
    Ok(())
}

async fn resolve(
    space: &SpaceId,
    target: &Target<'_>,
    topology: &FolderTopology,
    index: &impl ResolutionIndex,
) -> Result<Option<(u32, u32)>, PortError> {
    let Some(directory) = target.directory.as_ref() else {
        return Ok(None);
    };
    let global = CandidateQuery {
        space,
        folder: GLOBAL_FOLDER,
        leaf: &target.leaf,
        min_tier: FILENAME,
        max_tier: AUTHORED_ALIAS,
        exact_note: None,
    };
    if target.kind != TARGET_NAME {
        let strict = CandidateQuery {
            min_tier: STABLE_ID,
            max_tier: STABLE_ID,
            exact_note: Some(target.raw),
            ..global
        };
        if let Some(dense) = first_candidate(index, strict).await? {
            return Ok(Some(dense));
        }
        if target.kind == TARGET_STABLE_ID {
            return Ok(None);
        }
    }
    if let Some(folder) = directory.folder {
        let path = CandidateQuery {
            folder,
            min_tier: PATH_FILENAME,
            max_tier: PATH_SLUG,
            ..global
        };
        if let Some(dense) = first_candidate(index, path).await? {
            return Ok(Some(dense));
        }
    }
    if !directory.qualified
        && let Some(dense) = first_candidate(index, global).await?
    {
        return Ok(Some(dense));
    }

    if !directory.qualified || directory.folder.is_some() {
        let scope = directory.qualified.then_some(directory.folder).flatten();
        for selector in [AliasKey::Slug, AliasKey::Title] {
            match note_alias(index, topology, space, selector, &target.leaf, scope).await? {
                OldTarget::Unique(dense) => return Ok(Some((dense, NOTE_ALIAS))),
                OldTarget::Ambiguous => return Ok(None),
                OldTarget::Missing => (),
            }
        }
    }

    if directory.qualified
        && directory.folder.is_none()
        && let Some(folder) = topology.historical_folder(&directory.prefix)
    {
        let query = CandidateQuery {
            folder,
            min_tier: PATH_FILENAME,
            max_tier: PATH_SLUG,
            ..global
        };
        // One note can contribute one row per path tier. A fourth row always
        // introduces another target, so a bounded read is sufficient here.
        let candidates = index.candidates(query, None, 4).await?;
        if let Some(first) = candidates.first()
            && candidates
                .iter()
                .all(|row| row.target_dense_id == first.target_dense_id)
        {
            return Ok(Some((first.target_dense_id, FOLDER_ALIAS)));
        }
    }
    Ok(None)
}

async fn first_candidate(
    index: &impl ResolutionIndex,
    query: CandidateQuery<'_>,
) -> Result<Option<(u32, u32)>, PortError> {
    Ok(index
        .candidates(query, None, 1)
        .await?
        .into_iter()
        .next()
        .map(|row| (row.target_dense_id, row.tier)))
}

enum OldTarget {
    Missing,
    Unique(u32),
    Ambiguous,
}

async fn note_alias(
    index: &impl ResolutionIndex,
    topology: &FolderTopology,
    space: &SpaceId,
    selector: AliasKey,
    leaf: &str,
    folder: Option<i64>,
) -> Result<OldTarget, PortError> {
    let mut after = None;
    let mut result = None;
    loop {
        let rows = index
            .aliases(space, selector, leaf, after.as_ref(), ALIAS_PAGE)
            .await?;
        for row in &rows {
            if folder.is_some_and(|folder| {
                topology.active_dense(&row.old_parent_folder_id) != Some(folder)
            }) {
                continue;
            }
            if topology.is_active(&row.old_parent_folder_id)
                && index
                    .slot_occupant(space, &row.old_parent_folder_id, &row.old_slug_fold)
                    .await?
                    .is_some_and(|id| id != row.target_note_id)
            {
                continue;
            }
            let key = lookup_key(row.target_note_id.as_str());
            let query = CandidateQuery {
                space,
                folder: GLOBAL_FOLDER,
                leaf: &key,
                min_tier: STABLE_ID,
                max_tier: STABLE_ID,
                exact_note: Some(row.target_note_id.as_str()),
            };
            if let Some((dense, _)) = first_candidate(index, query).await? {
                if result.is_some_and(|prior| prior != dense) {
                    return Ok(OldTarget::Ambiguous);
                }
                result = Some(dense);
            }
        }
        if rows.len() < usize::from(ALIAS_PAGE) {
            return Ok(result.map_or(OldTarget::Missing, OldTarget::Unique));
        }
        after = rows.last().map(NoteAliasPosition::from);
    }
}

fn invalid_state() -> DomainError {
    DomainError::validation(ValidationReason::InvalidState)
}

/// In-memory oracle for the link resolution tests.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryResolutionIndex {
    candidates: BTreeMap<i64, BTreeMap<String, BTreeMap<CandidatePosition, CandidateLookupKey>>>,
    slug_aliases: BTreeMap<String, BTreeMap<NoteAliasPosition, ProjectedNoteAlias>>,
    title_aliases: BTreeMap<String, BTreeMap<NoteAliasPosition, ProjectedNoteAlias>>,
    slots: BTreeMap<FolderId, BTreeMap<String, NoteId>>,
}

#[cfg(test)]
impl MemoryResolutionIndex {
    pub fn put_candidate(&mut self, candidate: CandidateLookupKey) {
        self.candidates
            .entry(candidate.scope_folder_dense_id)
            .or_default()
            .entry(candidate.leaf_norm_key.clone())
            .or_default()
            .insert(CandidatePosition::from(&candidate), candidate);
    }

    pub fn put_alias(&mut self, alias: ProjectedNoteAlias) {
        let position = NoteAliasPosition::from(&alias);
        self.slug_aliases
            .entry(alias.old_slug_fold.clone())
            .or_default()
            .insert(position.clone(), alias.clone());
        self.title_aliases
            .entry(alias.old_title_norm.clone())
            .or_default()
            .insert(position, alias);
    }

    pub fn put_slot(&mut self, parent: FolderId, slug: String, note: NoteId) {
        self.slots.entry(parent).or_default().insert(slug, note);
    }
}

#[cfg(test)]
impl ResolutionIndex for MemoryResolutionIndex {
    async fn candidates(
        &self,
        query: CandidateQuery<'_>,
        after: Option<&CandidatePosition>,
        limit: u16,
    ) -> Result<Vec<CandidateLookupKey>, PortError> {
        let Some(rows) = self
            .candidates
            .get(&query.folder)
            .and_then(|rows| rows.get(query.leaf))
        else {
            return Ok(Vec::new());
        };
        let range = after
            .map(|position| {
                (
                    std::ops::Bound::Excluded(position),
                    std::ops::Bound::Unbounded,
                )
            })
            .unwrap_or((std::ops::Bound::Unbounded, std::ops::Bound::Unbounded));
        Ok(rows
            .range(range)
            .map(|(_, row)| row)
            .filter(|row| row.space_id == *query.space && row.tier >= query.min_tier)
            .take_while(|row| row.tier <= query.max_tier)
            .filter(|row| {
                query
                    .exact_note
                    .is_none_or(|note| note == row.target_note_id.as_str())
            })
            .take(usize::from(limit))
            .cloned()
            .collect())
    }

    async fn aliases(
        &self,
        space: &SpaceId,
        selector: AliasKey,
        leaf: &str,
        after: Option<&NoteAliasPosition>,
        limit: u16,
    ) -> Result<Vec<ProjectedNoteAlias>, PortError> {
        let map = match selector {
            AliasKey::Slug => &self.slug_aliases,
            AliasKey::Title => &self.title_aliases,
        };
        let Some(rows) = map.get(leaf) else {
            return Ok(Vec::new());
        };
        let range = after
            .map(|position| {
                (
                    std::ops::Bound::Excluded(position),
                    std::ops::Bound::Unbounded,
                )
            })
            .unwrap_or((std::ops::Bound::Unbounded, std::ops::Bound::Unbounded));
        Ok(rows
            .range(range)
            .map(|(_, row)| row)
            .filter(|row| row.space_id == *space)
            .take(usize::from(limit))
            .cloned()
            .collect())
    }

    async fn slot_occupant(
        &self,
        _space: &SpaceId,
        parent: &FolderId,
        slug: &str,
    ) -> Result<Option<NoteId>, PortError> {
        Ok(self
            .slots
            .get(parent)
            .and_then(|slots| slots.get(slug))
            .cloned())
    }
}

/// Combine current indexed rows and the records about to be committed. Every
/// forward/reverse resolution in a command sees the same candidate universe.
#[cfg(test)]
struct ResolutionOverlay<'a, T> {
    pub base: &'a T,
    pub staged: MemoryResolutionIndex,
    pub replace_candidates: BTreeSet<u32>,
    pub replace_slots: BTreeSet<NoteId>,
}

#[cfg(test)]
impl<'a, T> ResolutionOverlay<'a, T> {
    pub fn new(base: &'a T) -> Self {
        Self {
            base,
            staged: MemoryResolutionIndex::default(),
            replace_candidates: BTreeSet::new(),
            replace_slots: BTreeSet::new(),
        }
    }
}

#[cfg(test)]
impl<T: ResolutionIndex> ResolutionIndex for ResolutionOverlay<'_, T> {
    async fn candidates(
        &self,
        query: CandidateQuery<'_>,
        after: Option<&CandidatePosition>,
        limit: u16,
    ) -> Result<Vec<CandidateLookupKey>, PortError> {
        let staged = self.staged.candidates(query, after, limit).await?;
        let mut offset = after.cloned();
        let mut available = Vec::new();
        loop {
            let rows = self.base.candidates(query, offset.as_ref(), limit).await?;
            let complete = rows.len() < usize::from(limit);
            offset = rows.last().map(CandidatePosition::from);
            available.extend(
                rows.into_iter()
                    .filter(|row| !self.replace_candidates.contains(&row.target_dense_id)),
            );
            if complete || available.len() >= usize::from(limit) {
                break;
            }
        }
        available.extend(staged);
        available.sort_by_key(|row| CandidatePosition::from(row));
        available.truncate(usize::from(limit));
        Ok(available)
    }

    async fn aliases(
        &self,
        space: &SpaceId,
        selector: AliasKey,
        leaf: &str,
        after: Option<&NoteAliasPosition>,
        limit: u16,
    ) -> Result<Vec<ProjectedNoteAlias>, PortError> {
        let mut rows = self
            .base
            .aliases(space, selector, leaf, after, limit)
            .await?;
        rows.extend(
            self.staged
                .aliases(space, selector, leaf, after, limit)
                .await?,
        );
        rows.sort_by_key(|row| NoteAliasPosition::from(row));
        rows.dedup_by(|left, right| {
            NoteAliasPosition::from(&*left) == NoteAliasPosition::from(&*right)
        });
        rows.truncate(usize::from(limit));
        Ok(rows)
    }

    async fn slot_occupant(
        &self,
        space: &SpaceId,
        parent: &FolderId,
        slug: &str,
    ) -> Result<Option<NoteId>, PortError> {
        let staged = self.staged.slot_occupant(space, parent, slug).await?;
        if staged.is_some() {
            return Ok(staged);
        }
        Ok(self
            .base
            .slot_occupant(space, parent, slug)
            .await?
            .filter(|id| !self.replace_slots.contains(id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(slot: u8, parent: Option<FolderId>, slug: &str) -> LinkFolder {
        LinkFolder {
            id: FolderId::from_bytes([slot; 16]),
            dense_id: u32::from(slot),
            parent,
            slug_fold: slug.to_owned(),
            active: true,
        }
    }

    #[test]
    fn folder_topology_counts_depth_through_cached_parents() {
        fn id(edge: usize) -> FolderId {
            FolderId::from_bytes((edge as u128).to_be_bytes())
        }
        let chain = |depth| {
            (0..=depth).map(|edge| LinkFolder {
                id: id(edge),
                dense_id: u32::try_from(edge).unwrap(),
                parent: edge.checked_sub(1).map(id),
                slug_fold: "d".to_owned(),
                active: true,
            })
        };
        let topology = FolderTopology::build(id(0), chain(MAX_FOLDER_DEPTH), []).unwrap();
        assert_eq!(
            topology.positions[&id(MAX_FOLDER_DEPTH)].depth,
            MAX_FOLDER_DEPTH
        );
        assert!(FolderTopology::build(id(0), chain(MAX_FOLDER_DEPTH + 1), []).is_err());
    }

    fn note(slot: u8, parent: &FolderId, slug: &str, title: &str) -> LinkNote {
        LinkNote {
            id: NoteId::from_bytes([slot; 16]),
            dense_id: u32::from(slot),
            parent: parent.clone(),
            slug_fold: lookup_key(slug),
            title: title.to_owned(),
            created_at: Timestamp::from_unix_parts(1, u32::from(slot)).unwrap(),
            raw_fields: BTreeMap::new(),
            visible: true,
        }
    }

    fn add_note(
        space: &SpaceId,
        index: &mut MemoryResolutionIndex,
        note: &LinkNote,
        topology: &FolderTopology,
    ) {
        for candidate in candidate_keys(space, note, topology) {
            index.put_candidate(candidate);
        }
        if note.visible {
            index.put_slot(note.parent.clone(), note.slug_fold.clone(), note.id.clone());
        }
    }

    async fn resolve_target(
        space: &SpaceId,
        source: &LinkNote,
        raw: &str,
        topology: &FolderTopology,
        index: &impl ResolutionIndex,
    ) -> Option<(u32, u32)> {
        let mut row = link_row(space, source, 0, raw.to_owned(), topology);
        resolve_link(&mut row, topology, index).await.unwrap();
        row.resolved_dense_id.zip(row.resolved_tier)
    }

    #[tokio::test]
    async fn precedence_stable_legacy_paths_and_all_historical_tiers() {
        let space = SpaceId::from_bytes([90; 16]);
        let root = folder(1, None, "root");
        let directory = folder(2, Some(root.id.clone()), "dir");
        let source = note(1, &root.id, "source", "Source");
        let mut target = note(2, &directory.id, "file", "Architecture Overview");
        target
            .raw_fields
            .insert("slug".into(), YamlValue::String("custom".into()));
        target.raw_fields.insert(
            "aliases".into(),
            YamlValue::Sequence(vec![YamlValue::String("authored".into())]),
        );
        let alias = ProjectedFolderAlias {
            space_id: space.clone(),
            old_parent_folder_id: root.id.clone(),
            old_slug_fold: "old-dir".into(),
            created_seq: SpaceSeq::new(1).unwrap(),
            target_folder_id: directory.id.clone(),
        };
        let topology = FolderTopology::build(root.id.clone(), [root, directory], [alias]).unwrap();
        let mut index = MemoryResolutionIndex::default();
        add_note(&space, &mut index, &target, &topology);
        index.put_alias(ProjectedNoteAlias {
            space_id: space.clone(),
            old_parent_folder_id: target.parent.clone(),
            old_slug_fold: "old-slug".into(),
            old_title_norm: "former plan".into(),
            created_seq: SpaceSeq::new(1).unwrap(),
            target_note_id: target.id.clone(),
        });
        let cases = [
            (target.id.as_str(), 0),
            ("dir/file.MD", 10),
            ("/DIR/Architecture Overview.md", 11),
            ("./dir/custom", 12),
            ("file", 20),
            ("Architecture Overview", 30),
            ("custom", 40),
            ("authored", 50),
            ("old-slug", 60),
            ("Former Plan", 60),
            ("old-dir/file.md", 70),
        ];
        for (raw, tier) in cases {
            assert_eq!(
                resolve_target(&space, &source, raw, &topology, &index).await,
                Some((target.dense_id, tier)),
                "{raw}",
            );
        }
        for raw in [
            ".",
            "..",
            "dir/",
            ".MD",
            "dir/..",
            "../file",
            "wrong-dir/file",
        ] {
            assert_eq!(
                resolve_target(&space, &source, raw, &topology, &index).await,
                None,
                "{raw}"
            );
        }

        let mut word = note(3, &source.parent, "architecture", "Word");
        let mut legacy = note(4, &target.parent, "other", "Actual ID");
        legacy.id = NoteId::parse("Architecture").unwrap();
        add_note(&space, &mut index, &word, &topology);
        add_note(&space, &mut index, &legacy, &topology);
        assert_eq!(
            resolve_target(&space, &source, "architecture", &topology, &index).await,
            Some((3, 10)),
        );
        assert_eq!(
            resolve_target(&space, &source, "Architecture", &topology, &index).await,
            Some((4, 0)),
        );
        let missing_id = NoteId::from_bytes([5; 16]);
        word.slug_fold = lookup_key(missing_id.as_str());
        add_note(&space, &mut index, &word, &topology);
        assert_eq!(
            resolve_target(&space, &source, missing_id.as_str(), &topology, &index).await,
            None,
        );
    }

    #[tokio::test]
    async fn alias_ambiguity_slot_occupation_and_candidate_replacement_match_a_cold_seed() {
        let space = SpaceId::from_bytes([80; 16]);
        let root = folder(1, None, "root");
        let directory = folder(2, Some(root.id.clone()), "dir");
        let source = note(1, &root.id, "source", "Source");
        let first = note(2, &directory.id, "current-1", "Current 1");
        let second = note(3, &directory.id, "current-2", "Current 2");
        let occupant = note(4, &directory.id, "first-slot", "Unrelated");
        let topology = FolderTopology::build(root.id.clone(), [root, directory], []).unwrap();
        let mut index = MemoryResolutionIndex::default();
        add_note(&space, &mut index, &first, &topology);
        add_note(&space, &mut index, &second, &topology);
        let alias = |target: &LinkNote, slug: &str| ProjectedNoteAlias {
            space_id: space.clone(),
            old_parent_folder_id: target.parent.clone(),
            old_slug_fold: slug.into(),
            old_title_norm: "former plan".into(),
            created_seq: SpaceSeq::new(1).unwrap(),
            target_note_id: target.id.clone(),
        };
        index.put_alias(alias(&first, "first-slot"));
        index.put_alias(alias(&second, "second-slot"));
        assert_eq!(
            resolve_target(&space, &source, "Former Plan", &topology, &index).await,
            None
        );

        let mut trash = ResolutionOverlay::new(&index);
        trash.replace_candidates.insert(second.dense_id);
        trash.replace_slots.insert(second.id.clone());
        assert_eq!(
            resolve_target(&space, &source, "Former Plan", &topology, &trash).await,
            Some((2, 60)),
        );
        trash.staged.put_slot(
            occupant.parent.clone(),
            occupant.slug_fold.clone(),
            occupant.id.clone(),
        );
        assert_eq!(
            resolve_target(&space, &source, "Former Plan", &topology, &trash).await,
            None
        );

        let mut cold = MemoryResolutionIndex::default();
        cold.put_alias(alias(&first, "first-slot"));
        cold.put_alias(alias(&second, "second-slot"));
        add_note(&space, &mut cold, &first, &topology);
        add_note(&space, &mut cold, &occupant, &topology);
        assert_eq!(
            resolve_target(&space, &source, "Former Plan", &topology, &trash).await,
            resolve_target(&space, &source, "Former Plan", &topology, &cold).await,
        );
        assert_eq!(
            resolve_target(&space, &source, "Former Plan", &topology, &index).await,
            None
        );
    }

    #[tokio::test]
    async fn folder_move_keeps_candidate_identity_and_rechecks_initially_escaping_relative_path() {
        let space = SpaceId::from_bytes([70; 16]);
        let root_id = FolderId::from_bytes([1; 16]);
        let parent_id = FolderId::from_bytes([2; 16]);
        let moved_id = FolderId::from_bytes([3; 16]);
        let previous = FolderTopology::build(
            root_id.clone(),
            [
                folder(1, None, "root"),
                folder(2, Some(root_id.clone()), "parent"),
                folder(3, Some(root_id.clone()), "moved"),
            ],
            [],
        )
        .unwrap();
        let changed = FolderTopology::build(
            root_id.clone(),
            [
                folder(1, None, "root"),
                folder(2, Some(root_id.clone()), "parent"),
                folder(3, Some(parent_id), "moved"),
            ],
            [],
        )
        .unwrap();
        let source = note(1, &moved_id, "source", "Source");
        let target = note(2, &root_id, "root-target", "Root Target");
        assert_eq!(
            candidate_keys(&space, &source, &previous),
            candidate_keys(&space, &source, &changed)
        );
        let addresses = previous.changed_addresses(&changed);
        assert_eq!(
            addresses.sources.into_iter().collect::<Vec<_>>(),
            [moved_id]
        );
        assert_eq!(
            addresses.prefixes.into_iter().collect::<Vec<_>>(),
            ["moved", "parent/moved"]
        );

        let mut index = MemoryResolutionIndex::default();
        add_note(&space, &mut index, &target, &previous);
        let mut row = link_row(&space, &source, 0, "../../root-target".into(), &previous);
        resolve_link(&mut row, &previous, &index).await.unwrap();
        assert!(row.uses_relative_prefix);
        assert_eq!(row.resolved_dense_id, None);
        resolve_link(&mut row, &changed, &index).await.unwrap();
        assert_eq!(row.resolved_dense_id, Some(2));
        assert_eq!(
            resolve_target(&space, &source, "Root Target", &previous, &index).await,
            resolve_target(&space, &source, "Root Target", &changed, &index).await,
        );
    }
}
