use super::{EmbeddingError, LocalTokenizerBudget, normalize};
use crate::{
    ports::ResolvedEmbeddingTarget,
    vector::{MAX_DIMENSION, MIN_DIMENSION},
};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use notarium_core::ports::CallBudget;
use notarium_syntax::chunk::TokenizerBudget;
use ort::{
    environment::Environment,
    ep,
    session::{RunOptions, Session},
    value::Tensor,
};
use std::{
    io::Read,
    num::NonZeroUsize,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const MODEL_BYTES: u64 = 1024 * 1024 * 1024;
const BUCKETS: [usize; 5] = [64, 128, 256, 384, 512];
static RUNTIME: Mutex<Option<(PathBuf, Environment)>> = Mutex::new(None);

#[derive(
    Clone, Copy, Debug, Default, Eq, Hash, PartialEq, serde::Serialize, serde::Deserialize,
)]
pub enum Pooling {
    #[default]
    Mean,
    Cls,
}

impl Pooling {
    pub(crate) fn is_mean(&self) -> bool {
        *self == Self::Mean
    }
}

struct TerminateOnDrop {
    options: Arc<RunOptions>,
    completed: bool,
}

impl Drop for TerminateOnDrop {
    fn drop(&mut self) {
        if !self.completed {
            let _ = self.options.terminate();
        }
    }
}

pub struct OrtModel {
    tokenizer: Arc<LocalTokenizerBudget>,
    session: Mutex<Session>,
    dimension: usize,
    pooling: Pooling,
    types: bool,
    output: String,
}

impl OrtModel {
    /// Open an installed profile containing an ONNX graph with inline weights
    /// and a tokenizer.json. External tensor data is intentionally unsupported.
    pub fn open(
        library: &Path,
        model_dir: &Path,
        target: &ResolvedEmbeddingTarget,
        pooling: Pooling,
    ) -> Result<Self, EmbeddingError> {
        let dimension = target.dimension as usize;
        if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&dimension) {
            return Err(EmbeddingError::InvalidModel);
        }
        let root = Dir::open_ambient_dir(model_dir, ambient_authority())?;
        let profile = root.open_dir_nofollow(target.model.as_str())?;
        let tokenizer = Arc::new(LocalTokenizerBudget::open_in(
            &profile,
            Path::new("tokenizer.json"),
            target.model.clone(),
            target.max_input_tokens,
        )?);
        let meta = profile.symlink_metadata("model.onnx")?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > MODEL_BYTES {
            return Err(EmbeddingError::InvalidModel);
        }
        let graph = profile.open_with(
            "model.onnx",
            OpenOptions::new().read(true).follow(FollowSymlinks::No),
        )?;
        let file_meta = graph.metadata()?;
        if !file_meta.is_file() || file_meta.len() == 0 || file_meta.len() > MODEL_BYTES {
            return Err(EmbeddingError::InvalidModel);
        }
        let capacity =
            usize::try_from(file_meta.len()).map_err(|_| EmbeddingError::InvalidModel)?;
        let mut bytes = Vec::with_capacity(capacity);
        graph.take(MODEL_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.is_empty() || bytes.len() as u64 > MODEL_BYTES {
            return Err(EmbeddingError::InvalidModel);
        }
        let environment = environment(library)?;
        let session = (|| {
            Session::builder(&environment)?
                .with_memory_pattern(false)?
                .with_intra_threads(intra_threads())?
                .with_inter_threads(1)?
                .commit_from_memory(&bytes)
        })()
        .map_err(|_| EmbeddingError::InvalidModel)?;
        drop(bytes);
        let input_names: Vec<_> = session.inputs().iter().map(|input| input.name()).collect();
        let types = input_names.contains(&"token_type_ids");
        if !input_names.contains(&"input_ids")
            || !input_names.contains(&"attention_mask")
            || input_names.len() != 2 + usize::from(types)
        {
            return Err(EmbeddingError::InvalidModel);
        }
        let output = ["sentence_embedding", "last_hidden_state"]
            .into_iter()
            .find(|name| {
                session
                    .outputs()
                    .iter()
                    .any(|output| output.name() == *name)
            })
            .or_else(|| match session.outputs() {
                [output] => Some(output.name()),
                _ => None,
            })
            .ok_or(EmbeddingError::InvalidModel)?
            .to_owned();
        Ok(Self {
            tokenizer,
            session: Mutex::new(session),
            dimension,
            pooling,
            types,
            output,
        })
    }

