use std::collections::{BTreeMap, BTreeSet};

use notarium_canonical::domain::common::MAX_FOLDER_DEPTH;
use notarium_canonical::{
    codec::{encode_msgpack, evaluate_fields_with_schema},
    projection_read::{ProjectedSchemaSnapshot, ProjectionFolder, ProjectionNote, ProjectionRank},
};
use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{Diagnostic, PortError, ValidationReason},
    ids::*,
    model::{HistoryScope, Lifecycle},
    query::FieldSchema,
    value::YamlValue,
};
use notarium_syntax::{
    extract::{ExtractedDocDelta, extract},
    frontmatter,
    unicode::lookup_key,
};

use crate::{
    derived::{
        ProjectedFolder, ProjectedNote, ProjectedViewDescriptor, ProjectedViewRank,
        ProjectionSchema,
    },
    index::{IndexNote, NoteSortHeader},
    nota::{CompiledViews, DescriptorState, ViewInput, ViewKind, compile_projected_views},
};

use super::checkpoint_error;

#[derive(Default)]
pub(super) struct FolderCatalog {
    pub(super) rows: BTreeMap<FolderId, ProjectedFolder>,
}

pub(super) struct FolderLocation {
    pub(super) dense: Vec<u32>,
    pub(super) ids: Vec<FolderId>,
    pub(super) trashed: bool,
    pub(super) write_locked: bool,
    pub(super) project: Option<FolderId>,
    pub(super) display_path: String,
    pub(super) norm_path: String,
}

impl FolderCatalog {
    pub(super) fn location(&self, folder: &FolderId) -> Result<FolderLocation, PortError> {
        let mut dense = Vec::new();
        let mut ids = Vec::new();
        let mut display = Vec::new();
        let mut norm = Vec::new();
        let mut parent = Some(folder);
        let mut trashed = false;
        let mut write_locked = false;
        let mut project = None;
        while let Some(id) = parent {
            if ids.len() > MAX_FOLDER_DEPTH || ids.contains(id) {
                return Err(DomainError::validation(ValidationReason::InvalidState).into());
            }
            let row = self.rows.get(id).ok_or(DomainError::ResourceNotFound)?;
            if row.parent_folder_id.is_some() {
                display.push(row.slug.as_str());
                norm.push(row.slug_fold.as_str());
            }
            dense.push(row.dense_folder_id);
            ids.push(id.clone());
            trashed |= row.lifecycle != Lifecycle::Active;
            write_locked |= row.write_locked;
            if project.is_none() && row.is_project {
                project = Some(id.clone());
            }
            parent = row.parent_folder_id.as_ref();
        }
        display.reverse();
        norm.reverse();
        Ok(FolderLocation {
            dense,
            ids,
            trashed,
            write_locked,
            project,
            display_path: display.join("/"),
            norm_path: norm.join("/"),
        })
    }

    pub(super) fn put(
        &mut self,
        scope: &HistoryScope,
        folder: ProjectionFolder,
        next_dense: &mut u64,
        retained_dense: Option<u32>,
    ) -> Result<(), PortError> {
        let m = folder.metadata;
        let (dense, count) = match self.rows.get(&m.folder_id) {
            Some(old) => (old.dense_folder_id, old.active_note_count),
            None => (
                match retained_dense {
                    Some(dense) => dense,
                    None => allocate_dense(next_dense)?,
                },
                0,
            ),
        };
        self.rows.insert(
            m.folder_id.clone(),
            ProjectedFolder {
                space_id: scope.space_id.clone(),
                folder_id: m.folder_id,
                dense_folder_id: dense,
                parent_folder_id: m.parent_folder_id,
                slug: m.slug,
                slug_fold: m.slug_fold,
                display_name: m.display_name,
                norm_path_prefix: String::new(),
                display_path_prefix: String::new(),
                is_project: m.is_project,
                project_slug: m.project_slug,
                project_folder_id: None,
                cover_note_id: m.cover_note_id,
                write_locked: m.write_locked,
                lifecycle: m.lifecycle,
                head_rev_id: folder.revision_id,
                active_note_count: count,
            },
        );
        Ok(())
    }

    pub(super) fn refresh_paths(&mut self) -> Result<(), PortError> {
        let locations = self
            .rows
            .keys()
            .map(|id| self.location(id).map(|location| (id.clone(), location)))
            .collect::<Result<Vec<_>, _>>()?;
        for (id, location) in locations {
            if let Some(row) = self.rows.get_mut(&id) {
                row.display_path_prefix = location.display_path;
                row.norm_path_prefix = location.norm_path;
                row.project_folder_id = location.project;
            }
        }
        Ok(())
    }
}

