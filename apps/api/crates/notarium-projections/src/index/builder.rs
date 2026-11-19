use std::collections::{BTreeMap, BTreeSet};
#[cfg(any(test, feature = "test-support"))]
use std::path::Path;

use croaring::{Bitmap, Frozen};
use notarium_core::{
    ids::{ClusterId, FolderId, NoteId},
    model::Lifecycle,
    value::ScalarValue,
};

use crate::mmap::{self, SectionKind, WriteSection};

#[cfg(any(test, feature = "test-support"))]
use super::{BaseIndexHandle, TrustedCheckpoint};
use super::{IndexError, IndexIdentity, IndexNote, PostingKey, model::*};

const MAX_DIRECT_VALUES: usize = 65_536;

#[derive(Default)]
pub struct GraphSections {
    pub outgoing: Vec<Vec<u32>>,
    pub incoming: Vec<Vec<u32>>,
    pub clusters: Vec<Option<ClusterId>>,
}

#[derive(Default)]
pub struct FastIndexBuilder {
    notes: BTreeMap<u32, (NoteId, NoteSortHeader)>,
    folders: BTreeMap<u32, (FolderId, Lifecycle)>,
    node_count: u32,
    folder_count: u32,
    postings: BTreeMap<Vec<u8>, Bitmap>,
    value_counts: BTreeMap<Vec<u8>, usize>,
    bsi: BTreeMap<Vec<u8>, Bitmap>,
    exact_integers: BTreeMap<Vec<u8>, Vec<(u32, i128)>>,
    graph: GraphSections,
}

impl FastIndexBuilder {
    pub fn reserve_dense(&mut self, notes: u32, folders: u32) {
        self.node_count = self.node_count.max(notes);
        self.folder_count = self.folder_count.max(folders);
    }

    pub fn add_folder(
        &mut self,
        dense: u32,
        id: &FolderId,
        lifecycle: Lifecycle,
    ) -> Result<(), IndexError> {
        let next = dense
            .checked_add(1)
            .ok_or(IndexError::InvalidInput("folder slot overflow"))?;
        if self.folders.contains_key(&dense) {
            return Err(IndexError::InvalidInput("duplicate folder slot"));
        }
        self.folders.insert(dense, (id.clone(), lifecycle));
        self.folder_count = self.folder_count.max(next);
        Ok(())
    }

    pub fn add_note(&mut self, note: IndexNote<'_>) -> Result<(), IndexError> {
        if self.notes.contains_key(&note.dense) {
            return Err(IndexError::InvalidInput("duplicate note slot"));
        }
        let NotePostings { ordinary, scalars } = note.postings()?;
        self.node_count = self.node_count.max(note.dense + 1);
        self.notes
            .insert(note.dense, (note.id.clone(), note.header));
        for key in ordinary {
            self.insert_posting(key, note.dense);
        }
        for (prefix, (kind, value)) in scalars {
            self.insert_bsi(prefix, kind, &value, note.dense);
        }
        Ok(())
    }

    fn insert_posting(&mut self, mut key: Vec<u8>, dense: u32) {
        if matches!(key.first(), Some(&FIELD_SCALAR) | Some(&FIELD_LIST_ELEM)) {
            // Field keys are generated here, with a five-byte length prefix.
            let field_len = u32::from_be_bytes(key[1..5].try_into().expect("field key")) as usize;
            let (prefix, value) = key.split_at(5 + field_len);
            let marker = bucket_marker(prefix);
            if self.postings.contains_key(&marker) {
                key = bucket_key(prefix, value);
            } else if !self.postings.contains_key(&key) {
                let count = self.value_counts.entry(prefix.to_owned()).or_default();
                *count += 1;
                if *count > MAX_DIRECT_VALUES {
                    let prefix = prefix.to_owned();
                    let bucket = bucket_key(&prefix, value);
                    self.collapse_values(&prefix, marker);
                    key = bucket;
                }
            }
        }
        self.postings.entry(key).or_default().add(dense);
    }

    fn collapse_values(&mut self, prefix: &[u8], marker: Vec<u8>) {
        let direct: Vec<_> = self
            .postings
            .range(prefix.to_owned()..)
            .take_while(|(key, _)| key.starts_with(prefix))
            .map(|(key, _)| key.clone())
            .collect();
        self.value_counts.remove(prefix);
        self.postings.insert(marker, Bitmap::new());
        for key in direct {
            if let Some(removed) = self.postings.remove(&key) {
                self.postings
                    .entry(bucket_key(prefix, &key[prefix.len()..]))
                    .or_default()
                    .or_inplace(&removed);
            }
        }
    }

