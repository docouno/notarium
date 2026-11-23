//! Bounded byte-offset replay for a supervised run.
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, MutexGuard},
};

use notarium_core::{
    DomainError, DomainResult,
    error::ValidationReason,
    ids::{AgentRunId, ChatThreadId, CommandKey, ContentDigest, ThreadEntrySeq},
    ports::{ChatEntry, ChatEntryKind, ProviderToolCall},
};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

pub const STREAM_WINDOW_BYTES: usize = 64 * 1024;
pub const STREAM_FRAME_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamCursor {
    pub run: AgentRunId,
    pub byte_offset: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamCheckpoint {
    pub cursor: StreamCursor,
    pub committed_leaf: ThreadEntrySeq,
    /// The client discards transient deltas for this partially observed step.
    /// Its eventual Committed event points at the complete canonical entry.
    pub incomplete_step: Option<u32>,
    pub terminal: Option<RunTerminal>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RunTerminal {
    Finished,
    Failed { code: RunFailure },
}

/// Safe errors for a shared audience and resumed streams.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunFailure {
    Cancelled,
    DeadlineExceeded,
    AuthorityRevoked,
    HistoryUnavailable,
    ProviderUnavailable,
    ContentFiltered,
    BudgetExceeded,
    Internal,
}

/// The payload of an encoded frame. Only the producer methods below emit
/// events. In particular, model arguments enter after provider validation.
#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentRunEvent<'a> {
    TextDelta {
        step: u32,
        text: &'a str,
    },
    ToolCallStart {
        step: u32,
        call_id: &'a CommandKey,
        name: &'a str,
    },
    ToolCallDelta {
        step: u32,
        call_id: &'a CommandKey,
        index: u32,
        fragment: &'a str,
        last: bool,
    },
    ToolCallResult {
        step: u32,
        call_id: &'a CommandKey,
        entry_seq: ThreadEntrySeq,
        preview: &'a str,
        preview_truncated: bool,
    },
    TaintApprovalNeeded {
        step: u32,
        call_id: &'a CommandKey,
        entry_seq: ThreadEntrySeq,
        proposal: ContentDigest,
    },
    Committed {
        entry_seq: ThreadEntrySeq,
        step: Option<u32>,
        transient_start: Option<u64>,
        transient_end: Option<u64>,
    },
    RunFinished,
    RunFailed {
        code: RunFailure,
    },
}

#[derive(Serialize)]
struct Envelope<'a> {
    run: &'a AgentRunId,
    #[serde(flatten)]
    event: AgentRunEvent<'a>,
}

#[derive(Clone)]
pub struct StreamFrame {
    pub start_offset: u64,
    pub end_offset: u64,
    payload: Arc<[u8]>,
}

impl StreamFrame {
    /// Complete UTF-8 JSON, before any SSE framing. Event-ID is end_offset.
    pub fn payload(&self) -> &[u8] {
        &self.payload
    }
}

pub enum StreamRead {
    Frame(StreamFrame),
    CatchUpRequired(StreamCheckpoint),
    Closed,
}

#[derive(Clone, Copy)]
struct TransientStep {
    step: u32,
    start: u64,
}

struct State {
    frames: VecDeque<StreamFrame>,
    retained: usize,
    end: u64,
    committed_leaf: ThreadEntrySeq,
    transient: Option<TransientStep>,
    last_step: Option<u32>,
    terminal: Option<RunTerminal>,
    redaction_pending: bool,
    visibility_floor: u64,
}

impl State {
    fn checkpoint(&self, run: &AgentRunId) -> StreamCheckpoint {
        StreamCheckpoint {
            cursor: StreamCursor {
                run: run.clone(),
                byte_offset: self.end,
            },
            committed_leaf: self.committed_leaf,
            incomplete_step: self
                .transient
                .filter(|transient| transient.start < self.end)
                .map(|transient| transient.step),
            terminal: self.terminal,
        }
    }

    fn valid_boundary(&self, offset: u64) -> bool {
        offset == self.end || self.frames.iter().any(|frame| frame.start_offset == offset)
    }

    fn reset_visibility(&mut self) {
        self.frames.clear();
        self.retained = 0;
        self.transient = None;
        self.end = self.end.saturating_add(1);
        self.visibility_floor = self.end;
    }

    fn frame(&self, payload: Vec<u8>) -> DomainResult<StreamFrame> {
        let end = self
            .end
            .checked_add(payload.len() as u64)
            .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?;
        Ok(StreamFrame {
            start_offset: self.end,
            end_offset: end,
            payload: payload.into(),
        })
    }

