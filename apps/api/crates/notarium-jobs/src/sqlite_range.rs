//! Read-only SQLite VFS for one owned, bounded archive window. No callback can
//! open host files, create a journal, request mmap, or write to the backing data.

use std::{
    ffi::{CStr, CString, c_char, c_int, c_void},
    io::{Read, Seek, SeekFrom},
    panic::{AssertUnwindSafe, catch_unwind},
    ptr,
    sync::Mutex,
};

use libsqlite3_sys as ffi;
use notarium_canonical::codec;
use notarium_core::{
    error::{PortError, ValidationReason},
    ports::Cancellation,
};
use rusqlite::{Connection, OpenFlags};

use crate::{
    backup_format::{invalid, io_error},
    import::check_cancelled,
};

const NAME: &CStr = c"archive.sqlite";
const DB_HEADER_BYTES: usize = 100;
const MAX_VALUE_BYTES: c_int = 32 * 1024 * 1024;

trait SeekRead: Read + Seek + Send {}
impl<T: Read + Seek + Send> SeekRead for T {}

struct Window {
    source: Mutex<Box<dyn SeekRead>>,
    len: u64,
    cancellation: Cancellation,
}

#[repr(C)]
struct OpenFile {
    base: ffi::sqlite3_file,
    owner: *const Window,
}

struct Registration {
    vfs: Box<ffi::sqlite3_vfs>,
    _name: CString,
    _window: Box<Window>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        // SAFETY: This allocation was registered once and still resides at the
        // same address. SQLite has already closed its only connection.
        unsafe { ffi::sqlite3_vfs_unregister(self.vfs.as_mut()) };
    }
}

/// Open a single image through an immutable range. The closure cannot retain
/// the database connection or let statements outlive the registered VFS.
pub(crate) fn with_database<T>(
    mut source: impl Read + Seek + Send + 'static,
    image_bytes: u64,
    cancellation: &Cancellation,
    verify: impl FnOnce(&Connection) -> Result<T, PortError>,
) -> Result<T, PortError> {
    check_header(
        &mut source,
        image_bytes,
        notarium_core::ports::MAX_BACKUP_SQLITE_IMAGE_BYTES,
    )?;
    check_cancelled(cancellation)?;
    let registration = register(source, image_bytes, cancellation.clone())?;
    let database = Connection::open_with_flags_and_vfs(
        "archive.sqlite",
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        registration._name.to_str().expect("ASCII VFS name"),
    )
    .map_err(sql_error)?;
    configure(&database, cancellation.clone())?;
    verify(&database)
}