    fn insert_bsi(&mut self, prefix: Vec<u8>, kind: BsiKind, value: &ScalarValue, dense: u32) {
        let Some(bits) = BsiKind::key(value) else {
            return;
        };
        self.bsi
            .entry(bsi_entry(&prefix, BSI_EXISTS))
            .or_default()
            .add(dense);
        let mut set_bits = bits;
        while set_bits != 0 {
            let index = set_bits.trailing_zeros() as u8;
            set_bits &= set_bits - 1;
            self.bsi
                .entry(bsi_entry(&prefix, BSI_FIRST_PLANE + index))
                .or_default()
                .add(dense);
        }
        if kind == BsiKind::Number
            && let ScalarValue::Number(value) = value
            && let Some(integer) = exact_integer(value)
            && integer.unsigned_abs() > (1u128 << 53)
        {
            self.bsi
                .entry(bsi_entry(&prefix, BSI_LARGE_INTEGER))
                .or_default()
                .add(dense);
            self.exact_integers
                .entry(prefix)
                .or_default()
                .push((dense, integer));
        }
    }

    pub fn set_graph(&mut self, graph: GraphSections) {
        self.graph = graph;
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn publish(
        self,
        path: &Path,
        identity: IndexIdentity,
    ) -> Result<(BaseIndexHandle, TrustedCheckpoint), IndexError> {
        mmap::publish(self.prepare(identity)?, path, None, None)
    }

    pub(crate) fn prepare(
        mut self,
        identity: IndexIdentity,
    ) -> Result<mmap::PreparedCheckpoint, IndexError> {
        let sections = self.sections()?;
        let active_count = self
            .postings
            .get(&PostingKey::Active.encode())
            .map_or(0, Bitmap::cardinality)
            - self
                .postings
                .get(&PostingKey::Active.encode())
                .zip(self.postings.get(&PostingKey::TrashedSubtree.encode()))
                .map_or(0, |(active, trashed)| active.and_cardinality(trashed));
        let active_count =
            u32::try_from(active_count).map_err(|_| IndexError::InvalidInput("active slots"))?;
        mmap::prepare(
            identity,
            self.node_count,
            self.folder_count,
            active_count,
            sections,
        )
    }

    fn sections(&mut self) -> Result<Vec<WriteSection>, IndexError> {
        let node_count = self.node_count as usize;
        if self.graph.outgoing.len() > node_count
            || self.graph.incoming.len() > node_count
            || self.graph.clusters.len() > node_count
        {
            return Err(IndexError::InvalidInput("graph exceeds dense slots"));
        }
        let active = self
            .postings
            .get(&PostingKey::Active.encode())
            .cloned()
            .unwrap_or_default();
        let mut graph_nodes = active;
        if let Some(trashed) = self.postings.get(&PostingKey::TrashedSubtree.encode()) {
            graph_nodes.andnot_inplace(trashed);
        }
        if let Some(encrypted) = self.postings.get(&PostingKey::Encrypted.encode()) {
            graph_nodes.andnot_inplace(encrypted);
        }
        let mut dense_ids = BTreeSet::new();
        if self.notes.values().any(|(id, header)| {
            !dense_ids.insert(id) || !self.folders.contains_key(&header.parent_dense_folder_id)
        }) {
            return Err(IndexError::InvalidInput(
                "duplicate note identity or missing parent folder",
            ));
        }
        let mut folder_ids = BTreeSet::new();
        if self.folders.values().any(|(id, _)| !folder_ids.insert(id)) {
            return Err(IndexError::InvalidInput("duplicate folder identity"));
        }

        let notes = identity_tables(
            self.node_count,
            self.notes
                .iter()
                .map(|(&dense, (id, _))| (dense, id.as_str(), 0)),
        )?;
        let folders = identity_tables(
            self.folder_count,
            self.folders
                .iter()
                .map(|(&dense, (id, lifecycle))| (dense, id.as_str(), lifecycle_tag(*lifecycle))),
        )?;
        let mut headers = vec![
            0;
            node_count
                .checked_mul(NoteSortHeader::WIDTH)
                .ok_or(IndexError::InvalidInput("sort header size"))?
        ];
        let mut remainder = Vec::new();
        let mut header_bytes = Vec::with_capacity(NoteSortHeader::WIDTH);
        for (&dense, (_, header)) in &self.notes {
            let offset = dense as usize * NoteSortHeader::WIDTH;
            header_bytes.clear();
            header.encode(&mut header_bytes);
            headers[offset..offset + NoteSortHeader::WIDTH].copy_from_slice(&header_bytes);
            if header.ns_remainder() != 0 {
                remainder.extend(dense.to_le_bytes());
                remainder.extend(header.ns_remainder().to_le_bytes());
                remainder.extend(0u16.to_le_bytes());
            }
        }

        let (cluster_count, cluster_bytes) = clusters(
            self.node_count,
            &self.graph.clusters,
            &graph_nodes,
            &mut self.postings,
        )?;
        let (cat_count, catalog, arena) = bitmap_catalog(&self.postings)?;
        let (bsi_count, bsi_catalog, bsi_arena) = bitmap_catalog(&self.bsi)?;
        let mut exact = Vec::new();
        let mut exact_directory = Vec::new();
        for (key, integers) in &mut self.exact_integers {
            integers.sort_unstable_by_key(|(dense, _)| *dense);
            let offset = exact.len();
            for (dense, integer) in integers {
                exact.extend(dense.to_le_bytes());
                exact.extend(integer.to_le_bytes());
            }
            exact_directory.push((key.as_slice(), offset, exact.len() - offset));
        }
        let exact_directory_bytes = directory_bytes(&exact_directory)?;
        let exact_data_offset = exact_directory_bytes.len() as u64;
        let mut exact_bytes = exact_directory_bytes;
        exact_bytes.extend(exact);
        let outgoing = adjacency(self.node_count, &self.graph.outgoing, &graph_nodes)?;
        let incoming = adjacency(self.node_count, &self.graph.incoming, &graph_nodes)?;

        use SectionKind::*;
        Ok(vec![
            WriteSection::new(NoteIdentities, self.node_count, notes.ids, 0),
            WriteSection::new(NoteLookup, notes.lookup_count, notes.lookup, 0),
            WriteSection::new(FolderIdentities, self.folder_count, folders.ids, 0),
            WriteSection::new(FolderLookup, folders.lookup_count, folders.lookup, 0),
            WriteSection::new(SortHeaders, self.node_count, headers, 0),
            WriteSection::new(BitmapCatalog, cat_count, catalog, 0),
            WriteSection::new(BitmapArena, cat_count, arena, 0),
            WriteSection::new(BsiCatalog, bsi_count, bsi_catalog, 0),
            WriteSection::new(BsiPlanes, bsi_count, bsi_arena, 0),
            WriteSection::new(
                ExactIntegers,
                self.exact_integers.len() as u32,
                exact_bytes,
                exact_data_offset,
            ),
            WriteSection::new(GraphOutgoing, self.node_count, outgoing, 0),
            WriteSection::new(GraphIncoming, self.node_count, incoming, 0),
            WriteSection::new(Clusters, cluster_count, cluster_bytes, 0),
            WriteSection::new(
                TimestampRemainder,
                (remainder.len() / 8) as u32,
                remainder,
                0,
            ),
        ])
    }
}

pub(crate) const BSI_EXISTS: u8 = 0;
pub(crate) const BSI_FIRST_PLANE: u8 = 1;
pub(crate) const BSI_LARGE_INTEGER: u8 = 255;

pub(crate) fn bsi_entry(prefix: &[u8], role: u8) -> Vec<u8> {
    let mut key = Vec::with_capacity(prefix.len() + 1);
    key.extend(prefix);
    key.push(role);
    key
}

struct IdentityTables {
    ids: Vec<u8>,
    lookup_count: u32,
    lookup: Vec<u8>,
}

fn identity_tables<'a>(
    count: u32,
    entries: impl ExactSizeIterator<Item = (u32, &'a str, u8)>,
) -> Result<IdentityTables, IndexError> {
    let slots = (count as usize)
        .checked_mul(8)
        .ok_or(IndexError::InvalidInput("identity slots"))?;
    let mut ids = vec![0; slots];
    let lookup_count = entries
        .len()
        .checked_mul(2)
        .and_then(usize::checked_next_power_of_two)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(IndexError::InvalidInput("lookup slots"))?;
    let mut lookup = vec![(u32::MAX, 0u32); lookup_count as usize];
    let mask = lookup.len() - 1;
    for (dense, id, lifecycle) in entries {
        let index = dense as usize * 8;
        let start = u32::try_from(ids.len() - slots)
            .map_err(|_| IndexError::InvalidInput("identity arena"))?;
        let len =
            u16::try_from(id.len()).map_err(|_| IndexError::InvalidInput("identity spelling"))?;
        ids[index..index + 4].copy_from_slice(&start.to_le_bytes());
        ids[index + 4..index + 6].copy_from_slice(&len.to_le_bytes());
        ids[index + 6] = lifecycle;
        ids.extend(id.as_bytes());

        let mut slot = (dense, mmap::id_hash(id));
        let mut index = slot.1 as usize & mask;
        let mut distance = 0;
        loop {
            if lookup[index].0 == u32::MAX {
                lookup[index] = slot;
                break;
            }
            let occupant_distance = index.wrapping_sub(lookup[index].1 as usize & mask) & mask;
            if occupant_distance < distance {
                std::mem::swap(&mut lookup[index], &mut slot);
                distance = occupant_distance;
            }
            index = (index + 1) & mask;
            distance += 1;
        }
    }
    let mut lookup_bytes = Vec::with_capacity(lookup.len() * 8);
    for (dense, hash) in lookup {
        lookup_bytes.extend(hash.to_le_bytes());
        lookup_bytes.extend(dense.to_le_bytes());
    }
    Ok(IdentityTables {
        ids,
        lookup_count,
        lookup: lookup_bytes,
    })
}

fn adjacency(count: u32, lists: &[Vec<u32>], graph_nodes: &Bitmap) -> Result<Vec<u8>, IndexError> {
    let mut out = Vec::new();
    let mut edges = Vec::new();
    for node in 0..count {
        out.extend(
            u64::try_from(edges.len())
                .map_err(|_| IndexError::InvalidInput("graph edge count"))?
                .to_le_bytes(),
        );
        let Some(neighbors) = lists.get(node as usize) else {
            continue;
        };
        if !neighbors.is_empty() && !graph_nodes.contains(node) {
            return Err(IndexError::InvalidInput("graph contains hidden source"));
        }
        let mut sorted = neighbors.clone();
        sorted.sort_unstable();
        sorted.dedup();
        for target in sorted {
            if !graph_nodes.contains(target) {
                return Err(IndexError::InvalidInput("graph contains hidden target"));
            }
            edges.push(target);
        }
    }
    out.extend(
        u64::try_from(edges.len())
            .map_err(|_| IndexError::InvalidInput("graph edge count"))?
            .to_le_bytes(),
    );
    out.reserve(edges.len() * 4);
    for edge in edges {
        out.extend(edge.to_le_bytes());
    }
    Ok(out)
}

fn clusters(
    count: u32,
    assignments: &[Option<ClusterId>],
    graph_nodes: &Bitmap,
    postings: &mut BTreeMap<Vec<u8>, Bitmap>,
) -> Result<(u32, Vec<u8>), IndexError> {
    let mut ids = BTreeSet::new();
    for (index, id) in assignments.iter().enumerate() {
        if let Some(id) = id {
            if ClusterId::parse_v1(id.as_str()).is_err() || !graph_nodes.contains(index as u32) {
                return Err(IndexError::InvalidInput("invalid cluster assignment"));
            }
            ids.insert(id);
            postings
                .entry(PostingKey::ClusterMembers(id.clone()).encode())
                .or_default()
                .add(index as u32);
        }
    }
    let lookup: BTreeMap<_, _> = ids
        .iter()
        .enumerate()
        .map(|(slot, &id)| (id, slot as u32))
        .collect();
    let mut out = Vec::new();
    for node in 0..count {
        let cluster = assignments
            .get(node as usize)
            .and_then(Option::as_ref)
            .map_or(u32::MAX, |id| lookup[id]);
        out.extend(cluster.to_le_bytes());
    }
    for id in ids {
        let bytes = id
            .as_str()
            .strip_prefix(ClusterId::PREFIX)
            .expect("validated cluster id");
        let value =
            u128::from_str_radix(bytes, 16).map_err(|_| IndexError::InvalidInput("cluster id"))?;
        out.extend(value.to_be_bytes());
    }
    Ok((lookup.len() as u32, out))
}

fn bitmap_catalog(
    postings: &BTreeMap<Vec<u8>, Bitmap>,
) -> Result<(u32, Vec<u8>, Vec<u8>), IndexError> {
    let mut directory = Vec::new();
    let mut arena = Vec::new();
    let mut scratch = Vec::new();
    for (key, bitmap) in postings {
        let alignment = Frozen::REQUIRED_ALIGNMENT;
        let offset = arena.len().next_multiple_of(alignment);
        arena.resize(offset, 0);
        scratch.clear();
        let bytes = bitmap.serialize_into_vec::<Frozen>(&mut scratch);
        arena.extend_from_slice(bytes);
        directory.push((key.as_slice(), offset, bytes.len()));
    }
    let count =
        u32::try_from(directory.len()).map_err(|_| IndexError::InvalidInput("bitmap catalog"))?;
    Ok((count, directory_bytes(&directory)?, arena))
}

fn directory_bytes(entries: &[(&[u8], usize, usize)]) -> Result<Vec<u8>, IndexError> {
    let mut directory = Vec::new();
    let mut keys = Vec::new();
    for (key, offset, len) in entries {
        let key_len =
            u32::try_from(key.len()).map_err(|_| IndexError::InvalidInput("catalog key length"))?;
        let value_len =
            u32::try_from(*len).map_err(|_| IndexError::InvalidInput("catalog record length"))?;
        directory.extend((keys.len() as u64).to_le_bytes());
        directory.extend(key_len.to_le_bytes());
        directory.extend(value_len.to_le_bytes());
        directory.extend((*offset as u64).to_le_bytes());
        keys.extend_from_slice(key);
    }
    directory.extend(keys);
    Ok(directory)
}
