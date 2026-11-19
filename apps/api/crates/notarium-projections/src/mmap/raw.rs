#![allow(unsafe_code)]

use std::{fs::File, io};

use croaring::{BitmapView, Frozen};
use memmap2::{Mmap, MmapOptions};

use super::format::FrozenSliceToken;

pub(super) fn map_immutable(file: &File) -> io::Result<Mmap> {
    // SAFETY: The checkpoint directory is runtime-owned and private. The writer
    // closes its only writable file handle before publishing with no replacement.
    // The caller opens that immutable file once, validates it on this mapping,
    // and never mutates or truncates it. Windows retains a handle that denies
    // sharing for writes. Retirement can only unlink the original file.
    unsafe { MmapOptions::new().map(file) }
}

pub(super) fn frozen(token: FrozenSliceToken<'_>) -> Option<BitmapView<'_>> {
    #[cfg(test)]
    FROZEN_CALLS.set(FROZEN_CALLS.get() + 1);
    // SAFETY: A token borrows this immutable mapping and can only be minted
    // after matching its writer digest/ABI and validating the whole directory.
    // It identifies an exact, 32-byte-aligned output of the pinned serializer.
    unsafe { BitmapView::try_deserialize::<Frozen>(token.bytes()) }
}

#[cfg(test)]
thread_local! {
    pub(super) static FROZEN_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