    fn require_open(&self) -> DomainResult<()> {
        if self.terminal.is_some() {
            return Err(invalid_state());
        }
        Ok(())
    }

    fn require_step(&self, step: u32) -> DomainResult<TransientStep> {
        self.require_open()?;
        self.transient
            .filter(|transient| transient.step == step)
            .ok_or_else(invalid_state)
    }

    fn require_committed(&self, entry: ThreadEntrySeq) -> DomainResult<()> {
        self.require_open()?;
        if entry == ThreadEntrySeq::ZERO || entry > self.committed_leaf {
            return Err(invalid_state());
        }
        Ok(())
    }
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state.lock().unwrap_or_else(|error| error.into_inner())
}

/// There is one retained frame deque for a run. Watch carries only a wakeup.
/// A subscriber holds the current frame while its transport writes it.
#[derive(Clone)]
pub(crate) struct StepStreamBuffer {
    run: AgentRunId,
    thread: ChatThreadId,
    state: Arc<Mutex<State>>,
    changed: watch::Sender<u64>,
}

impl StepStreamBuffer {
    pub fn new(run: AgentRunId, thread: ChatThreadId, initial_leaf: ThreadEntrySeq) -> Self {
        let (changed, _) = watch::channel(0);
        Self {
            run,
            thread,
            state: Arc::new(Mutex::new(State {
                frames: VecDeque::new(),
                retained: 0,
                end: 0,
                committed_leaf: initial_leaf,
                transient: None,
                last_step: None,
                terminal: None,
                redaction_pending: false,
                visibility_floor: 0,
            })),
            changed,
        }
    }

    pub fn begin_step(&self, step: u32) -> DomainResult<()> {
        let mut state = lock(&self.state);
        if state.visibility_floor != 0 {
            return Ok(());
        }
        state.require_open()?;
        if state.transient.is_some() || state.last_step.is_some_and(|previous| step <= previous) {
            return Err(invalid_state());
        }
        state.transient = Some(TransientStep {
            step,
            start: state.end,
        });
        state.last_step = Some(step);
        Ok(())
    }

    pub fn text_delta(&self, step: u32, text: &str) -> DomainResult<()> {
        let room = self.fragment_room(AgentRunEvent::TextDelta { step, text: "" })?;
        let mut remaining = text;
        while !remaining.is_empty() {
            let (piece, rest) = bounded_prefix(remaining, room)?;
            self.append_step(step, AgentRunEvent::TextDelta { step, text: piece })?;
            remaining = rest;
        }
        Ok(())
    }

    pub fn tool_call(&self, step: u32, call: &ProviderToolCall) -> DomainResult<()> {
        let call_id = CommandKey::parse_v1(call.id.as_str())?;
        let arguments = serde_json::to_string(&call.arguments).map_err(|_| invalid_state())?;
        self.append_step(
            step,
            AgentRunEvent::ToolCallStart {
                step,
                call_id: &call_id,
                name: &call.name,
            },
        )?;
        let mut remaining = arguments.as_str();
        let mut index = 0;
        while !remaining.is_empty() {
            let room = self.fragment_room(AgentRunEvent::ToolCallDelta {
                step,
                call_id: &call_id,
                index,
                fragment: "",
                last: false,
            })?;
            let (fragment, rest) = bounded_prefix(remaining, room)?;
            self.append_step(
                step,
                AgentRunEvent::ToolCallDelta {
                    step,
                    call_id: &call_id,
                    index,
                    fragment,
                    last: rest.is_empty(),
                },
            )?;
            remaining = rest;
            index = index
                .checked_add(1)
                .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?;
        }
        Ok(())
    }