pub(super) fn allocate_dense(next: &mut u64) -> Result<u32, PortError> {
    let dense = u32::try_from(*next)
        .ok()
        .filter(|dense| *dense < u32::MAX)
        .ok_or_else(|| DomainError::validation(ValidationReason::InvalidLimit))?;
    *next += 1;
    Ok(dense)
}

#[derive(Clone)]
pub(super) struct NoteProjection {
    pub(super) row: ProjectedNote,
    pub(super) views: CompiledViews,
    pub(super) links: Vec<String>,
}

pub(super) fn project_note(
    scope: &HistoryScope,
    note: ProjectionNote,
    dense_id: u32,
    location: &FolderLocation,
    source: Option<&str>,
    fields: &BTreeMap<String, FieldSchema>,
) -> Result<NoteProjection, PortError> {
    let m = note.metadata;
    let plain = m.doc_class != DocClass::EncryptedNote;
    let (blocks, tags, links, preview) = if let Some(source) = source.filter(|_| plain) {
        let ExtractedDocDelta::Plain(extracted) =
            extract(source, m.doc_class, &m.note_id, &m.title, None)?
        else {
            return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
        };
        let body = frontmatter::analyze(source, m.doc_class)?
            .carrier
            .body
            .slice(source)?;
        let preview = body.trim().chars().take(320).collect();
        (
            extracted.views,
            extracted
                .tags
                .into_iter()
                .map(|tag| tag.key)
                .collect::<Vec<_>>(),
            extracted
                .links
                .into_iter()
                .map(|link| link.raw)
                .collect::<Vec<_>>(),
            preview,
        )
    } else {
        (Vec::new(), Vec::new(), Vec::new(), String::new())
    };
    let raw = if plain { m.raw_fields.as_ref() } else { None };
    let diagnostic = if plain {
        note.header_diagnostic.as_ref()
    } else {
        None
    };
    let observations = if plain {
        evaluate_fields_with_schema(raw, diagnostic, Some(fields))
    } else {
        BTreeMap::new()
    };
    let blocks: Vec<_> = blocks.into_iter().map(ViewInput::from).collect();
    let views = compile_projected_views(&blocks, fields);
    let row = ProjectedNote {
        space_id: scope.space_id.clone(),
        dense_id,
        note_id: m.note_id,
        rev_id: note.revision_id,
        parent_folder_id: m.parent_folder_id,
        dense_folder_id: *location
            .dense
            .first()
            .ok_or(DomainError::ResourceNotFound)?,
        ability_id: m.ability_id,
        slug: m.slug,
        slug_fold: m.slug_fold,
        title_fold: if plain {
            lookup_key(&m.title)
        } else {
            String::new()
        },
        title: if plain { m.title } else { String::new() },
        preview,
        doc_class: m.doc_class,
        lifecycle: m.lifecycle,
        byte_size: m.byte_size,
        content_digest: m.content_digest,
        created_at_sec: note.created_at.unix_seconds(),
        created_at_nsec: note.created_at.nanosecond(),
        updated_at_sec: note.updated_at.unix_seconds(),
        updated_at_nsec: note.updated_at.nanosecond(),
        raw_fields_msgpack: encode_msgpack(&raw)?,
        header_diagnostic_msgpack: encode_msgpack(&diagnostic)?,
        evaluated_fields_msgpack: encode_msgpack(&observations)?,
        diagnostics_msgpack: if plain {
            encode_msgpack(&m.diagnostics)?
        } else {
            encode_msgpack(&Vec::<Diagnostic>::new())?
        },
        tags_msgpack: encode_msgpack(&tags)?,
        view_blocks_msgpack: encode_msgpack(&blocks)?,
        rank_version: note.rank_version,
        has_pending_nota: views.has_pending_nota,
        has_invalid_nota: views.has_invalid_nota,
    };
    Ok(NoteProjection { row, views, links })
}

pub(super) fn reevaluate(
    row: &mut ProjectedNote,
    fields: &BTreeMap<String, FieldSchema>,
) -> Result<CompiledViews, PortError> {
    if row.doc_class == DocClass::EncryptedNote {
        return Ok(CompiledViews::default());
    }
    let raw = note_raw_fields(row)?;
    let diagnostic: Option<Diagnostic> = decode(&row.header_diagnostic_msgpack)?;
    let blocks: Vec<ViewInput> = decode(&row.view_blocks_msgpack)?;
    row.evaluated_fields_msgpack = encode_msgpack(&evaluate_fields_with_schema(
        raw.as_ref(),
        diagnostic.as_ref(),
        Some(fields),
    ))?;
    let views = compile_projected_views(&blocks, fields);
    row.has_pending_nota = views.has_pending_nota;
    row.has_invalid_nota = views.has_invalid_nota;
    Ok(views)
}

