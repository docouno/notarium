//! Instrumentation for the executable storage acceptance workload.

use std::{
    num::NonZeroUsize,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{SpaceId, SpaceSeq},
    model::HistoryScope,
    ports::{Cancellation, CommandSeqRange},
};
use tokio::sync::oneshot;

use super::{ProjectionEngine, apply, checkpoint_error};
use crate::{
    index::IndexView,
    mmap::{BaseIndexHandle, MappedFastIndex, MmapPool},
};

#[derive(Default)]
pub(super) struct PauseSlot {
    armed: Mutex<Option<PauseRequest>>,
    failure: Mutex<Option<FailureInjection>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum PausePoint {
    BeforeSubscribe,
    BeforeRecovery,
    #[cfg(test)]
    BeforeRebindAdmission,
    BeforeCatchUp,
    BeforeApply,
    AfterAck,
    AfterReadPayload,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum FailurePoint {
    Ack,
    AfterPublish,
}

struct FailureInjection {
    point: FailurePoint,
    seq: SpaceSeq,
    error: PortError,
    attempted: oneshot::Sender<()>,
}

struct PauseRequest {
    point: PausePoint,
    minimum_events: u64,
    reached: oneshot::Sender<Option<CommandSeqRange>>,
    release: Cancellation,
    resumed: oneshot::Sender<()>,
}

#[must_use = "retaining this handle pauses the worker until it is dropped"]
pub struct ProjectionPause {
    reached: oneshot::Receiver<Option<CommandSeqRange>>,
    release: Cancellation,
    resumed: oneshot::Receiver<()>,
}

impl ProjectionPause {
    pub async fn reached(&mut self) -> Result<CommandSeqRange, PortError> {
        (&mut self.reached)
            .await
            .map_err(|_| not_ready())?
            .ok_or_else(not_ready)
    }

    #[doc(hidden)]
    pub async fn reached_feed_boundary_for_test(&mut self) -> Result<(), PortError> {
        match (&mut self.reached).await.map_err(|_| not_ready())? {
            None => Ok(()),
            Some(_) => Err(not_ready()),
        }
    }

    #[doc(hidden)]
    pub async fn resume_for_test(mut self) -> Result<(), PortError> {
        self.release.cancel();
        (&mut self.resumed).await.map_err(|_| not_ready())
    }
}

impl Drop for ProjectionPause {
    fn drop(&mut self) {
        self.release.cancel();
    }
}

impl PauseSlot {
    fn arm(&self, point: PausePoint, minimum_events: u64) -> Result<ProjectionPause, PortError> {
        let mut guard = self
            .armed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard
            .as_ref()
            .is_some_and(|pause| !pause.release.is_cancelled())
        {
            return Err(not_ready());
        }

        let (sender, reached) = oneshot::channel();
        let (resumed, receive_resume) = oneshot::channel();
        let release = Cancellation::default();
        *guard = Some(PauseRequest {
            point,
            minimum_events,
            reached: sender,
            release: release.clone(),
            resumed,
        });
        Ok(ProjectionPause {
            reached,
            release,
            resumed: receive_resume,
        })
    }

    pub(super) fn inject_failure(&self, point: FailurePoint, seq: SpaceSeq) -> Option<PortError> {
        let mut armed = self
            .failure
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if armed
            .as_ref()
            .is_some_and(|failure| failure.point == point && failure.seq == seq)
        {
            let injection = armed.take()?;
            let _ = injection.attempted.send(());
            return Some(injection.error);
        }
        None
    }

    pub(super) async fn pause_at(
        &self,
        point: PausePoint,
        command: Option<CommandSeqRange>,
        stop: &Cancellation,
    ) {
        let pause = {
            let mut guard = self
                .armed
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let events =
                command.map_or(0, |range| range.last_seq.get() - range.first_seq.get() + 1);
            if guard
                .as_ref()
                .is_some_and(|pause| pause.point == point && events >= pause.minimum_events)
            {
                guard.take()
            } else {
                None
            }
        };
        if let Some(pause) = pause
            && !pause.release.is_cancelled()
            && pause.reached.send(command).is_ok()
        {
            tokio::select! {
                _ = pause.release.cancelled() => {}
                _ = stop.cancelled(), if point != PausePoint::BeforeCatchUp => {}
            }
            let _ = pause.resumed.send(());
        }
    }
}

/// A file identity minted by the production checkpoint writer. Opening this
/// handle exercises the same validated map loader with an empty resident pool.
#[derive(Clone)]
pub struct BenchmarkCheckpoint(BaseIndexHandle);

pub struct BenchmarkMappedCheckpoint {
    _mapping: Arc<MappedFastIndex>,
}

impl BenchmarkCheckpoint {
    pub fn path(&self) -> &Path {
        self.0.path()
    }

    pub fn open_uncached(&self) -> Result<BenchmarkMappedCheckpoint, PortError> {
        let pool = MmapPool::new(NonZeroUsize::MIN);
        let mapping = self.0.open(&pool).map_err(checkpoint_error)?;
        Ok(BenchmarkMappedCheckpoint { _mapping: mapping })
    }
}

impl ProjectionEngine {
    /// Runs production recovery and opens the recovered publication for witnesses.
    #[doc(hidden)]
    pub async fn recover_tail_for_test(
        &self,
        scope: &HistoryScope,
    ) -> Result<(SpaceSeq, SpaceSeq, IndexView), PortError> {
        let generation = self.generation.load_full();
        let slot = generation.slot(&scope.space_id).ok_or_else(not_ready)?;
        let cut = apply::recover(
            self,
            &generation.store,
            scope,
            &slot,
            &Cancellation::default(),
        )
        .await?;
        Ok((
            cut.watermark.snapshot_seq,
            cut.cut.projected_seq,
            self.open_index(&cut)?,
        ))
    }

    #[doc(hidden)]
    pub fn pause_before_zero_feed_subscription_for_test(
        &self,
        space: &SpaceId,
    ) -> Result<ProjectionPause, PortError> {
        self.generation
            .load()
            .ensure_slot(space)
            .benchmark_pause
            .arm(PausePoint::BeforeSubscribe, 0)
    }

    #[doc(hidden)]
    pub fn pause_before_recovery_for_test(
        &self,
        scope: &HistoryScope,
    ) -> Result<ProjectionPause, PortError> {
        self.generation
            .load()
            .ensure_slot(&scope.space_id)
            .benchmark_pause
            .arm(PausePoint::BeforeRecovery, 0)
    }

    #[cfg(test)]
    pub(super) fn pause_before_rebind_admission_for_test(
        &self,
        scope: &HistoryScope,
    ) -> Result<ProjectionPause, PortError> {
        self.pause_projection_at(scope, PausePoint::BeforeRebindAdmission, 0)
    }

    #[cfg(test)]
    pub(super) fn pause_before_catch_up_for_test(
        &self,
        scope: &HistoryScope,
    ) -> Result<ProjectionPause, PortError> {
        self.pause_projection_at(scope, PausePoint::BeforeCatchUp, 0)
    }

    #[doc(hidden)]
    pub fn pause_before_projection_for_test(
        &self,
        scope: &HistoryScope,
        minimum_events: u64,
    ) -> Result<ProjectionPause, PortError> {
        self.pause_projection_at(scope, PausePoint::BeforeApply, minimum_events)
    }

    #[doc(hidden)]
    pub fn pause_after_projection_ack_for_test(
        &self,
        scope: &HistoryScope,
    ) -> Result<ProjectionPause, PortError> {
        self.pause_projection_at(scope, PausePoint::AfterAck, 1)
    }

    #[doc(hidden)]
    pub fn pause_after_read_payload_for_test(
        &self,
        scope: &HistoryScope,
    ) -> Result<ProjectionPause, PortError> {
        self.pause_projection_at(scope, PausePoint::AfterReadPayload, 0)
    }

    #[doc(hidden)]
    pub fn fail_projection_ack_for_test(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
    ) -> Result<oneshot::Receiver<()>, PortError> {
        self.arm_projection_failure(
            scope,
            seq,
            FailurePoint::Ack,
            notarium_canonical::codec::deadline_not_committed(
                "projection_test_ack",
                "injected command acknowledgement timeout",
            ),
        )
    }

    #[doc(hidden)]
    pub fn fail_projection_ack_with_internal_for_test(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
    ) -> Result<oneshot::Receiver<()>, PortError> {
        self.arm_projection_failure(
            scope,
            seq,
            FailurePoint::Ack,
            notarium_canonical::codec::internal_not_committed(
                "projection_test_ack_connection",
                "injected command acknowledgement connection error",
            ),
        )
    }

    #[doc(hidden)]
    pub fn fail_projection_after_publish_for_test(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
    ) -> Result<oneshot::Receiver<()>, PortError> {
        self.arm_projection_failure(
            scope,
            seq,
            FailurePoint::AfterPublish,
            notarium_canonical::codec::internal_not_committed(
                "projection_test_after_publish",
                "injected connection error after durable publication",
            ),
        )
    }

    fn arm_projection_failure(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
        point: FailurePoint,
        error: PortError,
    ) -> Result<oneshot::Receiver<()>, PortError> {
        let generation = self.generation.load();
        let slot = generation.slot(&scope.space_id).ok_or_else(not_ready)?;
        let cut = slot.admitted_cut().ok_or_else(not_ready)?;
        scope.check(&cut.cut.scope)?;
        if seq <= cut.cut.projected_seq {
            return Err(not_ready());
        }
        let mut armed = slot
            .benchmark_pause
            .failure
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if armed.is_some() {
            return Err(not_ready());
        }
        let (attempted, observed) = oneshot::channel();
        *armed = Some(FailureInjection {
            point,
            seq,
            error,
            attempted,
        });
        Ok(observed)
    }

    fn pause_projection_at(
        &self,
        scope: &HistoryScope,
        point: PausePoint,
        minimum_events: u64,
    ) -> Result<ProjectionPause, PortError> {
        let generation = self.generation.load();
        let slot = generation.slot(&scope.space_id).ok_or_else(not_ready)?;
        let cut = slot.cut.load_full().ok_or_else(not_ready)?;
        scope.check(&cut.cut.scope)?;
        slot.benchmark_pause.arm(point, minimum_events)
    }

    #[doc(hidden)]
    pub async fn checkpoint_for_test(
        &self,
        scope: &HistoryScope,
        seq: SpaceSeq,
    ) -> Result<BenchmarkCheckpoint, PortError> {
        let generation = self.generation.load();
        let slot = generation.slot(&scope.space_id).ok_or_else(not_ready)?;
        let mut progress = slot.progress.subscribe();
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                let cut = slot.cut.load_full().ok_or_else(not_ready)?;
                scope.check(&cut.cut.scope)?;
                if cut.watermark.snapshot_seq >= seq {
                    return Ok(BenchmarkCheckpoint(cut.base.clone()));
                }
                if cut.cut.projected_seq >= seq {
                    slot.checkpoint.notify_one();
                }
                progress.changed().await.map_err(|_| not_ready())?;
            }
        })
        .await
        .map_err(|_| not_ready())?
    }

    #[doc(hidden)]
    pub fn evict_projection_for_test(&self, scope: &HistoryScope) -> Result<(), PortError> {
        let cut = self.published_cut(scope)?;
        self.reads.invalidate_history(scope);
        self.pool.evict(&cut.base);
        if self.pool.live_mmap_count() != 0 {
            return Err(not_ready());
        }
        Ok(())
    }
}

fn not_ready() -> PortError {
    DomainError::validation(ValidationReason::NotReady).into()
}