    /// Called after acknowledgment of a durable append. A late callback for an
    /// already incorporated entry does not rewind the selected branch. If a
    /// peer's earlier commit notification was missed, the canonical snapshot
    /// covers the gap before ordinary live replay resumes.
    pub fn committed(&self, entry: &ChatEntry, step: Option<u32>) -> DomainResult<bool> {
        if entry.thread != self.thread || !entry.is_chain_node {
            return Err(invalid_state());
        }
        let mut state = lock(&self.state);
        if state.visibility_floor != 0 {
            if entry.seq > state.committed_leaf {
                state.committed_leaf = entry.seq;
                state.reset_visibility();
                self.changed.send_replace(state.end);
            }
            return Ok(false);
        }
        // A peer may finish a durable submission while this run is closing.
        // Its receipt still succeeds after the stream stops accepting frames.
        if state.terminal.is_some() && step.is_none() {
            return Ok(false);
        }
        state.require_open()?;
        let superseded = entry.seq <= state.committed_leaf;
        let boundary = match step {
            Some(step)
                if entry.kind == ChatEntryKind::Model && entry.run.as_ref() == Some(&self.run) =>
            {
                if superseded && state.transient.is_none_or(|current| current.step != step) {
                    return Ok(false);
                }
                Some(state.require_step(step)?)
            }
            Some(_) => return Err(invalid_state()),
            None if superseded => return Ok(false),
            None => None,
        };
        let frame = state.frame(self.encode(AgentRunEvent::Committed {
            entry_seq: entry.seq,
            step,
            transient_start: boundary.map(|boundary| boundary.start),
            transient_end: boundary.map(|_| state.end),
        })?)?;
        let contiguous =
            !superseded && entry.parent.unwrap_or(ThreadEntrySeq::ZERO) == state.committed_leaf;
        state.committed_leaf = state.committed_leaf.max(entry.seq);
        if boundary.is_some() {
            state.transient = None;
        }
        if !contiguous {
            // Advance beyond every previous cursor, including viewers already
            // at the old tail. Their next read will capture this checkpoint.
            state.frames.clear();
            state.retained = 0;
            state.end = frame.end_offset;
            self.changed.send_replace(state.end);
        } else {
            self.insert(&mut state, frame);
        }
        Ok(true)
    }

    pub fn tool_result(
        &self,
        step: u32,
        call_id: &CommandKey,
        entry_seq: ThreadEntrySeq,
        preview: &str,
    ) -> DomainResult<()> {
        let room = self.fragment_room(AgentRunEvent::ToolCallResult {
            step,
            call_id,
            entry_seq,
            preview: "",
            preview_truncated: false,
        })?;
        let (preview, remainder) = bounded_prefix(preview, room)?;
        self.append_committed_event(
            entry_seq,
            AgentRunEvent::ToolCallResult {
                step,
                call_id,
                entry_seq,
                preview,
                preview_truncated: !remainder.is_empty(),
            },
        )
    }

    pub fn approval_needed(
        &self,
        step: u32,
        call_id: &CommandKey,
        entry_seq: ThreadEntrySeq,
        proposal: ContentDigest,
    ) -> DomainResult<()> {
        self.append_committed_event(
            entry_seq,
            AgentRunEvent::TaintApprovalNeeded {
                step,
                call_id,
                entry_seq,
                proposal,
            },
        )
    }

    pub fn finish(&self) -> DomainResult<()> {
        self.finish_with(RunTerminal::Finished)
    }

    pub fn fail(&self, code: RunFailure) -> DomainResult<()> {
        self.finish_with(RunTerminal::Failed { code })
    }

    pub fn subscribe(&self, cursor: Option<&StreamCursor>) -> StepSubscription {
        let state = lock(&self.state);
        let changed = self.changed.subscribe();
        let resume = cursor
            .filter(|cursor| cursor.run == self.run && state.valid_boundary(cursor.byte_offset));
        StepSubscription {
            state: Arc::clone(&self.state),
            run: self.run.clone(),
            changed,
            next_offset: resume.map_or(state.end, |cursor| cursor.byte_offset),
            checkpoint: resume.is_none().then(|| state.checkpoint(&self.run)),
        }
    }

    pub(super) fn pause_for_redaction(self: &Arc<Self>) -> StreamRedaction {
        lock(&self.state).redaction_pending = true;
        StreamRedaction {
            buffer: self.clone(),
            discard: true,
        }
    }

    fn append_step(&self, step: u32, event: AgentRunEvent<'_>) -> DomainResult<()> {
        let payload = self.encode(event)?;
        let mut state = lock(&self.state);
        if state.visibility_floor != 0 {
            return Ok(());
        }
        state.require_step(step)?;
        let frame = state.frame(payload)?;
        self.insert(&mut state, frame);
        Ok(())
    }

    fn append_committed_event(
        &self,
        entry: ThreadEntrySeq,
        event: AgentRunEvent<'_>,
    ) -> DomainResult<()> {
        let payload = self.encode(event)?;
        let mut state = lock(&self.state);
        if state.visibility_floor != 0 {
            return Ok(());
        }
        state.require_committed(entry)?;
        let frame = state.frame(payload)?;
        self.insert(&mut state, frame);
        Ok(())
    }

    fn finish_with(&self, terminal: RunTerminal) -> DomainResult<()> {
        let event = match terminal {
            RunTerminal::Finished => AgentRunEvent::RunFinished,
            RunTerminal::Failed { code } => AgentRunEvent::RunFailed { code },
        };
        let payload = self.encode(event)?;
        let mut state = lock(&self.state);
        if state.terminal == Some(terminal) {
            return Ok(());
        }
        state.require_open()?;
        if terminal == RunTerminal::Finished && state.transient.is_some() {
            return Err(invalid_state());
        }
        let frame = state.frame(payload)?;
        state.terminal = Some(terminal);
        state.transient = None;
        self.insert(&mut state, frame);
        Ok(())
    }

