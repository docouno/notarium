use std::{
    io::{self, Read, Seek, SeekFrom},
    sync::{Arc, Mutex},
};

use notarium_core::ports::Cancellation;

/// Any number of independently seekable, bounded views over one opened source.
pub(crate) struct RangeSource<R> {
    inner: Arc<Mutex<R>>,
    start: u64,
    length: u64,
    position: u64,
    cancellation: Option<Cancellation>,
}

impl<R: Seek> RangeSource<R> {
    pub(crate) fn new(mut inner: R) -> io::Result<Self> {
        let length = inner.seek(SeekFrom::End(0))?;
        Ok(Self::with_length(inner, length))
    }
}

impl<R> RangeSource<R> {
    pub(crate) fn with_length(inner: R, length: u64) -> Self {
        Self {
            inner: Arc::new(Mutex::new(inner)),
            start: 0,
            length,
            position: 0,
            cancellation: None,
        }
    }

    pub(crate) fn with_cancellation(mut self, cancellation: Cancellation) -> Self {
        self.cancellation = Some(cancellation);
        self
    }

    fn check_cancellation(&self) -> io::Result<()> {
        if self
            .cancellation
            .as_ref()
            .is_some_and(Cancellation::is_cancelled)
        {
            return Err(io::Error::other("archive source read cancelled"));
        }
        Ok(())
    }

    pub(crate) fn view(&self, start: u64, length: u64) -> io::Result<Self> {
        if start
            .checked_add(length)
            .is_none_or(|end| end > self.length)
        {
            return Err(bounds());
        }
        Ok(Self {
            inner: self.inner.clone(),
            start: self.start + start,
            length,
            position: 0,
            cancellation: self.cancellation.clone(),
        })
    }

    pub(crate) fn len(&self) -> u64 {
        self.length
    }
}

impl<R> Clone for RangeSource<R> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            start: self.start,
            length: self.length,
            position: 0,
            cancellation: self.cancellation.clone(),
        }
    }
}

impl<R: Read + Seek> Read for RangeSource<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.check_cancellation()?;
        let available = self.length - self.position;
        let len = available.min(bytes.len() as u64) as usize;
        if len == 0 {
            return Ok(0);
        }
        let mut source = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("archive source closed"))?;
        self.check_cancellation()?;
        source.seek(SeekFrom::Start(self.start + self.position))?;
        self.check_cancellation()?;
        let found = source.read(&mut bytes[..len])?;
        self.position += found as u64;
        Ok(found)
    }
}

impl<R> Seek for RangeSource<R> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        self.check_cancellation()?;
        let target = match pos {
            SeekFrom::Start(value) => Some(value),
            SeekFrom::End(offset) => self.length.checked_add_signed(offset),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
        }
        .filter(|pos| *pos <= self.length)
        .ok_or_else(bounds)?;
        self.position = target;
        Ok(target)
    }
}

fn bounds() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "archive range exceeded")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ShortRead {
        cancellation: Cancellation,
        called: bool,
    }

    impl Read for ShortRead {
        fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
            assert!(!self.called, "read started after cancellation");
            self.called = true;
            self.cancellation.cancel();
            output[0] = 1;
            Ok(1)
        }
    }

    impl Seek for ShortRead {
        fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
            assert!(!self.called, "seek started after cancellation");
            Ok(0)
        }
    }

    #[test]
    fn cancelled_range_does_not_retry_a_short_read() {
        let cancellation = Cancellation::default();
        let source = ShortRead {
            cancellation: cancellation.clone(),
            called: false,
        };
        let archive = RangeSource::with_length(source, 16).with_cancellation(cancellation);
        let mut payload = archive.view(4, 4).unwrap();
        assert_eq!(
            payload.read_exact(&mut [0; 4]).unwrap_err().kind(),
            io::ErrorKind::Other
        );
    }
}
