mod onnx_support;

use notarium_core::{
    ids::{ModelProfileId, RequestId},
    ports::{CallBudget, Cancellation},
};
use notarium_search::{
    embed::{EmbeddingError, EmbeddingScheduler, OrtModel, Pooling, Priority},
    ports::{EmbeddingBackendTarget, ResolvedEmbeddingTarget},
};
use onnx_support::{ModelFiles, library};
use ort::{
    ep,
    session::{RunOptions, Session},
    value::Tensor,
};
use std::{fs, sync::Arc, time::Duration};

// ONNX IR 10, opset 13. Input and output are float tensors of shape [rows, 2].
// The graph has two nodes, Add(input, input) followed by Relu.
const MODEL_HEX: &str = concat!(
    "080a3a87010a1c0a05696e7075740a05696e7075741207646f75626c65642203",
    "4164640a170a07646f75626c656412066f7574707574220452656c7512136479",
    "6e616d69635f6370755f666978747572655a1b0a05696e70757412120a100801",
    "120c0a061204726f77730a020802621c0a066f757470757412120a100801120c",
    "0a061204726f77730a0208024202100d",
);

#[test]
fn loads_the_pinned_cpu_runtime_offline() {
    // ort owns one environment per process. Exercise the raw initializer in a
    // separate process from the adapter, which initializes its own environment.
    const SMOKE_CHILD: &str = "NOTARIUM_ONNX_SMOKE_CHILD";
    if std::env::var_os(SMOKE_CHILD).is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "loads_the_pinned_cpu_runtime_offline",
                "--nocapture",
            ])
            .env(SMOKE_CHILD, "1")
            .status()
            .expect("start isolated ONNX smoke test");
        assert!(status.success(), "isolated ONNX smoke test failed");
        return;
    }

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
    let root = ModelFiles::new();
    let model = ModelProfileId::from_bytes([4; 16]);
    root.install(&model, false);
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

    // Exercise a full 16-row heterogeneous batch with mixed lengths and empty rows.
    let model = Arc::new(OrtModel::open(&library(), &root.0, &target, Pooling::Mean).unwrap());
    let mixed_batch: Vec<String> = (0..16)
        .map(|idx| match idx % 4 {
            0 => "red".to_owned(),
            1 => "blue".to_owned(),
            2 => "red blue".to_owned(),
            _ => "   ".to_owned(),
        })
        .collect();
    let mixed_rows = scheduler
        .submit(
            Priority::LiveNoteEdit,
            call_budget(Duration::from_secs(5)),
            {
                let model = model.clone();
                move |budget| model.embed(mixed_batch, budget)
            },
        )
        .await
        .unwrap();
    assert_eq!(mixed_rows.len(), 16);
    let diag = 1.0f32 / 2.0f32.sqrt();
    for (idx, row) in mixed_rows.iter().enumerate() {
        match idx % 4 {
            0 => assert!((row.as_ref().unwrap()[1] - 1.0).abs() < 1e-6),
            1 => assert!((row.as_ref().unwrap()[2] - 1.0).abs() < 1e-6),
            2 => {
                let vec = row.as_ref().unwrap();
                assert!((vec[1] - diag).abs() < 1e-6);
                assert!((vec[2] - diag).abs() < 1e-6);
            }
            _ => assert!(row.is_none()),
        }
    }

    // Exercise the optional token_type_ids input path.
    let type_ids_target = ResolvedEmbeddingTarget {
        model: ModelProfileId::from_bytes([5; 16]),
        dimension: 64,
        max_input_tokens: 512,
        backend: EmbeddingBackendTarget::LocalOnnx,
    };
    root.install_with_type_ids(&type_ids_target.model);
    let type_ids_model =
        Arc::new(OrtModel::open(&library(), &root.0, &type_ids_target, Pooling::Mean).unwrap());
    let type_rows = type_ids_model
        .embed(
            vec!["red blue".to_owned(), "blue".to_owned(), " ".to_owned()],
            call_budget(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    assert_eq!(type_rows.len(), 3);
    assert!((type_rows[0].as_ref().unwrap()[1] - diag).abs() < 1e-6);
    assert!((type_rows[0].as_ref().unwrap()[2] - diag).abs() < 1e-6);
    assert!((type_rows[1].as_ref().unwrap()[2] - 1.0).abs() < 1e-6);
    assert!(type_rows[2].is_none());

    // Exercise direct 2D sentence_embedding output without token-level pooling.
    let pooled_target = ResolvedEmbeddingTarget {
        model: ModelProfileId::from_bytes([6; 16]),
        dimension: 64,
        max_input_tokens: 512,
        backend: EmbeddingBackendTarget::LocalOnnx,
    };
    root.install_pooled_2d(&pooled_target.model);
    let pooled_model =
        Arc::new(OrtModel::open(&library(), &root.0, &pooled_target, Pooling::Cls).unwrap());
    let pooled_rows = pooled_model
        .embed(
            vec!["red blue".to_owned(), "blue".to_owned(), " ".to_owned()],
            call_budget(Duration::from_secs(5)),
        )
        .await
        .unwrap();
    assert_eq!(pooled_rows.len(), 3);
    assert!((pooled_rows[0].as_ref().unwrap()[1] - diag).abs() < 1e-6);
    assert!((pooled_rows[0].as_ref().unwrap()[2] - diag).abs() < 1e-6);
    assert!((pooled_rows[1].as_ref().unwrap()[2] - 1.0).abs() < 1e-6);
    assert!(pooled_rows[2].is_none());

    #[cfg(target_os = "linux")]
    let mut resident = Vec::new();
    for batch in 0..200 {
        let length = [12, 64, 65, 128, 129, 256, 257, 384, 385, 512][batch % 10];
        let texts = vec!["red ".repeat(length); batch % 16 + 1];
        let model = model.clone();
        let rows = scheduler
            .submit(
                Priority::BulkImportBackfill,
                call_budget(Duration::from_secs(5)),
                move |budget| model.embed(texts, budget),
            )
            .await
            .unwrap();
        assert!(
            rows.iter()
                .all(|row| row.as_ref().is_some_and(|values| values[1] == 1.0))
        );
        #[cfg(target_os = "linux")]
        if batch % 10 == 9 {
            resident.push(anonymous_kib());
        }
    }
    #[cfg(target_os = "linux")]
    {
        let first = resident[3..10].iter().max().unwrap();
        let last = resident[13..20].iter().max().unwrap();
        assert!(
            *last <= first + 16 * 1024,
            "anonymous RSS grew from max {first} to max {last} KiB"
        );
    }

    drop(model);
    let cond_target = ResolvedEmbeddingTarget {
        model: ModelProfileId::from_bytes([7; 16]),
        dimension: 64,
        max_input_tokens: 512,
        backend: EmbeddingBackendTarget::LocalOnnx,
    };
    root.install_conditional_slow(&cond_target.model);
    let cond_model =
        Arc::new(OrtModel::open(&library(), &root.0, &cond_target, Pooling::Mean).unwrap());
    // Dropping OrtModel::embed directly (without cancelling CallBudget) must
    // terminate the native ONNX run and leave the session healthy for reuse.
    let dropped = tokio::time::timeout(
        Duration::from_millis(120),
        cond_model
            .clone()
            .embed(vec!["red".to_owned()], call_budget(Duration::from_secs(10))),
    )
    .await;
    assert!(dropped.is_err());
    let recovered = tokio::time::timeout(
        Duration::from_secs(3),
        cond_model
            .clone()
            .embed(vec!["blue".to_owned()], call_budget(Duration::from_secs(3))),
    )
    .await
    .expect("dropped native run must terminate promptly and release session")
    .expect("session must remain usable after drop termination");
    assert_eq!(recovered.len(), 1);
    assert!((recovered[0].as_ref().unwrap()[2] - 1.0).abs() < 1e-6);

    // Scheduler deadline expiry must also terminate the native run cleanly and
    // allow subsequent inference on the same session to succeed.
    let expired = scheduler
        .submit(
            Priority::InteractiveSearchQuery,
            call_budget(Duration::from_millis(150)),
            {
                let cond_model = cond_model.clone();
                move |budget| cond_model.embed(vec!["red".to_owned()], budget)
            },
        )
        .await;
    assert!(matches!(expired, Err(EmbeddingError::BudgetExceeded)));
    let after_timeout = scheduler
        .submit(
            Priority::LiveNoteEdit,
            call_budget(Duration::from_secs(3)),
            move |budget| cond_model.embed(vec!["blue".to_owned()], budget),
        )
        .await
        .expect("subsequent embed after RunOptions::terminate must succeed");
    assert_eq!(after_timeout.len(), 1);
    assert!((after_timeout[0].as_ref().unwrap()[2] - 1.0).abs() < 1e-6);
    scheduler.shutdown();
    worker.await.unwrap();
}

fn call_budget(remaining: Duration) -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes([7; 16]),
        cancellation: Cancellation::default(),
        remaining,
    }
}

#[cfg(target_os = "linux")]
fn anonymous_kib() -> u64 {
    fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("RssAnon:"))
        .and_then(|line| line.split_whitespace().next())
        .unwrap()
        .parse()
        .unwrap()
}