pub(super) fn persisted_schema(
    snapshot: &ProjectedSchemaSnapshot,
) -> Result<ProjectionSchema, PortError> {
    Ok(ProjectionSchema {
        revision: snapshot.schema_rev_id.clone(),
        fingerprint: snapshot.descriptor_fingerprint,
        fields_msgpack: encode_msgpack(&snapshot.fields)?,
    })
}

pub(super) fn descriptors(
    row: &ProjectedNote,
    views: CompiledViews,
    schema: Option<&ProjectionSchema>,
) -> Result<Vec<ProjectedViewDescriptor>, PortError> {
    views
        .descriptors
        .into_iter()
        .map(|(key, state)| {
            let compiled = match &state {
                DescriptorState::Ready(descriptor) => Some(encode_msgpack(descriptor)?),
                DescriptorState::Rejected(_) => None,
            };
            let (view_kind, diagnostics) = match &state {
                DescriptorState::Ready(descriptor) => {
                    let kind = match descriptor.kind {
                        ViewKind::Table => "table",
                        ViewKind::List => "list",
                        ViewKind::Board => "board",
                        ViewKind::Calendar => "calendar",
                    };
                    (Some(kind.to_owned()), Vec::new())
                }
                DescriptorState::Rejected(reason) => (
                    None,
                    vec![Diagnostic {
                        reason: *reason,
                        location: None,
                    }],
                ),
            };
            Ok(ProjectedViewDescriptor {
                space_id: row.space_id.clone(),
                view_note_id: row.note_id.clone(),
                view_key: key,
                view_note_rev_id: row.rev_id.clone(),
                schema_rev_id: schema.map(|schema| schema.revision.clone()),
                state: match &state {
                    DescriptorState::Ready(_) => "ready",
                    DescriptorState::Rejected(ValidationReason::PendingView) => "pending",
                    DescriptorState::Rejected(_) => "invalid",
                }
                .to_owned(),
                view_kind,
                view_fingerprint: compiled
                    .as_ref()
                    .map(|bytes| ContentDigest::from_bytes(*blake3::hash(bytes).as_bytes())),
                compiled_msgpack: compiled,
                diagnostics_msgpack: encode_msgpack(&diagnostics)?,
            })
        })
        .collect()
}

pub(super) fn rank_row(
    scope: &HistoryScope,
    rank: ProjectionRank,
) -> Result<ProjectedViewRank, PortError> {
    let m = rank.metadata;
    let (group_key_msgpack, group_key_hex) =
        notarium_canonical::codec::group_key_hex(&m.group_key)?;
    Ok(ProjectedViewRank {
        space_id: scope.space_id.clone(),
        view_note_id: m.view_note_id,
        view_key: m.view_key,
        target_note_id: m.target_note_id,
        group_key_hex,
        group_key_msgpack,
        sort_rank_lexo: m.sort_rank_lexo,
        rank_rev_id: rank.revision_id,
        placement_revision: m.placement_revision,
        updated_seq: rank.visibility_seq,
    })
}

pub(super) use crate::derived::decode_payload as decode;

pub(super) fn note_raw_fields(
    row: &ProjectedNote,
) -> Result<Option<BTreeMap<String, YamlValue>>, PortError> {
    decode(&row.raw_fields_msgpack)
}

pub(crate) fn effective_tags(
    inline: &[String],
    raw: Option<&BTreeMap<String, YamlValue>>,
) -> Vec<String> {
    let mut tags = inline.iter().cloned().collect::<BTreeSet<_>>();
    if let Some(YamlValue::Sequence(values)) = raw.and_then(|values| values.get("tags")) {
        tags.extend(values.iter().filter_map(|value| match value {
            YamlValue::String(tag) => Some(lookup_key(tag)),
            _ => None,
        }));
    }
    tags.into_iter().collect()
}

pub(super) fn index_note(
    row: &ProjectedNote,
    location: &FolderLocation,
    apply: impl FnOnce(IndexNote<'_>) -> Result<(), crate::index::IndexError>,
) -> Result<(), PortError> {
    let fields = row.evaluated_fields()?;
    let inline: Vec<String> = decode(&row.tags_msgpack)?;
    let raw = note_raw_fields(row)?;
    let tags = effective_tags(&inline, raw.as_ref());
    apply(IndexNote {
        dense: row.dense_id,
        id: &row.note_id,
        header: NoteSortHeader::new(
            row.updated_at()?,
            row.created_at()?,
            row.dense_folder_id,
            row.doc_class,
            row.lifecycle,
        ),
        ancestors: &location.dense,
        trashed_ancestor: location.trashed,
        fields: &fields,
        tags: &tags,
        ability: row.ability_id.as_ref(),
    })
    .map_err(checkpoint_error)
}