    pub fn tokenizer(&self) -> Arc<LocalTokenizerBudget> {
        self.tokenizer.clone()
    }

    pub async fn embed(
        self: Arc<Self>,
        texts: Vec<String>,
        budget: CallBudget,
    ) -> Result<Vec<Option<Vec<f32>>>, EmbeddingError> {
        if budget.cancellation.is_cancelled() {
            return Err(EmbeddingError::Cancelled);
        }
        let options = Arc::new(RunOptions::new().map_err(|_| EmbeddingError::ModelUnavailable)?);
        let mut guard = TerminateOnDrop {
            options: options.clone(),
            completed: false,
        };
        let mut worker = tokio::task::spawn_blocking({
            let options = options.clone();
            let cancellation = budget.cancellation.clone();
            move || self.run(texts, &options, &cancellation)
        });
        tokio::select! {
            biased;
            () = budget.cancellation.cancelled() => {
                let _ = options.terminate();
                // A native run is released between ONNX operators. Keep the
                // scheduler's slot until that run has actually stopped.
                let _ = worker.await;
                guard.completed = true;
                Err(EmbeddingError::Cancelled)
            }
            result = &mut worker => {
                guard.completed = true;
                result.map_err(|_| EmbeddingError::ModelUnavailable)?
            }
        }
    }

    fn run(
        &self,
        texts: Vec<String>,
        options: &RunOptions,
        cancellation: &notarium_core::ports::Cancellation,
    ) -> Result<Vec<Option<Vec<f32>>>, EmbeddingError> {
        let batch = texts.len();
        if !(1..=16).contains(&batch) {
            return Err(EmbeddingError::BudgetExceeded);
        }
        let mut encodings = Vec::with_capacity(batch);
        for text in texts {
            if cancellation.is_cancelled() {
                return Err(EmbeddingError::Cancelled);
            }
            let encoding = self.tokenizer.encode(&text)?;
            if encoding.ids.len() > self.tokenizer.max_tokens() as usize {
                return Err(EmbeddingError::BudgetExceeded);
            }
            encodings.push(encoding);
        }
        let lengths: Vec<_> = encodings
            .iter()
            .map(|encoding| encoding.ids.len())
            .collect();
        let longest = lengths.iter().copied().max().unwrap_or_default();
        let bucket = BUCKETS
            .into_iter()
            .find(|size| *size >= longest)
            .ok_or(EmbeddingError::BudgetExceeded)?;
        let mut ids = vec![self.tokenizer.pad_id(); batch * bucket];
        let mut types = self.types.then(|| vec![0; batch * bucket]);
        let mut masks = vec![0i64; batch * bucket];
        for (row, encoding) in encodings.into_iter().enumerate() {
            let span = row * bucket..row * bucket + lengths[row];
            ids[span.clone()].copy_from_slice(&encoding.ids);
            masks[span.clone()].fill(1);
            if let Some(types) = &mut types {
                types[span].copy_from_slice(&encoding.type_ids);
            }
        }
        let tensor = |values| {
            Tensor::from_array(([batch, bucket], values)).map_err(|_| EmbeddingError::InvalidModel)
        };
        let mut inputs =
            ort::inputs!["input_ids" => tensor(ids)?, "attention_mask" => tensor(masks)?];
        if let Some(types) = types {
            inputs.push(("token_type_ids".into(), tensor(types)?.into()));
        }
        let mut session = self
            .session
            .lock()
            .map_err(|_| EmbeddingError::ModelUnavailable)?;
        if cancellation.is_cancelled() {
            return Err(EmbeddingError::Cancelled);
        }
        let outputs = session
            .run_with_options(inputs, options)
            .map_err(|_| EmbeddingError::ModelUnavailable)?;
        let (shape, data) = outputs
            .get(&self.output)
            .ok_or(EmbeddingError::InvalidModel)?
            .try_extract_tensor::<f32>()
            .map_err(|_| EmbeddingError::InvalidModel)?;
        let width = self.dimension;
        match &**shape {
            [rows, dimension] if *rows == batch as i64 && *dimension == width as i64 => Ok(data
                .chunks_exact(width)
                .zip(lengths)
                .map(|(row, len)| (len != 0).then(|| normalize(row)).flatten())
                .collect()),
            [rows, tokens, dimension]
                if *rows == batch as i64
                    && *tokens == bucket as i64
                    && *dimension == width as i64 =>
            {
                Ok(data
                    .chunks_exact(width * bucket)
                    .zip(lengths)
                    .map(|(row, len)| {
                        if len == 0 {
                            return None;
                        }
                        match self.pooling {
                            Pooling::Cls => normalize(&row[..width]),
                            Pooling::Mean => {
                                let mut sum = vec![0.0f64; width];
                                for token in row.chunks_exact(width).take(len) {
                                    for (value, &component) in sum.iter_mut().zip(token) {
                                        *value += f64::from(component);
                                    }
                                }
                                let mean: Vec<_> = sum
                                    .into_iter()
                                    .map(|value| (value / len as f64) as f32)
                                    .collect();
                                normalize(&mean)
                            }
                        }
                    })
                    .collect())
            }
            _ => Err(EmbeddingError::InvalidModel),
        }
    }
}

