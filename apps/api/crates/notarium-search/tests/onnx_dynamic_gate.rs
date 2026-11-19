use notarium_core::{
    ids::{ModelProfileId, RequestId},
    ports::{CallBudget, Cancellation},
};
use notarium_search::{
    embed::{EmbeddingScheduler, OrtModel, Pooling, Priority},
    ports::{EmbeddingBackendTarget, ResolvedEmbeddingTarget},
};
use ort::{
    ep,
    session::{RunOptions, Session},
    value::Tensor,
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

// ONNX IR 10, opset 13. Input and output are float tensors of shape [rows, 2].
// The graph has two nodes, Add(input, input) followed by Relu.
const MODEL_HEX: &str = concat!(
    "080a3a87010a1c0a05696e7075740a05696e7075741207646f75626c65642203",
    "4164640a170a07646f75626c656412066f7574707574220452656c7512136479",
    "6e616d69635f6370755f666978747572655a1b0a05696e70757412120a100801",
    "120c0a061204726f77730a020802621c0a066f757470757412120a100801120c",
    "0a061204726f77730a0208024202100d",
);

// ONNX IR 10, opset 13. OneHot(input_ids, 64, [0, 1]) followed by
// Identity gives distinct basis vectors so padding and pooling are observable.
const EMBEDDING_MODEL: &str = concat!(
    "080a3a9d020a2c0a09696e7075745f6964730a0564657074680a0676616c756573120865",
    "7870616e64656422064f6e65486f740a270a08657870616e64656412116c6173745f6869",
    "6464656e5f737461746522084964656e746974791211656d62656464696e675f66697874",
    "7572652a131007420564657074684a0840000000000000002a1608021001420676616c75",
    "65734a08000000000000803f5a250a09696e7075745f69647312180a16080712120a0612",
    "04726f77730a081206746f6b656e735a2a0a0e617474656e74696f6e5f6d61736b12180a",
    "16080712120a061204726f77730a081206746f6b656e7362310a116c6173745f68696464",
    "656e5f7374617465121c0a1a080112160a061204726f77730a081206746f6b656e730a02",
    "08404202100d",
);

fn library() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../.artifacts/onnxruntime/current/libonnxruntime.so")
        .canonicalize()
        .expect("run make setup to prepare the pinned ONNX Runtime fixture")
}

#[test]
fn loads_the_pinned_cpu_runtime_offline() {
    let environment = ort::init_from(library())
        .expect("load ONNX Runtime with C API 31")
        .with_execution_providers([ep::CPU::default()
            .with_arena_allocator(false)
            .build()
            .error_on_failure()])
        .build()
        .expect("create ONNX Runtime environment");
    let model = hex::decode(MODEL_HEX).expect("decode ONNX fixture");
    let mut session = Session::builder(&environment)
        .expect("create ONNX session options")
        .with_memory_pattern(false)
        .expect("disable memory pattern caching")
        .with_intra_threads(1)
        .expect("bound fixture CPU inference")
        .commit_from_memory(&model)
        .expect("create dynamic CPU session");
    let input = || Tensor::from_array(([2, 2], vec![-1.0_f32, 1.0, 2.0, -3.0])).unwrap();
    let run = Arc::new(RunOptions::new().unwrap());
    {
        let outputs = session
            .run_with_options(ort::inputs![input()], &run)
            .unwrap();
        let (shape, values) = outputs["output"].try_extract_tensor::<f32>().unwrap();
        assert_eq!(&**shape, &[2, 2]);
        assert_eq!(values, &[0.0, 2.0, 4.0, 0.0]);
    }
    run.terminate().expect("terminate the selected run");
    assert!(
        session
            .run_with_options(ort::inputs![input()], &run)
            .is_err()
    );
}

#[tokio::test]
async fn production_adapter_pools_real_dynamic_onnx_rows() {
    struct ModelDir(PathBuf);
    impl Drop for ModelDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let mut entropy = [0; 16];
    getrandom::fill(&mut entropy).unwrap();
    let root =
        ModelDir(std::env::temp_dir().join(format!("notarium-onnx-{}", hex::encode(entropy))));
    let model = ModelProfileId::from_bytes([4; 16]);
    let profile = root.0.join(model.as_str());
    fs::create_dir_all(&profile).unwrap();
    fs::write(
        profile.join("model.onnx"),
        hex::decode(EMBEDDING_MODEL).unwrap(),
    )
    .unwrap();
    fs::write(
        profile.join("tokenizer.json"),
        r###"{
        "pre_tokenizer":{"type":"WhitespaceSplit"},
        "model":{"type":"WordPiece","vocab":{"[UNK]":0,"red":1,"blue":2,"[PAD]":3},
        "unk_token":"[UNK]","continuing_subword_prefix":"##","max_input_chars_per_word":100}
    }"###,
    )
    .unwrap();
    let target = ResolvedEmbeddingTarget {
        model,
        dimension: 64,
        max_input_tokens: 512,
        backend: EmbeddingBackendTarget::LocalOnnx,
    };
    let (scheduler, worker) = EmbeddingScheduler::start();
    for (pooling, expected) in [(Pooling::Mean, 1.0f32 / 2.0f32.sqrt()), (Pooling::Cls, 1.0)] {
        let model = Arc::new(OrtModel::open(&library(), &root.0, &target, pooling).unwrap());
        let rows = scheduler
            .submit(
                Priority::LiveNoteEdit,
                CallBudget {
                    request: RequestId::from_bytes([7; 16]),
                    cancellation: Cancellation::default(),
                    remaining: Duration::from_secs(5),
                },
                move |budget| {
                    model.embed(
                        vec!["red blue".to_owned(), "blue".to_owned(), " ".to_owned()],
                        budget,
                    )
                },
            )
            .await
            .unwrap();
        assert_eq!(rows.len(), 3);
        let mixture = rows[0].as_ref().unwrap();
        assert_eq!(mixture.len(), 64);
        assert!((mixture[1] - expected).abs() < 1e-6);
        let blue = if matches!(pooling, Pooling::Mean) {
            expected
        } else {
            0.0
        };
        assert!((mixture[2] - blue).abs() < 1e-6);
        assert_eq!(mixture[3], 0.0);
        assert_eq!(rows[1].as_ref().unwrap()[2], 1.0);
        assert!(rows[2].is_none());
    }
    scheduler.shutdown();
    worker.await.unwrap();
}
