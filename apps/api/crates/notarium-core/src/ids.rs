//! Branded identities preserve legacy spelling; constructors never obtain entropy.

use crate::error::{DomainError, DomainResult, ValidationReason};
use serde::{Deserialize, Serialize};
use std::{fmt, str::FromStr};

fn valid_v1(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn valid_legacy(value: &str) -> bool {
    (value.len() == 12
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
        || (value.len() == 16 && value.bytes().all(|b| b.is_ascii_hexdigit()))
}

macro_rules! ids {
    ($($name:ident => $prefix:literal),+ $(,)?) => {$ (
        #[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);
        impl $name {
            pub const PREFIX: &'static str = $prefix;
            pub fn from_bytes(bytes: [u8; 16]) -> Self {
                Self(format!("{}{:032x}", Self::PREFIX, u128::from_be_bytes(bytes)))
            }
            pub fn parse_v1(value: &str) -> DomainResult<Self> {
                if valid_v1(value, Self::PREFIX) { Ok(Self(value.to_owned())) }
                else { Err(DomainError::validation(ValidationReason::InvalidId)) }
            }
            pub fn parse(value: &str) -> DomainResult<Self> {
                if valid_v1(value, Self::PREFIX) || valid_legacy(value) { Ok(Self(value.to_owned())) }
                else { Err(DomainError::validation(ValidationReason::InvalidId)) }
            }
            pub fn as_str(&self) -> &str { &self.0 }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.0) }
        }
        impl FromStr for $name {
            type Err = DomainError;
            fn from_str(value: &str) -> DomainResult<Self> { Self::parse(value) }
        }
        impl TryFrom<String> for $name {
            type Error = DomainError;
            fn try_from(value: String) -> DomainResult<Self> { Self::parse(&value) }
        }
        impl From<$name> for String { fn from(value: $name) -> Self { value.0 } }
    )+};
}
ids! {
    SpaceId => "sp_", FolderId => "fld_", NoteId => "nt_", RevisionId => "rev_",
    ViewKey => "v_", ChatThreadId => "thr_", AgentRunId => "run_", ScheduleId => "sch_",
    JobId => "job_", EpisodeId => "ses_", AbilityId => "ab_", ProviderResourceId => "prv_",
    CredentialId => "crd_", PrincipalId => "principal_", InstallationId => "install_",
    GrantId => "grant_", AuthSessionId => "auth_", RequestId => "request_",
    CommandKey => "cmd_", ModelProfileId => "model_", BodyIdentity => "body_",
    HeaderIdentity => "header_", EffectiveReadId => "read_", BackupId => "backup_",
    KeyId => "key_", ReservationId => "reservation_", PendingInputId => "pending_",
    ArtifactId => "artifact_",
}

macro_rules! counters {
    ($($name:ident),+ $(,)?) => {$ (
        #[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
        #[serde(try_from = "u64", into = "u64")]
        pub struct $name(u64);
        impl $name {
            pub const ZERO: Self = Self(0);
            pub const MAX: Self = Self(i64::MAX as u64);
            pub fn new(value: u64) -> DomainResult<Self> {
                if value <= Self::MAX.0 { Ok(Self(value)) }
                else { Err(DomainError::validation(ValidationReason::SequenceOverflow)) }
            }
            pub const fn get(self) -> u64 { self.0 }
            pub fn checked_next(self) -> DomainResult<Self> { Self::new(self.0 + 1) }
        }
        impl TryFrom<u64> for $name {
            type Error = DomainError;
            fn try_from(value: u64) -> DomainResult<Self> { Self::new(value) }
        }
        impl From<$name> for u64 { fn from(value: $name) -> Self { value.0 } }
    )+};
}
counters! { SpaceSeq, ThreadEntrySeq, LeaseEpoch, LineageEpoch, ProjectionGeneration, ControlRevision }

/// A history identity changes on restore, but survives ordinary restarts.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
pub struct HistoryIncarnation([u8; 16]);
impl HistoryIncarnation {
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }
    pub const fn as_bytes(&self) -> &[u8; 16] {
        &self.0
    }
}

/// An opaque digest; hashing and domain separation belong to the producing owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize, Deserialize)]
pub struct ContentDigest([u8; 32]);
impl ContentDigest {
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
    pub fn to_hex(self) -> String {
        use fmt::Write;
        let mut result = String::with_capacity(64);
        for byte in self.0 {
            write!(&mut result, "{byte:02x}").expect("writing to a String");
        }
        result
    }
    pub fn parse_hex(value: &str) -> DomainResult<Self> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(DomainError::validation(ValidationReason::InvalidDigest));
        }
        let mut result = [0; 32];
        for (slot, pair) in result.iter_mut().zip(value.as_bytes().as_chunks::<2>().0) {
            let digit = |b: u8| if b <= b'9' { b - b'0' } else { b - b'a' + 10 };
            *slot = digit(pair[0]) * 16 + digit(pair[1]);
        }
        Ok(Self(result))
    }
}