fn environment(path: &Path) -> Result<Environment, EmbeddingError> {
    let leaf = std::fs::symlink_metadata(path)?;
    if !leaf.is_file() {
        return Err(EmbeddingError::InvalidModel);
    }
    let library = path.canonicalize()?;
    if !library.is_file() {
        return Err(EmbeddingError::InvalidModel);
    }
    let mut runtime = RUNTIME
        .lock()
        .map_err(|_| EmbeddingError::ModelUnavailable)?;
    if let Some((loaded_path, environment)) = &*runtime {
        return if *loaded_path == library {
            Ok(environment.clone())
        } else {
            Err(EmbeddingError::InvalidModel)
        };
    }
    let environment = ort::init_from(&library)
        .map_err(|_| EmbeddingError::ModelUnavailable)?
        .with_execution_providers([ep::CPU::default()
            .with_arena_allocator(false)
            .build()
            .error_on_failure()])
        .build()
        .map_err(|_| EmbeddingError::ModelUnavailable)?;
    *runtime = Some((library, environment.clone()));
    Ok(environment)
}

fn intra_threads() -> usize {
    let host = std::thread::available_parallelism()
        .map(NonZeroUsize::get)
        .unwrap_or(2);
    let cores = cgroup_cpu_quota().map_or(host, |quota| host.min(quota));
    (cores / 2).clamp(1, 4)
}

#[cfg(any(target_os = "linux", test))]
pub(super) fn parse_cpu_max(content: &str) -> Option<usize> {
    let mut parts = content.split_whitespace();
    let limit = parts.next()?;
    if limit == "max" {
        return None;
    }
    let limit: usize = limit.parse().ok()?;
    let period: usize = parts.next()?.parse().ok()?;
    if period == 0 {
        return None;
    }
    Some(limit.div_ceil(period).max(1))
}

#[cfg(target_os = "linux")]
fn cgroup_cpu_quota() -> Option<usize> {
    let root = Path::new("/sys/fs/cgroup");
    let mut minimum = None;
    let mut record = |path: &Path| {
        if let Ok(content) = std::fs::read_to_string(path.join("cpu.max"))
            && let Some(cores) = parse_cpu_max(&content)
        {
            minimum = Some(minimum.map_or(cores, |current: usize| current.min(cores)));
        }
    };
    if let Ok(proc_cgroup) = std::fs::read_to_string("/proc/self/cgroup")
        && let Some(relative) = proc_cgroup
            .lines()
            .find_map(|line| line.strip_prefix("0::"))
            .map(|entry| entry.trim().trim_start_matches('/'))
    {
        let mut current = root.to_path_buf();
        record(&current);
        for component in Path::new(relative).components() {
            if let std::path::Component::Normal(part) = component {
                current.push(part);
                record(&current);
            }
        }
    } else {
        record(root);
    }
    minimum
}

#[cfg(not(target_os = "linux"))]
fn cgroup_cpu_quota() -> Option<usize> {
    None
}
