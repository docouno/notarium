//! Binary transport framing for an admitted collaboration session.
//!
//! y-sync v1 permits several messages in a single transport payload. The
//! complete envelope is checked first, before an actor can handle any message.
//! Updates remain borrowed so the room can validate them in document order.

use notarium_core::ids::{HistoryIncarnation, LeaseEpoch, LineageEpoch, RevisionId};
use thiserror::Error;
use yrs::encoding::write::Write;
use yrs::sync::protocol::{
    MSG_AWARENESS, MSG_QUERY_AWARENESS, MSG_SYNC, MSG_SYNC_STEP_1, MSG_SYNC_STEP_2, MSG_SYNC_UPDATE,
};
use yrs::sync::{AwarenessUpdate, Message, SyncMessage};
use yrs::updates::{decoder::Decode, encoder::Encode};
use yrs::{ClientID, StateVector};

pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_MESSAGES_PER_FRAME: usize = 128;
pub const WIRE_PROTOCOL_VERSION: u8 = 1;
pub const LINEAGE_HELLO: u8 = 100;
pub const LINEAGE_READY: u8 = 101;
pub const LINEAGE_MISMATCH: u8 = 102;
pub const SERVER_ACK_WATERMARK: u8 = 103;
pub const POLICY_REJECTED: u8 = 104;

