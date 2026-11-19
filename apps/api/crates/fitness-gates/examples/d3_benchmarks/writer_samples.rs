//! The writer measures latency by admission and throughput by completion within the window.

pub(super) struct WriterEditSamples {
    pub successful_ns: Vec<u64>,
    pub failed_ns: Vec<u64>,
    pub completed_digests: Vec<[u8; 32]>,
}

impl WriterEditSamples {
    pub fn new(capacity: usize) -> Self {
        Self {
            successful_ns: Vec::with_capacity(capacity),
            failed_ns: Vec::new(),
            completed_digests: Vec::with_capacity(capacity),
        }
    }

    pub fn record(&mut self, start: u64, finish: u64, elapsed_ns: u64, digest: Option<[u8; 32]>) {
        if start != 1 {
            return;
        }
        if let Some(digest) = digest {
            self.successful_ns.push(elapsed_ns);
            if finish == 1 {
                self.completed_digests.push(digest);
            }
        } else {
            self.failed_ns.push(elapsed_ns);
        }
    }
}
