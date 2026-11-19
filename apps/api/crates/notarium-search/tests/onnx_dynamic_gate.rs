use ort::{
    ep,
    session::{RunOptions, Session},
    value::Tensor,
};
use std::{path::Path, sync::Arc};

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
    let library = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../.artifacts/onnxruntime/current/libonnxruntime.so");
    let library = library
        .canonicalize()
        .expect("run make setup to prepare the pinned ONNX Runtime fixture");
    let environment = ort::init_from(library)
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