pub(crate) const MAX_CLIENT_ID: u64 = (1 << 53) - 1;
pub(crate) const MAX_CLOCK: u32 = i32::MAX as u32;
pub(crate) const MAX_STATE_VECTOR_CLIENTS: usize = 16_384;
pub(crate) const MAX_AWARENESS_CLIENTS: usize = 256;
const MAX_AWARENESS_JSON_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum PeerRole {
    Viewer = 0,
    Editor = 1,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum FrameError {
    #[error("frame exceeds the collaboration size limit")]
    MessageTooBig,
    #[error("invalid collaboration frame")]
    Protocol,
}

impl FrameError {
    pub const fn code(self) -> u16 {
        match self {
            Self::MessageTooBig => 1009,
            Self::Protocol => 1002,
        }
    }

    pub const fn reason(self) -> &'static str {
        match self {
            Self::MessageTooBig => "Collaboration frame too large",
            Self::Protocol => "Invalid collaboration frame",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LineageHello {
    Fresh,
    Reconnect {
        client_history_incarnation: HistoryIncarnation,
        client_lineage_epoch: LineageEpoch,
        client_base_rev_id: Option<RevisionId>,
    },
}

impl LineageHello {
    pub fn encode(&self) -> Vec<u8> {
        encode_custom(LINEAGE_HELLO, |payload| match self {
            Self::Fresh => payload.write_u8(0),
            Self::Reconnect {
                client_history_incarnation,
                client_lineage_epoch,
                client_base_rev_id,
            } => {
                payload.write_u8(1);
                payload.write_all(client_history_incarnation.as_bytes());
                payload.write_var(client_lineage_epoch.get());
                write_optional_revision(payload, client_base_rev_id.as_ref());
            }
        })
    }
}

/// Validate the first payload of a connection before accessing room state.
pub fn decode_hello(frame: &[u8]) -> Result<LineageHello, FrameError> {
    let mut outer = bounded_frame(frame)?;
    if outer.var_u32()? != u32::from(LINEAGE_HELLO) {
        return Err(FrameError::Protocol);
    }
    let mut payload = Cursor::new(outer.bytes()?);
    if !outer.is_empty() || payload.byte()? != WIRE_PROTOCOL_VERSION {
        return Err(FrameError::Protocol);
    }

    let hello = match payload.byte()? {
        0 => LineageHello::Fresh,
        1 => {
            let bytes: [u8; 16] = payload
                .take(16)?
                .try_into()
                .map_err(|_| FrameError::Protocol)?;
            let client_history_incarnation = HistoryIncarnation::from_bytes(bytes);
            let client_lineage_epoch =
                LineageEpoch::new(payload.var_u64()?).map_err(|_| FrameError::Protocol)?;
            let client_base_rev_id = match payload.byte()? {
                0 => None,
                1 => Some(RevisionId::parse(payload.string()?).map_err(|_| FrameError::Protocol)?),
                _ => return Err(FrameError::Protocol),
            };
            LineageHello::Reconnect {
                client_history_incarnation,
                client_lineage_epoch,
                client_base_rev_id,
            }
        }
        _ => return Err(FrameError::Protocol),
    };
    if !payload.is_empty() {
        return Err(FrameError::Protocol);
    }
    Ok(hello)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LineageReady {
    pub history_incarnation: HistoryIncarnation,
    pub lineage_epoch: LineageEpoch,
    pub current_rev_id: RevisionId,
    pub lease_epoch: LeaseEpoch,
    pub role: PeerRole,
    pub fm_writable: bool,
}

impl LineageReady {
    pub fn encode(&self) -> Vec<u8> {
        encode_custom(LINEAGE_READY, |payload| {
            payload.write_all(self.history_incarnation.as_bytes());
            payload.write_var(self.lineage_epoch.get());
            payload.write_string(self.current_rev_id.as_str());
            payload.write_var(self.lease_epoch.get());
            payload.write_u8(self.role as u8);
            payload.write_u8(u8::from(self.fm_writable));
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LineageMismatch {
    pub current_history_incarnation: HistoryIncarnation,
    pub current_rev_id: RevisionId,
    pub current_lineage_epoch: LineageEpoch,
    pub verified_base_rev_id: Option<RevisionId>,
}

impl LineageMismatch {
    pub fn encode(&self) -> Vec<u8> {
        encode_custom(LINEAGE_MISMATCH, |payload| {
            payload.write_all(self.current_history_incarnation.as_bytes());
            payload.write_string(self.current_rev_id.as_str());
            payload.write_var(self.current_lineage_epoch.get());
            write_optional_revision(payload, self.verified_base_rev_id.as_ref());
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServerAckWatermark {
    pub lease_epoch: LeaseEpoch,
    pub peer_write_seq: u64,
    pub room_update_seq: u64,
}

impl ServerAckWatermark {
    pub fn encode(self) -> Vec<u8> {
        encode_custom(SERVER_ACK_WATERMARK, |payload| {
            payload.write_var(self.lease_epoch.get());
            payload.write_var(self.peer_write_seq);
            payload.write_var(self.room_update_seq);
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[repr(u8)]
pub enum PolicyRejectReason {
    #[error("Malformed collaboration update")]
    MalformedUpdate = 1,
    #[error("Collaboration update has missing dependencies")]
    PendingClockGap = 2,
    #[error("Collaboration update uses an unsupported shared type")]
    ForbiddenRootOrSubdoc = 3,
    #[error("Collaboration body must contain valid plain text")]
    InvalidBodyContent = 4,
    #[error("This frontmatter cannot be edited through collaboration")]
    FrontmatterNotWritable = 5,
    #[error("Frontmatter keys must be unset explicitly")]
    FrontmatterKeyDeleted = 6,
    #[error("Collaboration cannot edit protected frontmatter keys")]
    ProtectedFrontmatterKey = 7,
    #[error("Collaboration frontmatter value is invalid")]
    InvalidFrontmatterValue = 8,
}

pub fn encode_policy_rejected(reason: PolicyRejectReason) -> Vec<u8> {
    encode_custom(POLICY_REJECTED, |payload| {
        payload.write_u8(reason as u8);
        payload.write_string(&reason.to_string());
    })
}

fn encode_custom(tag: u8, write_payload: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut payload = vec![WIRE_PROTOCOL_VERSION];
    write_payload(&mut payload);
    let mut frame = Vec::with_capacity(payload.len() + 6);
    frame.write_u8(tag);
    frame.write_buf(payload);
    frame
}

fn write_optional_revision(payload: &mut Vec<u8>, revision: Option<&RevisionId>) {
    payload.write_u8(u8::from(revision.is_some()));
    if let Some(revision) = revision {
        payload.write_string(revision.as_str());
    }
}

pub(crate) fn encode_sync_step1(state: StateVector) -> Vec<u8> {
    Message::Sync(SyncMessage::SyncStep1(state)).encode_v1()
}

pub fn encode_sync_step2(update: &[u8]) -> Vec<u8> {
    encode_sync_bytes(MSG_SYNC_STEP_2, update)
}

pub fn encode_update(update: &[u8]) -> Vec<u8> {
    encode_sync_bytes(MSG_SYNC_UPDATE, update)
}

pub(crate) fn encode_update_into(frame: &mut Vec<u8>, data: &[u8]) {
    frame.write_var(MSG_SYNC);
    frame.write_var(MSG_SYNC_UPDATE);
    frame.write_buf(data);
}

fn encode_sync_bytes(tag: u8, data: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(data.len() + 8);
    frame.write_var(MSG_SYNC);
    frame.write_var(tag);
    frame.write_buf(data);
    frame
}

pub(crate) fn encode_awareness(update: &AwarenessUpdate) -> Vec<u8> {
    let payload = update.encode_v1();
    let mut frame = Vec::with_capacity(payload.len() + 8);
    frame.write_var(MSG_AWARENESS);
    frame.write_buf(payload);
    frame
}

/// An application message whose envelope has already been checked.
#[derive(Debug)]
pub(crate) enum InboundMessage<'a> {
    SyncStep1(ValidatedStateVector<'a>),
    SyncStep2(&'a [u8]),
    Update(&'a [u8]),
    Awareness(ValidatedAwareness<'a>),
    AwarenessQuery,
}

#[derive(Debug)]
pub(crate) struct ValidatedStateVector<'a>(&'a [u8]);

impl ValidatedStateVector<'_> {
    /// Decode only clients already known to the live document so untrusted
    /// peers cannot exploit `StateVector`'s non-randomized hasher with
    /// synthetic colliding client IDs.
    pub(crate) fn decode_known(
        self,
        is_known: impl Fn(ClientID) -> bool,
    ) -> Result<StateVector, FrameError> {
        let mut cursor = Cursor::new(self.0);
        let count = cursor.count(2)?;
        if count > MAX_STATE_VECTOR_CLIENTS {
            return Err(FrameError::Protocol);
        }
        let mut sv = StateVector::default();
        for _ in 0..count {
            let id = cursor.client_id()?;
            let clock = cursor.clock()?;
            if is_known(id) {
                if sv.contains_client(&id) {
                    return Err(FrameError::Protocol);
                }
                sv.set_min(id, clock);
            }
        }
        if !cursor.is_empty() {
            return Err(FrameError::Protocol);
        }
        Ok(sv)
    }

    #[cfg(test)]
    pub(crate) fn decode(self) -> Result<StateVector, FrameError> {
        self.decode_known(|_| true)
    }
}

#[derive(Debug)]
pub(crate) struct ValidatedAwareness<'a>(&'a [u8]);

impl ValidatedAwareness<'_> {
    pub(crate) fn decode(self) -> Result<AwarenessUpdate, FrameError> {
        let update = AwarenessUpdate::decode_v1(self.0).map_err(|_| FrameError::Protocol)?;
        for entry in update.clients.values() {
            serde_json::from_str::<serde::de::IgnoredAny>(&entry.json)
                .map_err(|_| FrameError::Protocol)?;
        }
        Ok(update)
    }
}

/// Pre-scan a synchronized payload in linear time, without allocating.
///
/// The outer lengths are checked through EOF. State-vector and awareness counts,
/// clocks and IDs are checked before any Yrs decoder runs. An Editor's raw
/// update requires a second, document-aware check by the room. A Viewer's
/// write payload is never parsed, even when followed by a valid read message.
pub(crate) fn decode_frame<'a>(
    frame: &'a [u8],
    role: PeerRole,
    reserved_awareness_clients: &[ClientID],
) -> Result<FrameMessages<'a>, FrameError> {
    let mut scan = bounded_frame(frame)?;
    let mut messages = 0usize;
    while !scan.is_empty() {
        messages += 1;
        if messages > MAX_MESSAGES_PER_FRAME {
            return Err(FrameError::Protocol);
        }
        match next_message(&mut scan, role)? {
            Some(InboundMessage::SyncStep1(state)) => prevalidate_state_vector(state.0)?,
            Some(InboundMessage::Awareness(update)) => {
                prevalidate_awareness(update.0, reserved_awareness_clients)?;
            }
            _ => {}
        }
    }
    Ok(FrameMessages {
        cursor: Cursor::new(frame),
        role,
    })
}

#[derive(Debug)]
pub(crate) struct FrameMessages<'a> {
    cursor: Cursor<'a>,
    role: PeerRole,
}

impl<'a> Iterator for FrameMessages<'a> {
    type Item = InboundMessage<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        while !self.cursor.is_empty() {
            let message = next_message(&mut self.cursor, self.role)
                .expect("message envelope was validated before iteration");
            if message.is_some() {
                return message;
            }
        }
        None
    }
}

fn next_message<'a>(
    cursor: &mut Cursor<'a>,
    role: PeerRole,
) -> Result<Option<InboundMessage<'a>>, FrameError> {
    let tag = u8::try_from(cursor.var_u32()?).map_err(|_| FrameError::Protocol)?;
    let message = match tag {
        MSG_SYNC => {
            let step = u8::try_from(cursor.var_u32()?).map_err(|_| FrameError::Protocol)?;
            let bytes = cursor.bytes()?;
            match step {
                MSG_SYNC_STEP_1 => InboundMessage::SyncStep1(ValidatedStateVector(bytes)),
                MSG_SYNC_STEP_2 | MSG_SYNC_UPDATE if role == PeerRole::Viewer => return Ok(None),
                MSG_SYNC_STEP_2 => InboundMessage::SyncStep2(bytes),
                MSG_SYNC_UPDATE => InboundMessage::Update(bytes),
                _ => return Err(FrameError::Protocol),
            }
        }
        MSG_AWARENESS => InboundMessage::Awareness(ValidatedAwareness(cursor.bytes()?)),
        MSG_QUERY_AWARENESS => InboundMessage::AwarenessQuery,
        _ => return Err(FrameError::Protocol),
    };
    Ok(Some(message))
}

fn bounded_frame(bytes: &[u8]) -> Result<Cursor<'_>, FrameError> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(FrameError::MessageTooBig);
    }
    if bytes.is_empty() {
        return Err(FrameError::Protocol);
    }
    Ok(Cursor::new(bytes))
}

fn prevalidate_state_vector(bytes: &[u8]) -> Result<(), FrameError> {
    let mut cursor = Cursor::new(bytes);
    let count = cursor.count(2)?;
    if count > MAX_STATE_VECTOR_CLIENTS {
        return Err(FrameError::Protocol);
    }
    for _ in 0..count {
        cursor.client_id()?;
        cursor.clock()?;
    }
    if !cursor.is_empty() {
        return Err(FrameError::Protocol);
    }
    Ok(())
}

fn prevalidate_awareness(bytes: &[u8], reserved: &[ClientID]) -> Result<(), FrameError> {
    let mut cursor = Cursor::new(bytes);
    let count = cursor.count(3)?;
    if count > MAX_AWARENESS_CLIENTS {
        return Err(FrameError::Protocol);
    }
    let mut seen = [ClientID::new(0); MAX_AWARENESS_CLIENTS];
    for index in 0..count {
        let id = cursor.client_id()?;
        if reserved.contains(&id) || seen[..index].contains(&id) {
            return Err(FrameError::Protocol);
        }
        seen[index] = id;
        cursor.clock()?;
        if cursor.string()?.len() > MAX_AWARENESS_JSON_BYTES {
            return Err(FrameError::Protocol);
        }
    }
    if !cursor.is_empty() {
        return Err(FrameError::Protocol);
    }
    Ok(())
}

/// Bounded primitive reader shared with the document-aware v1 update scanner.
/// Library decoders have deliberately more permissive integer semantics.
#[derive(Debug)]
pub(crate) struct Cursor<'a> {
    rest: &'a [u8],
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(rest: &'a [u8]) -> Self {
        Self { rest }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.rest.is_empty()
    }

    pub(crate) fn remaining(&self) -> usize {
        self.rest.len()
    }

    pub(crate) fn take(&mut self, len: usize) -> Result<&'a [u8], FrameError> {
        let (bytes, rest) = self
            .rest
            .split_at_checked(len)
            .ok_or(FrameError::Protocol)?;
        self.rest = rest;
        Ok(bytes)
    }

    pub(crate) fn byte(&mut self) -> Result<u8, FrameError> {
        let (&byte, rest) = self.rest.split_first().ok_or(FrameError::Protocol)?;
        self.rest = rest;
        Ok(byte)
    }

    pub(crate) fn var_u64(&mut self) -> Result<u64, FrameError> {
        self.continuation(0, 0)
    }

    pub(crate) fn var_u32(&mut self) -> Result<u32, FrameError> {
        u32::try_from(self.var_u64()?).map_err(|_| FrameError::Protocol)
    }

    pub(crate) fn var_i64(&mut self) -> Result<i64, FrameError> {
        let first = self.byte()?;
        let low = u64::from(first & 0x3f);
        let magnitude = if first & 0x80 == 0 {
            low
        } else {
            self.continuation(low, 6)?
        };
        // The lib0 signed encoding stores a sign and a magnitude. Yrs decodes
        // into i64 and may negate it, so i64::MIN's magnitude is invalid.
        let magnitude = i64::try_from(magnitude).map_err(|_| FrameError::Protocol)?;
        Ok(if first & 0x40 == 0 {
            magnitude
        } else {
            -magnitude
        })
    }

    fn continuation(&mut self, mut value: u64, first_shift: usize) -> Result<u64, FrameError> {
        for shift in (first_shift..u64::BITS as usize).step_by(7) {
            let byte = self.byte()?;
            let part = u64::from(byte & 0x7f);
            if part > (u64::MAX >> shift) {
                return Err(FrameError::Protocol);
            }
            value |= part << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(FrameError::Protocol)
    }

    pub(crate) fn count(&mut self, min_element_bytes: usize) -> Result<usize, FrameError> {
        let count = self.var_u32()? as usize;
        if count
            .checked_mul(min_element_bytes)
            .is_none_or(|min| min > self.remaining())
        {
            return Err(FrameError::Protocol);
        }
        Ok(count)
    }

    pub(crate) fn client_id(&mut self) -> Result<ClientID, FrameError> {
        let id = self.var_u64()?;
        if id > MAX_CLIENT_ID {
            return Err(FrameError::Protocol);
        }
        Ok(ClientID::new(id))
    }

    pub(crate) fn clock(&mut self) -> Result<u32, FrameError> {
        let clock = self.var_u32()?;
        if clock > MAX_CLOCK {
            return Err(FrameError::Protocol);
        }
        Ok(clock)
    }

    pub(crate) fn bytes(&mut self) -> Result<&'a [u8], FrameError> {
        let len = self.var_u32()? as usize;
        self.take(len)
    }

    pub(crate) fn string(&mut self) -> Result<&'a str, FrameError> {
        std::str::from_utf8(self.bytes()?).map_err(|_| FrameError::Protocol)
    }
}

#[cfg(test)]
mod tests;