fn check_header(source: &mut (impl Read + Seek), bytes: u64, limit: u64) -> Result<(), PortError> {
    if bytes < DB_HEADER_BYTES as u64 || bytes > limit {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    let mut header = [0; DB_HEADER_BYTES];
    source.seek(SeekFrom::Start(0)).map_err(io_error)?;
    source.read_exact(&mut header).map_err(io_error)?;
    let encoded_page_size = u16::from_be_bytes(header[16..18].try_into().unwrap());
    let page_size = if encoded_page_size == 1 {
        65_536
    } else {
        u64::from(encoded_page_size)
    };
    let pages = u64::from(u32::from_be_bytes(header[28..32].try_into().unwrap()));
    if &header[..16] != b"SQLite format 3\0"
        || header[18..20] != [1, 1]
        || !(512..=65_536).contains(&page_size)
        || !page_size.is_power_of_two()
        || pages == 0
        || pages.checked_mul(page_size) != Some(bytes)
    {
        return Err(invalid(ValidationReason::InvalidArchive));
    }
    // SQLite allocates a page-coverage bitmap for integrity_check. Limit that
    // native allocation independently of the connection page cache.
    if pages.div_ceil(8) > 3 * 1024 * 1024 {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    Ok(())
}

fn configure(database: &Connection, cancellation: Cancellation) -> Result<(), PortError> {
    // SAFETY: rusqlite retains exclusive ownership of this open connection, and
    // sqlite3_limit only updates its documented per-connection limits.
    unsafe {
        let conn = database.handle();
        ffi::sqlite3_limit(conn, ffi::SQLITE_LIMIT_LENGTH, MAX_VALUE_BYTES);
        ffi::sqlite3_limit(conn, ffi::SQLITE_LIMIT_SQL_LENGTH, 64 * 1024);
        ffi::sqlite3_limit(conn, ffi::SQLITE_LIMIT_ATTACHED, 0);
        ffi::sqlite3_limit(conn, ffi::SQLITE_LIMIT_COLUMN, 256);
        ffi::sqlite3_limit(conn, ffi::SQLITE_LIMIT_EXPR_DEPTH, 128);
        ffi::sqlite3_limit(conn, ffi::SQLITE_LIMIT_WORKER_THREADS, 0);
    }
    database
        .execute_batch(
            "PRAGMA trusted_schema=OFF;
         PRAGMA query_only=ON;
         PRAGMA temp_store=MEMORY;
         PRAGMA mmap_size=0;
         PRAGMA cache_size=-4096;
         PRAGMA cache_spill=OFF;",
        )
        .map_err(sql_error)?;
    database
        .progress_handler(2048, Some(move || cancellation.is_cancelled()))
        .map_err(sql_error)?;
    Ok(())
}

pub(crate) fn cap_verifier_heap(bytes: u64) -> Result<(), PortError> {
    // SAFETY: This entry point runs only in the isolated verifier child
    // before it opens any images. The caller validates the positive limit.
    let installed = unsafe {
        ffi::sqlite3_hard_heap_limit64(bytes as i64);
        ffi::sqlite3_hard_heap_limit64(-1)
    };
    if installed <= 0 || installed as u64 > bytes {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    Ok(())
}

pub(crate) fn sqlite_heap_peak() -> Result<u64, PortError> {
    let mut current = 0;
    let mut high = 0;
    // SAFETY: Both counters point to writable i64 values for this synchronous
    // SQLite telemetry call. No process-wide setting or high-water is changed.
    let status = unsafe {
        ffi::sqlite3_status64(ffi::SQLITE_STATUS_MEMORY_USED, &mut current, &mut high, 0)
    };
    if status != ffi::SQLITE_OK {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    Ok(high.max(0) as u64)
}

fn register(
    source: impl Read + Seek + Send + 'static,
    len: u64,
    cancellation: Cancellation,
) -> Result<Registration, PortError> {
    let name = CString::new(codec::new_prefixed_hex_id("archive_vfs_")?).expect("ASCII VFS name");
    let mut window = Box::new(Window {
        source: Mutex::new(Box::new(source)),
        len,
        cancellation,
    });
    // SAFETY: Null pointers and missing callbacks are valid values for the
    // optional fields in SQLite's version-1 VFS ABI.
    let mut vfs: Box<ffi::sqlite3_vfs> = Box::new(unsafe { std::mem::zeroed() });
    vfs.iVersion = 1;
    vfs.szOsFile = std::mem::size_of::<OpenFile>() as c_int;
    vfs.mxPathname = 64;
    vfs.zName = name.as_ptr();
    vfs.pAppData = ptr::from_mut(window.as_mut()).cast();
    vfs.xOpen = Some(open);
    vfs.xDelete = Some(delete);
    vfs.xAccess = Some(access);
    vfs.xFullPathname = Some(full_name);
    vfs.xRandomness = Some(random);
    vfs.xSleep = Some(sleep);
    vfs.xCurrentTime = Some(julian_time);
    // SAFETY: Both allocations and the C string remain pinned for the entire
    // registration. The VFS is named and never changes the default.
    if unsafe { ffi::sqlite3_vfs_register(vfs.as_mut(), 0) } != ffi::SQLITE_OK {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(Registration {
        vfs,
        _name: name,
        _window: window,
    })
}

static IO: ffi::sqlite3_io_methods = ffi::sqlite3_io_methods {
    iVersion: 1,
    xClose: Some(close),
    xRead: Some(read),
    xWrite: Some(reject_write),
    xTruncate: Some(reject_truncate),
    xSync: Some(sync),
    xFileSize: Some(file_size),
    xLock: Some(lock),
    xUnlock: Some(lock),
    xCheckReservedLock: Some(reserved),
    xFileControl: Some(file_control),
    xSectorSize: Some(sector_size),
    xDeviceCharacteristics: Some(device),
    xShmMap: None,
    xShmLock: None,
    xShmBarrier: None,
    xShmUnmap: None,
    xFetch: None,
    xUnfetch: None,
};

unsafe extern "C" fn open(
    vfs: *mut ffi::sqlite3_vfs,
    name: ffi::sqlite3_filename,
    file: *mut ffi::sqlite3_file,
    flags: c_int,
    out_flags: *mut c_int,
) -> c_int {
    // SAFETY: SQLite supplies aligned storage of szOsFile bytes for xOpen.
    unsafe { (*file).pMethods = ptr::null() };
    if name.is_null() || flags & ffi::SQLITE_OPEN_MAIN_DB == 0 || flags & ffi::SQLITE_OPEN_READONLY == 0
        || flags & (ffi::SQLITE_OPEN_CREATE | ffi::SQLITE_OPEN_READWRITE) != 0
        // SAFETY: A non-null SQLite filename is a NUL-terminated C string.
        || unsafe { CStr::from_ptr(name) } != NAME
    {
        return ffi::SQLITE_CANTOPEN;
    }
    // SAFETY: This registered VFS owns Window until the connection closes.
    // SQLite's optional out_flags pointer is writable when supplied.
    unsafe {
        file.cast::<OpenFile>().write(OpenFile {
            base: ffi::sqlite3_file { pMethods: &IO },
            owner: (*vfs).pAppData.cast(),
        });
        if !out_flags.is_null() {
            *out_flags = ffi::SQLITE_OPEN_READONLY;
        }
    }
    ffi::SQLITE_OK
}

unsafe extern "C" fn read(
    file: *mut ffi::sqlite3_file,
    data: *mut c_void,
    size: c_int,
    offset: i64,
) -> c_int {
    if size < 0 || offset < 0 || data.is_null() {
        return ffi::SQLITE_IOERR_READ;
    }
    // SAFETY: SQLite supplies a live OpenFile and a destination of size bytes
    // only while the synchronous callback is live. xOpen bound the owner.
    // Initialize the output before exposing it as a Rust slice to Read.
    let (window, dest) = unsafe {
        ptr::write_bytes(data.cast::<u8>(), 0, size as usize);
        (
            &*(*file.cast::<OpenFile>()).owner,
            std::slice::from_raw_parts_mut(data.cast::<u8>(), size as usize),
        )
    };
    catch_unwind(AssertUnwindSafe(|| {
        if window.cancellation.is_cancelled() {
            return ffi::SQLITE_INTERRUPT;
        }
        let count = window.len.saturating_sub(offset as u64).min(size as u64) as usize;
        if count > 0 {
            let Ok(mut source) = window.source.lock() else {
                return ffi::SQLITE_IOERR_READ;
            };
            if source
                .seek(SeekFrom::Start(offset as u64))
                .and_then(|_| source.read_exact(&mut dest[..count]))
                .is_err()
            {
                return ffi::SQLITE_IOERR_READ;
            }
        }
        if count < size as usize {
            ffi::SQLITE_IOERR_SHORT_READ
        } else {
            ffi::SQLITE_OK
        }
    }))
    .unwrap_or(ffi::SQLITE_IOERR_READ)
}

unsafe extern "C" fn close(_: *mut ffi::sqlite3_file) -> c_int {
    ffi::SQLITE_OK
}
unsafe extern "C" fn reject_write(
    _: *mut ffi::sqlite3_file,
    _: *const c_void,
    _: c_int,
    _: i64,
) -> c_int {
    ffi::SQLITE_READONLY
}
unsafe extern "C" fn reject_truncate(_: *mut ffi::sqlite3_file, _: i64) -> c_int {
    ffi::SQLITE_READONLY
}
unsafe extern "C" fn sync(_: *mut ffi::sqlite3_file, _: c_int) -> c_int {
    ffi::SQLITE_OK
}
unsafe extern "C" fn lock(_: *mut ffi::sqlite3_file, _: c_int) -> c_int {
    ffi::SQLITE_OK
}
unsafe extern "C" fn file_control(_: *mut ffi::sqlite3_file, _: c_int, _: *mut c_void) -> c_int {
    ffi::SQLITE_NOTFOUND
}
unsafe extern "C" fn sector_size(_: *mut ffi::sqlite3_file) -> c_int {
    4096
}
unsafe extern "C" fn device(_: *mut ffi::sqlite3_file) -> c_int {
    ffi::SQLITE_IOCAP_IMMUTABLE
}

unsafe extern "C" fn file_size(file: *mut ffi::sqlite3_file, size: *mut i64) -> c_int {
    // SAFETY: SQLite supplies a live file and an i64 output value. The window
    // length was validated below i64::MAX before registration.
    unsafe { *size = (*(*file.cast::<OpenFile>()).owner).len as i64 };
    ffi::SQLITE_OK
}
unsafe extern "C" fn reserved(_: *mut ffi::sqlite3_file, value: *mut c_int) -> c_int {
    // SAFETY: SQLite's xCheckReservedLock output is a writable c_int.
    unsafe { *value = 0 };
    ffi::SQLITE_OK
}
unsafe extern "C" fn delete(_: *mut ffi::sqlite3_vfs, _: *const c_char, _: c_int) -> c_int {
    ffi::SQLITE_READONLY
}
unsafe extern "C" fn access(
    _: *mut ffi::sqlite3_vfs,
    _: *const c_char,
    _: c_int,
    value: *mut c_int,
) -> c_int {
    // SAFETY: SQLite's xAccess output is a writable c_int.
    unsafe { *value = 0 };
    ffi::SQLITE_OK
}
unsafe extern "C" fn full_name(
    _: *mut ffi::sqlite3_vfs,
    name: *const c_char,
    cap: c_int,
    out: *mut c_char,
) -> c_int {
    if name.is_null() || cap < NAME.to_bytes_with_nul().len() as c_int
        // SAFETY: SQLite supplies a C string when the name argument is non-null.
        || unsafe { CStr::from_ptr(name) } != NAME
    {
        return ffi::SQLITE_CANTOPEN;
    }
    // SAFETY: cap was checked, the static name and SQLite output do not overlap.
    unsafe { ptr::copy_nonoverlapping(NAME.as_ptr(), out, NAME.to_bytes_with_nul().len()) };
    ffi::SQLITE_OK
}
unsafe extern "C" fn random(_: *mut ffi::sqlite3_vfs, cap: c_int, output: *mut c_char) -> c_int {
    if cap <= 0 || output.is_null() {
        return 0;
    }
    for offset in (0..cap as usize).step_by(32) {
        let Ok(sample) = codec::csprng_32() else {
            return 0;
        };
        let size = (cap as usize - offset).min(sample.len());
        // SAFETY: SQLite supplies cap writable bytes. This chunk is in bounds
        // and the stack sample cannot overlap SQLite's destination.
        unsafe { ptr::copy_nonoverlapping(sample.as_ptr(), output.cast::<u8>().add(offset), size) };
    }
    cap
}
unsafe extern "C" fn sleep(_: *mut ffi::sqlite3_vfs, micros: c_int) -> c_int {
    std::thread::sleep(std::time::Duration::from_micros(micros.max(0) as u64));
    micros.max(0)
}
unsafe extern "C" fn julian_time(_: *mut ffi::sqlite3_vfs, time: *mut f64) -> c_int {
    let Ok(value) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return 1;
    };
    // SAFETY: SQLite supplies a writable f64 output for xCurrentTime.
    unsafe { *time = 2_440_587.5 + value.as_secs_f64() / 86_400.0 };
    0
}

pub(crate) fn sql_error(error: rusqlite::Error) -> PortError {
    use rusqlite::ErrorCode;
    match error.sqlite_error_code() {
        Some(ErrorCode::OperationInterrupted | ErrorCode::OutOfMemory | ErrorCode::TooBig) => {
            invalid(ValidationReason::BudgetExceeded)
        }
        _ => invalid(ValidationReason::InvalidArchive),
    }
}