    fn encode(&self, event: AgentRunEvent<'_>) -> DomainResult<Vec<u8>> {
        let bytes = serde_json::to_vec(&Envelope {
            run: &self.run,
            event,
        })
        .map_err(|_| invalid_state())?;
        if bytes.len() > STREAM_FRAME_BYTES {
            return Err(DomainError::validation(ValidationReason::InvalidLimit));
        }
        Ok(bytes)
    }

    fn fragment_room(&self, empty: AgentRunEvent<'_>) -> DomainResult<usize> {
        Ok(STREAM_FRAME_BYTES - self.encode(empty)?.len())
    }

    fn insert(&self, state: &mut State, frame: StreamFrame) {
        let size = frame.payload.len();
        while state.retained + size > STREAM_WINDOW_BYTES {
            let evicted = state
                .frames
                .pop_front()
                .expect("encoded frame fits the stream window");
            state.retained -= evicted.payload.len();
        }
        state.retained += size;
        state.end = frame.end_offset;
        state.frames.push_back(frame);
        self.changed.send_replace(state.end);
    }
}

pub(super) struct StreamRedaction {
    buffer: Arc<StepStreamBuffer>,
    discard: bool,
}

impl StreamRedaction {
    pub(super) fn keep_history(&mut self) {
        self.discard = false;
    }
}

impl Drop for StreamRedaction {
    fn drop(&mut self) {
        let mut state = lock(&self.buffer.state);
        if self.discard {
            // Watch notifications and all consumers use this same lock.
            // Invalidate old tail cursors as well as cursors into erased frames.
            state.reset_visibility();
        }
        state.redaction_pending = false;
        self.buffer.changed.send_replace(state.end);
    }
}

pub struct StepSubscription {
    state: Arc<Mutex<State>>,
    run: AgentRunId,
    changed: watch::Receiver<u64>,
    next_offset: u64,
    checkpoint: Option<StreamCheckpoint>,
}

impl StepSubscription {
    pub async fn next(&mut self) -> StreamRead {
        loop {
            {
                let state = lock(&self.state);
                if !state.redaction_pending {
                    if self.next_offset < state.visibility_floor
                        || self
                            .checkpoint
                            .as_ref()
                            .is_some_and(|saved| saved.cursor.byte_offset < state.visibility_floor)
                    {
                        self.checkpoint = None;
                        self.next_offset = state.end;
                        return StreamRead::CatchUpRequired(state.checkpoint(&self.run));
                    }
                    if let Some(checkpoint) = self.checkpoint.take() {
                        return StreamRead::CatchUpRequired(checkpoint);
                    }
                    if self.next_offset != state.end {
                        return match state
                            .frames
                            .iter()
                            .find(|frame| frame.start_offset == self.next_offset)
                        {
                            Some(frame) => {
                                self.next_offset = frame.end_offset;
                                StreamRead::Frame(frame.clone())
                            }
                            None => {
                                self.next_offset = state.end;
                                StreamRead::CatchUpRequired(state.checkpoint(&self.run))
                            }
                        };
                    }
                    if state.terminal.is_some() {
                        return StreamRead::Closed;
                    }
                }
                // Publication holds this same lock while notifying watch.
                // Seeing the current tail and marking it seen is atomic.
                drop(self.changed.borrow_and_update());
            }
            if self.changed.changed().await.is_err() {
                return StreamRead::Closed;
            }
        }
    }
}

fn invalid_state() -> DomainError {
    DomainError::validation(ValidationReason::InvalidState)
}

fn bounded_prefix(text: &str, limit: usize) -> DomainResult<(&str, &str)> {
    // These are the lengths used by serde_json in a JSON string. UTF-8
    // characters above the ASCII control range remain UTF-8.
    let mut used = 0;
    for (offset, char) in text.char_indices() {
        used += match char {
            '"' | '\\' | '\u{8}' | '\t' | '\n' | '\u{c}' | '\r' => 2,
            '\0'..='\u{1f}' => 6,
            char => char.len_utf8(),
        };
        if used > limit {
            if offset == 0 {
                return Err(DomainError::validation(ValidationReason::InvalidLimit));
            }
            return Ok(text.split_at(offset));
        }
    }
    Ok((text, ""))
}

#[cfg(test)]
mod tests;
