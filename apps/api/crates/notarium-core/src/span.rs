//! Checked units. A span is only sliceable after validation against its source.
use crate::{DomainError, DomainResult, error::ValidationReason};
use serde::{Deserialize, Serialize};

macro_rules! span {
    ($name:ident) => {
        #[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
        #[serde(try_from = "(usize, usize)", into = "(usize, usize)")]
        pub struct $name {
            start: usize,
            end: usize,
        }
        impl $name {
            pub fn new(start: usize, end: usize) -> DomainResult<Self> {
                if start <= end {
                    Ok(Self { start, end })
                } else {
                    Err(DomainError::validation(ValidationReason::InvalidSpan))
                }
            }
            pub const fn start(self) -> usize {
                self.start
            }
            pub const fn end(self) -> usize {
                self.end
            }
            pub const fn len(self) -> usize {
                self.end - self.start
            }
            pub const fn is_empty(self) -> bool {
                self.start == self.end
            }
        }
        impl TryFrom<(usize, usize)> for $name {
            type Error = DomainError;
            fn try_from((start, end): (usize, usize)) -> DomainResult<Self> {
                Self::new(start, end)
            }
        }
        impl From<$name> for (usize, usize) {
            fn from(span: $name) -> Self {
                (span.start, span.end)
            }
        }
    };
}
span!(ByteSpan);
span!(Utf16Span);
impl ByteSpan {
    pub fn checked(source: &str, start: usize, end: usize) -> DomainResult<Self> {
        let span = Self::new(start, end)?;
        span.slice(source)?;
        Ok(span)
    }
    pub fn slice(self, source: &str) -> DomainResult<&str> {
        source
            .get(self.start..self.end)
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidSpan))
    }
    pub fn to_utf16(self, source: &str) -> DomainResult<Utf16Span> {
        let slice = self.slice(source)?;
        let start = source[..self.start].encode_utf16().count();
        Utf16Span::new(start, start + slice.encode_utf16().count())
    }
}
impl Utf16Span {
    pub fn to_bytes(self, source: &str) -> DomainResult<ByteSpan> {
        let mut units = 0;
        let mut start = None;
        let mut end = None;
        for (offset, ch) in source
            .char_indices()
            .chain(std::iter::once((source.len(), '\0')))
        {
            if units == self.start {
                start = Some(offset);
            }
            if units == self.end {
                end = Some(offset);
                break;
            }
            units += ch.len_utf16();
        }
        match (start, end) {
            (Some(start), Some(end)) => ByteSpan::checked(source, start, end),
            _ => Err(DomainError::validation(ValidationReason::InvalidSpan)),
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CarrierByteSpan(pub ByteSpan);
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CarrierUtf16Span(pub Utf16Span);
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BodyByteSpan(pub ByteSpan);
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BodyUtf16Span(pub Utf16Span);
pub fn decode_utf8(bytes: &[u8]) -> DomainResult<&str> {
    std::str::from_utf8(bytes).map_err(|_| DomainError::validation(ValidationReason::InvalidUtf8))
}
pub fn decode_utf16(units: &[u16]) -> DomainResult<String> {
    String::from_utf16(units).map_err(|_| DomainError::validation(ValidationReason::InvalidUtf16))
}
