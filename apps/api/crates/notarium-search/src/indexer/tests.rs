use super::*;
use crate::{
    ports::{EmbeddingBackendTarget, ResolvedEmbeddingTarget},
    vector::{ChunkMetadata, MutableOperation, QuantizedVector, SegmentBuilder, VectorChunk},
};
use notarium_core::{
    classes::DocClass,
    epoch::DataRoot,
    ids::{ContentDigest, HistoryIncarnation, ModelProfileId, NoteId, SpaceId},
    span::ByteSpan,
};

#[tokio::test]
async fn idle_space_releases_vectors_and_reopens_its_checkpointed_wal() {
    let mut entropy = [0; 16];
    getrandom::fill(&mut entropy).unwrap();
    let path = std::env::temp_dir().join(format!("search-idle-{}", hex::encode(entropy)));
    std::fs::create_dir(&path).unwrap();
    let root = DataRoot::new(&path);
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&root, scope.clone()).unwrap());
    let profile = ModelProfileId::from_bytes([2; 16]);
    let mut epoch = VectorEpoch::open(layout.clone(), profile.clone(), 64).unwrap();
    let seed = SpaceSeq::new(1).unwrap();
    let current = SpaceSeq::new(2).unwrap();
    epoch
        .seed(SegmentBuilder::new(&profile, 64).unwrap(), seed)
        .unwrap();
    let note = NoteId::from_bytes([3; 16]);
    let key = ContentDigest::from_bytes([4; 32]);
    let vector = QuantizedVector::quantize(&[1.0; 64]).unwrap();
    epoch
        .apply(
            current,
            MutableOperation::Upsert {
                note: note.clone(),
                chunks: vec![VectorChunk {
                    metadata: ChunkMetadata {
                        note,
                        key,
                        source: ContentDigest::from_bytes([5; 32]),
                        folder: 1,
                        class: DocClass::UserDoc,
                        context: vec![],
                        spans: vec![ByteSpan::new(0, 1).unwrap()],
                        tokens: 1,
                    },
                    vector: vector.clone(),
                }],
            },
        )
        .unwrap();
    epoch.checkpoint(current).unwrap();
    let idle_since = Instant::now();
    let mut disk = Disk {
        layout,
        manifest: SearchManifest {
            scope,
            tantivy_seq: current,
            tantivy_commit: 1,
            active_index_dir: crate::layout::index_name(1),
            tokenizer_version: TOKENIZER_VERSION,
            active_model: Some(ResolvedEmbeddingTarget {
                model: profile,
                dimension: 64,
                max_input_tokens: 512,
                backend: EmbeddingBackendTarget::LocalOnnx,
            }),
            vector_seq: Some(current),
            embeddings_pending: false,
        },
        folders: Arc::new(FolderDictionary::default()),
        lexical: None,
        epoch: Some(epoch),
        embedder: None,
        embedding_failures: 0,
        vector_last_use: idle_since,
    };
    disk.release_idle_vectors(idle_since);
    assert!(disk.epoch.is_some());
    disk.release_idle_vectors(idle_since + VECTOR_IDLE);
    assert!(disk.epoch.is_none());
    disk.resume_vectors().await.unwrap();
    let reopened = disk.epoch.as_ref().unwrap();
    assert!(reopened.is_checkpointed(current));
    assert_eq!(reopened.find_vector(key), Some(vector));
    drop(disk);
    std::fs::remove_dir_all(path).unwrap();
}
