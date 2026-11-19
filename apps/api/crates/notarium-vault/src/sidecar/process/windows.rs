#![allow(unsafe_code)]

use std::{
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::{null, null_mut},
};

use windows_sys::Win32::{
    Foundation::{
        DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_BROKEN_PIPE,
        ERROR_NO_MORE_FILES, ERROR_PIPE_NOT_CONNECTED, FILETIME, HANDLE, INVALID_HANDLE_VALUE,
        WAIT_TIMEOUT,
    },
    Storage::FileSystem::{FILE_TYPE_PIPE, GetFileType},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        },
        Pipes::PeekNamedPipe,
        Threading::{
            GetCurrentProcess, GetProcessTimes, OpenProcess, PROCESS_DUP_HANDLE,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, WaitForSingleObject,
        },
    },
};

pub(super) fn stdin_peer_open() -> io::Result<bool> {
    let input = io::stdin();
    let pipe = input.as_raw_handle();
    // SAFETY: The process keeps the stdin handle open for the call.
    if unsafe { GetFileType(pipe) } != FILE_TYPE_PIPE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected a sidecar lifecycle pipe",
        ));
    }
    // SAFETY: Called on the sole stdin reader before issuing the next blocking
    // read. All output pointers are documented optional when probing state.
    if unsafe { PeekNamedPipe(pipe, null_mut(), 0, null_mut(), null_mut(), null_mut()) } != 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    match error.raw_os_error().map(|code| code as u32) {
        Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED) => Ok(false),
        _ => Err(error),
    }
}

fn owned(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Only fresh owning handles from Win32 constructors reach this
    // helper. Invalid values and pseudo-handles are excluded.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn parent_pid() -> io::Result<u32> {
    // SAFETY: TH32CS_SNAPPROCESS ignores the PID. The snapshot is owned locally.
    let snapshot = owned(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })?;
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: The open snapshot and a correctly sized writable entry live
    // throughout enumeration.
    let mut found = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32ProcessID == std::process::id() {
            return Ok(entry.th32ParentProcessID);
        }
        // SAFETY: The same live snapshot and writable entry are reused.
        found = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "sidecar parent not found",
        ));
    }
    Err(error)
}

fn process_created_at(process: HANDLE) -> io::Result<u64> {
    let mut times = [FILETIME::default(); 4];
    let [created, exited, kernel, user] = &mut times;
    // SAFETY: The caller holds a queryable process handle. All four outputs
    // refer to independent writable FILETIME values for the duration of the call.
    if unsafe { GetProcessTimes(process, created, exited, kernel, user) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

/// Provisions a non-inheritable job handle in the actual launcher. Only the
/// launcher retains it after attachment, for its one-child process lifetime.
pub(super) fn attach_parent_job() -> io::Result<()> {
    let pid = parent_pid()?;
    // SAFETY: OpenProcess accepts an arbitrary PID and has no pointer inputs.
    let parent = owned(unsafe {
        OpenProcess(
            PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    })?;
    // SAFETY: GetCurrentProcess returns a pseudo-handle usable by this process.
    let this = unsafe { GetCurrentProcess() };
    let launched_after = process_created_at(parent.as_raw_handle())? > process_created_at(this)?;
    // SAFETY: The parent handle is live and has PROCESS_SYNCHRONIZE.
    let parent_alive = unsafe { WaitForSingleObject(parent.as_raw_handle(), 0) } == WAIT_TIMEOUT;
    if launched_after || !parent_alive {
        return Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "sidecar parent has exited",
        ));
    }

    // SAFETY: Null attributes create a non-inheritable handle. The unnamed job
    // cannot be reopened by name.
    let job = owned(unsafe { CreateJobObjectW(null(), null()) })?;
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: limits points to the typed information for the chosen class.
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }

    let mut launcher_job = null_mut();
    // SAFETY: Both process handles and the local source are live. launcher_job
    // receives a handle in the parent table, which is never used locally.
    if unsafe {
        DuplicateHandle(
            this,
            job.as_raw_handle(),
            parent.as_raw_handle(),
            &mut launcher_job,
            0,
            0,
            DUPLICATE_SAME_ACCESS,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: The job is held locally until attachment succeeds and the parent
    // copy is already installed. Closing the local copy then leaves one owner.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), this) } == 0 {
        let error = io::Error::last_os_error();
        let mut reclaimed = null_mut();
        // SAFETY: The source is our duplicate in the same opened parent table.
        // DUPLICATE_CLOSE_SOURCE closes the remote entry even on failure.
        if unsafe {
            DuplicateHandle(
                parent.as_raw_handle(),
                launcher_job,
                this,
                &mut reclaimed,
                0,
                0,
                DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE,
            )
        } != 0
        {
            drop(owned(reclaimed));
        }
        return Err(error);
    }
    Ok(())
}
