use std::{
    io::{self, Read, Seek, SeekFrom},
    sync::{Arc, Mutex},
};

/// Any number of independently seekable, bounded views over one opened source.
pub(crate) struct RangeSource<R> {
    inner: Arc<Mutex<R>>,
    start: u64,
    length: u64,
    position: u64,
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
        }
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
        }
    }
}

impl<R: Read + Seek> Read for RangeSource<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let available = self.length - self.position;
        let len = available.min(bytes.len() as u64) as usize;
        if len == 0 {
            return Ok(0);
        }
        let mut source = self
            .inner
            .lock()
            .map_err(|_| io::Error::other("archive source closed"))?;
        source.seek(SeekFrom::Start(self.start + self.position))?;
        let found = source.read(&mut bytes[..len])?;
        self.position += found as u64;
        Ok(found)
    }
}

impl<R> Seek for RangeSource<R> {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
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
