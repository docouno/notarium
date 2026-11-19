use notarium_core::epoch::DataRoot;
use std::{path::PathBuf, time::Duration};

#[derive(Clone, Debug)]
pub enum VectorMode {
    Disabled,
    DynamicOrt {
        dylib_path: PathBuf,
        model_dir: PathBuf,
    },
    RemoteOnly,
    DeterministicTest {
        dimension: u32,
    },
}

#[derive(Clone, Debug)]
pub struct SearchConfig {
    pub data_root: DataRoot,
    pub vector_mode: VectorMode,
    pub query_embedding_budget: Duration,
    pub causal_wait_budget: Duration,
}

impl SearchConfig {
    pub fn new(data_root: DataRoot, vector_mode: VectorMode) -> Self {
        Self {
            data_root,
            vector_mode,
            query_embedding_budget: Duration::from_millis(150),
            causal_wait_budget: Duration::from_millis(15),
        }
    }
}
