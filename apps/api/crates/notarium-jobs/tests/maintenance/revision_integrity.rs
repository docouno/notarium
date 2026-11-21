use super::{change_note_metadata, repackage_database, stale_carrier};
use notarium_canonical::{
    backup::{PG_SLICE_MAX_BYTES, PostgresSpoolValue, scan_postgres_spool_v1},
    codec::{RevisionMetadataEnvelope, RevisionMetadataPayload},
};
use notarium_core::{error::ValidationReason, ids::FolderId};
use notarium_jobs::BackupOptions;
use std::{io::Cursor, path::Path};

pub(super) fn foreign_folder_owner(bytes: &[u8]) -> Vec<u8> {
    let mut envelope = RevisionMetadataEnvelope::decode(bytes).unwrap();
    let RevisionMetadataPayload::Folder(folder) = &mut envelope.payload else {
        panic!("expected a folder revision");
    };
    folder.folder_id = FolderId::from_bytes([0x91; 16]);
    envelope.encode().unwrap()
}

#[derive(Clone, Copy, Debug)]
pub(super) enum RevisionFault {
    NoteCarrier,
    MissingRoot,
    MalformedFolder,
    ForeignFolderOwner,
    FutureVisibility,
}

impl RevisionFault {
    pub(super) fn reason(self) -> ValidationReason {
        match self {
            Self::NoteCarrier => ValidationReason::InvalidDigest,
            _ => ValidationReason::InvalidArchive,
        }
    }

    pub(super) fn postgres_archive(self, path: &Path, note_metadata: &[u8]) -> Cursor<Vec<u8>> {
        use PostgresSpoolValue::{Bytes, Int, Text};
        repackage_database(path, "canonical", |spool| {
            let mut rows = revision_rows(spool);
            let original = encode_rows(&rows);
            // This space began at sequence zero, before any user command.
            let root = rows
                .iter()
                .position(|row| matches!(&row[3], Text(kind) if kind == "folder"))
                .unwrap();
            assert_eq!(rows[root][5..7], [Int(0), Int(0)]);
            match self {
                Self::NoteCarrier => {
                    let row = rows
                        .iter_mut()
                        .find(|row| matches!(&row[11], Bytes(value) if value == note_metadata))
                        .unwrap();
                    row[11] = Bytes(change_note_metadata(note_metadata, stale_carrier));
                }
                Self::MissingRoot => {
                    rows.remove(root);
                }
                Self::MalformedFolder => rows[root][11] = Bytes(vec![0xc1]),
                Self::ForeignFolderOwner => {
                    let Bytes(metadata) = &rows[root][11] else {
                        panic!("expected folder metadata")
                    };
                    rows[root][11] = Bytes(foreign_folder_owner(metadata));
                }
                Self::FutureVisibility => rows[root][6] = Int(i64::MAX),
            }
            let offset = spool
                .windows(original.len())
                .position(|bytes| bytes == original)
                .unwrap();
            spool.splice(offset..offset + original.len(), encode_rows(&rows));
            let body_len = spool.len() - 32;
            let (body, trailer) = spool.split_at_mut(body_len);
            trailer.copy_from_slice(blake3::hash(body).as_bytes());
            assert_eq!(revision_rows(spool), rows);
        })
    }
}

fn revision_rows(spool: &[u8]) -> Vec<Vec<PostgresSpoolValue>> {
    let mut rows = Vec::new();
    scan_postgres_spool_v1(
        spool,
        spool.len() as u64,
        spool.len() as u64,
        BackupOptions::default().max_pg_row_bytes,
        |table, row| {
            if table.name == "revisions" {
                rows.push(row.to_vec());
            }
            Ok(())
        },
    )
    .unwrap();
    rows
}

// Replace only the revisions table's framed rows and count. The production
// scanner verifies both the original byte representation and the modified spool.
fn encode_rows(rows: &[Vec<PostgresSpoolValue>]) -> Vec<u8> {
    let mut bytes = Vec::new();
    for row in rows {
        bytes.push(1);
        for value in row {
            bytes.push(u8::from(!matches!(value, PostgresSpoolValue::Null)));
            let data = match value {
                PostgresSpoolValue::Null => continue,
                PostgresSpoolValue::Int(number) => {
                    bytes.extend_from_slice(&number.to_be_bytes());
                    continue;
                }
                PostgresSpoolValue::Text(text) => text.as_bytes(),
                PostgresSpoolValue::Bytes(data) => data.as_slice(),
            };
            bytes.extend_from_slice(&(data.len() as u64).to_be_bytes());
            for chunk in data.chunks(PG_SLICE_MAX_BYTES) {
                bytes.extend_from_slice(&(chunk.len() as u32).to_be_bytes());
                bytes.extend_from_slice(chunk);
            }
        }
    }
    bytes.push(0);
    bytes.extend_from_slice(&(rows.len() as u64).to_be_bytes());
    bytes
}
