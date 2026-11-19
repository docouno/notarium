//! Windows bindings for held file identities, owner-only directories and atomic
//! namespace operations. The safe vault code supplies already validated names.
#![allow(unsafe_code)]

use std::{
    ffi::{OsStr, OsString, c_void},
    io,
    mem::{offset_of, size_of},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf, Prefix},
    ptr::{self, null, null_mut},
};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt};
use cap_std::fs::{Dir, File, Metadata, MetadataExt, OpenOptions, OpenOptionsExt};
use windows_sys::Win32::{
    Foundation::{
        ERROR_INVALID_FUNCTION, ERROR_NO_TOKEN, ERROR_NOT_SUPPORTED, ERROR_RM_NOT_ACTIVE,
        ERROR_SHARING_VIOLATION, ERROR_TRANSACTIONAL_CONFLICT,
        ERROR_TRANSACTIONS_UNSUPPORTED_REMOTE, GENERIC_READ, GENERIC_WRITE, HANDLE,
        INVALID_HANDLE_VALUE, LocalFree,
    },
    Security::{
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SE_FILE_OBJECT,
        },
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation,
        GetSecurityDescriptorControl, GetTokenInformation, INHERIT_ONLY_ACE, IsValidAcl,
        NO_PROPAGATE_INHERIT_ACE, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PSID,
        SE_DACL_PROTECTED, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{
        CommitTransaction, CreateDirectoryW, CreateFileTransactedW, CreateTransaction, DELETE,
        DeleteFileTransactedW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_FLAG_WRITE_THROUGH, FILE_ID_INFO, FILE_INFO_BY_HANDLE_CLASS, FILE_NAME_NORMALIZED,
        FILE_RENAME_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO,
        FileDispositionInfo, FileIdInfo, FileRenameInfo, FileStandardInfo,
        GetFileInformationByHandleEx, GetFinalPathNameByHandleW, OPEN_EXISTING, ReOpenFile,
        RollbackTransaction, SetFileInformationByHandle, VOLUME_NAME_DOS, VOLUME_NAME_GUID,
    },
    System::{
        Com::CoTaskMemFree,
        Threading::{GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken},
    },
    UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath},
};
use windows_sys::core::BOOL;

use super::{
    CapturedAt, FileIdentity, FileStamp, PublishMode, conflict, invalid, observe_open, present,
    same_file_content, stamp_from_file,
};

pub fn system_data_path() -> io::Result<PathBuf> {
    let mut next = null_mut();
    // SAFETY: The constant GUID and out pointer are valid. A null token selects
    // the current user. The returned buffer is freed by CoTaskMemFree.
    let result = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, null_mut(), &mut next) };
    if result < 0 || next.is_null() {
        return Err(io::Error::other(
            "could not resolve the LocalAppData known folder",
        ));
    }
    // SAFETY: A successful call returned a valid, terminated UTF-16 string.
    let directory = unsafe { os_string_from_pcwstr(next) };
    // SAFETY: The successful known-folder call allocated the buffer.
    unsafe {
        CoTaskMemFree(next.cast());
    }
    Ok(PathBuf::from(directory).join("Notarium"))
}

pub fn verify_prefix(prefix: Prefix<'_>) -> io::Result<()> {
    if matches!(prefix, Prefix::Disk(_) | Prefix::VerbatimDisk(_)) {
        return Ok(());
    }
    Err(invalid("desktop roots require a local drive path"))
}

pub fn create_private_dir(parent: &Dir, name: &OsStr) -> io::Result<()> {
    let parent = pinned_path(parent)?;
    let mut text = null_mut();
    let user = UserSid::get()?;
    // SAFETY: The token information owns a valid SID. The SID conversion
    // allocates a terminated buffer freed by LocalAllocation.
    succeeded(unsafe { ConvertSidToStringSidW(user.sid(), &mut text) })?;
    let text = LocalAllocation(text.cast());
    // SAFETY: Successful SID conversion returned a terminated UTF-16 value.
    let wide = unsafe { os_string_from_pcwstr(text.0.cast()) };
    let sid = wide
        .to_str()
        .ok_or_else(|| invalid("invalid Windows user SID"))?;
    let description = wide_z(OsStr::new(&format!("O:{sid}D:P(A;OICI;FA;;;{sid})")))?;
    let mut descriptor = null_mut();
    // SAFETY: Valid NUL-terminated descriptor text. The output is allocated
    // by LocalAlloc and remains live through the directory creation call.
    succeeded(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            description.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        )
    })?;
    let descriptor = LocalAllocation(descriptor);
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let path = wide_z(parent.join(name).as_os_str())?;
    // SAFETY: Path is terminated and derived from a live, non-delete-shared
    // parent capability. The descriptor and attribute pointers remain live.
    succeeded(unsafe { CreateDirectoryW(path.as_ptr(), &attributes) })
}

pub fn verify_private_dir(dir: &Dir) -> io::Result<()> {
    verify_directory_acl(dir, true)
}

pub fn verify_storage_dir(dir: &Dir) -> io::Result<()> {
    // Older installations may inherit their owner-only ACL from DataRoot.
    verify_directory_acl(dir, false)
}

fn verify_directory_acl(dir: &Dir, require_protected: bool) -> io::Result<()> {
    let user = UserSid::get()?;
    let mut owner = null_mut();
    let mut dacl = null_mut::<ACL>();
    let mut descriptor = null_mut();
    // SAFETY: The directory handle stays live. The result pointers live in
    // one LocalAlloc result buffer which is retained through all validation.
    let result = unsafe {
        GetSecurityInfo(
            dir.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let descriptor = LocalAllocation(descriptor);
    let mut control = 0;
    let mut revision = 0;
    let mut information = ACL_SIZE_INFORMATION::default();
    // SAFETY: Both SID pointers come from validated Windows buffers, and the
    // ACL and descriptor pointers came from the successful security query.
    unsafe {
        if owner.is_null()
            || EqualSid(owner, user.sid()) == 0
            || dacl.is_null()
            || IsValidAcl(dacl) == 0
        {
            return Err(unsafe_acl());
        }
        succeeded(GetSecurityDescriptorControl(
            descriptor.0,
            &mut control,
            &mut revision,
        ))?;
        if require_protected && control & SE_DACL_PROTECTED == 0 {
            return Err(unsafe_acl());
        }
        succeeded(GetAclInformation(
            dacl,
            ptr::from_mut(&mut information).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        ))?;
    }
    let mut directory_rights = 0;
    let mut child_file_rights = 0;
    let mut child_dir_rights = 0;
    for index in 0..information.AceCount {
        let mut raw_ace = null_mut();
        // SAFETY: The index is within the validated ACL. An ACE starts with
        // an aligned ACE_HEADER. Its allocation lives in the ACL buffer.
        unsafe {
            succeeded(GetAce(dacl, index, &mut raw_ace))?;
            let header = &*raw_ace.cast::<ACE_HEADER>();
            const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE
                || usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>()
            {
                return Err(unsafe_acl());
            }
            let ace = &*raw_ace.cast::<ACCESS_ALLOWED_ACE>();
            let sid_start = ptr::addr_of!(ace.SidStart).cast::<u8>();
            let sid_bytes = usize::from(header.AceSize) - offset_of!(ACCESS_ALLOWED_ACE, SidStart);
            const SID_HEADER_BYTES: usize = 8;
            if sid_bytes < SID_HEADER_BYTES
                || sid_bytes < SID_HEADER_BYTES + usize::from(*sid_start.add(1)) * 4
                || EqualSid(sid_start.cast_mut().cast(), user.sid()) == 0
            {
                return Err(unsafe_acl());
            }
            let flags = u32::from(header.AceFlags);
            if flags & INHERIT_ONLY_ACE == 0 {
                directory_rights |= ace.Mask;
            }
            if flags & NO_PROPAGATE_INHERIT_ACE == 0 {
                if flags & OBJECT_INHERIT_ACE != 0 {
                    child_file_rights |= ace.Mask;
                }
                if flags & CONTAINER_INHERIT_ACE != 0 {
                    child_dir_rights |= ace.Mask;
                }
            }
        }
    }
    if [directory_rights, child_file_rights, child_dir_rights]
        .into_iter()
        .any(|rights| rights & FILE_ALL_ACCESS != FILE_ALL_ACCESS)
    {
        return Err(unsafe_acl());
    }
    Ok(())
}

fn unsafe_acl() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "the desktop data directory requires a protected owner-only DACL",
    )
}

pub fn exclude_private_backup(_dir: &Dir, _path: &Path) -> io::Result<()> {
    Ok(())
}

pub fn open_child_dir(parent: &Dir, name: &OsStr) -> io::Result<Dir> {
    let child = parent.open_dir_nofollow(name)?;
    if is_link(&child.dir_metadata()?) {
        return Err(invalid("directory reparse point is not supported"));
    }
    verify_handle_name(&child, name)?;
    Ok(child)
}

pub fn directory_identity(dir: &Dir) -> io::Result<FileIdentity> {
    handle_identity(dir.as_raw_handle())
}

pub fn file_identity(file: &File, _metadata: &Metadata) -> io::Result<FileIdentity> {
    handle_identity(file.as_raw_handle())
}

pub fn link_count(file: &File, _metadata: &Metadata) -> io::Result<u64> {
    let mut info = FILE_STANDARD_INFO::default();
    query(file.as_raw_handle(), FileStandardInfo, &mut info)?;
    Ok(info.NumberOfLinks.into())
}

fn handle_identity(handle: HANDLE) -> io::Result<FileIdentity> {
    let mut info = FILE_ID_INFO::default();
    query(handle, FileIdInfo, &mut info)?;
    Ok(FileIdentity {
        volume: info.VolumeSerialNumber,
        file: u128::from_le_bytes(info.FileId.Identifier),
    })
}

fn query<T>(handle: HANDLE, class: FILE_INFO_BY_HANDLE_CLASS, info: &mut T) -> io::Result<()> {
    // SAFETY: Every call chooses the Windows data structure for its information
    // class. The handle and writable, appropriately aligned buffer are live.
    succeeded(unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            ptr::from_mut(info).cast(),
            size_of::<T>() as u32,
        )
    })
}

pub fn is_link(metadata: &Metadata) -> bool {
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

pub fn same_read_metadata(before: &Metadata, after: &Metadata) -> io::Result<bool> {
    Ok(before.len() == after.len()
        && before.last_write_time() == after.last_write_time()
        && before.file_attributes() == after.file_attributes())
}

pub fn still_names(parent: &Dir, name: &OsStr, file: &File) -> io::Result<bool> {
    let mut options = OpenOptions::new();
    options.access_mode(0).read(true).follow(FollowSymlinks::No);
    let Some(current) = present(parent.open_with(name, &options))? else {
        return Ok(false);
    };
    let actual = current.metadata()?;
    let opened = file.metadata()?;
    Ok(!is_link(&actual)
        && handle_identity(current.as_raw_handle())? == handle_identity(file.as_raw_handle())?
        && same_read_metadata(&opened, &actual)?)
}

pub fn require_same_mount(parent: &Dir, child: &Dir) -> io::Result<()> {
    check_volume(directory_identity(parent)?, directory_identity(child)?)
}

pub fn require_file_mount(parent: &Dir, file: &File) -> io::Result<()> {
    check_volume(
        directory_identity(parent)?,
        handle_identity(file.as_raw_handle())?,
    )
}

fn check_volume(parent: FileIdentity, child: FileIdentity) -> io::Result<()> {
    if parent.volume != child.volume {
        return Err(invalid("volume changed inside the vault"));
    }
    Ok(())
}

pub fn backing_path(dir: &Dir, _path: &Path) -> io::Result<PathBuf> {
    final_path(dir.as_raw_handle(), VOLUME_NAME_GUID)
}

pub fn verify_name(file: &File, name: &OsStr) -> io::Result<()> {
    verify_handle_name(file, name)
}

fn verify_handle_name(handle: &impl AsRawHandle, name: &OsStr) -> io::Result<()> {
    if final_path(handle.as_raw_handle(), VOLUME_NAME_DOS)?.file_name() != Some(name) {
        return Err(conflict(
            "the requested vault path aliases another filename",
        ));
    }
    Ok(())
}

pub fn set_stage_options(options: &mut OpenOptions) {
    options.custom_flags(FILE_FLAG_WRITE_THROUGH);
}

pub fn set_lock_options(options: &mut OpenOptions) {
    set_stage_options(options);
    options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE);
}

pub fn set_read_options(options: &mut OpenOptions) {
    // Obtaining the handle fails if a third party already opened it for writes.
    options.share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE);
}

pub fn set_metadata_options(options: &mut OpenOptions) {
    use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;
    options
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
}

pub fn sync_dir(dir: &Dir) -> io::Result<()> {
    // SAFETY: ReOpenFile reopens the exact held directory, with write access
    // for FlushFileBuffers. Its returned handle is owned by the Rust File.
    let handle = unsafe {
        ReOpenFile(
            dir.as_raw_handle(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            FILE_FLAG_BACKUP_SEMANTICS,
        )
    };
    let file = cap_file(handle)?;
    file.sync_all()
}

pub fn rename_no_replace(parent: &Dir, from: &OsStr, to: &OsStr) -> io::Result<()> {
    rename_no_replace_between(parent, from, parent, to)
}

pub fn rename_no_replace_between(
    source: &Dir,
    from: &OsStr,
    target: &Dir,
    to: &OsStr,
) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .access_mode(GENERIC_READ | DELETE)
        .share_mode(FILE_SHARE_READ)
        .follow(FollowSymlinks::No)
        .maybe_dir(true);
    let file = source.open_with(from, &options)?;
    if is_link(&file.metadata()?) {
        return Err(invalid("cannot rename a reparse point"));
    }
    require_file_mount(source, &file)?;
    rename_held(target, &file, to)
}

pub fn exchange_dirs(parent: &Dir, from: &OsStr, to: &OsStr) -> io::Result<()> {
    let transaction = Transaction::new()?;
    let source = transaction.open(parent, from, true)?;
    let target = transaction.open(parent, to, true)?;
    let mut scratch = from.to_owned();
    scratch.push("-exchange");
    rename_held(parent, &target, &scratch).map_err(transaction_issue)?;
    rename_held(parent, &source, to).map_err(transaction_issue)?;
    rename_held(parent, &target, from).map_err(transaction_issue)?;
    drop(target);
    drop(source);
    transaction.commit()
}

pub fn replace_existing(
    parent: &Dir,
    from: &OsStr,
    to: &OsStr,
    displaced: &OsStr,
    expected: &FileStamp,
    staged: &FileStamp,
    mode: PublishMode,
) -> io::Result<CapturedAt> {
    let transaction = Transaction::new()?;
    let mut source = transaction.open(parent, from, false)?;
    let mut target = transaction.open(parent, to, false)?;
    if !matches_open(&mut source, staged)? || !matches_open(&mut target, expected)? {
        return Ok(CapturedAt::Conflict);
    }

    // Both transacted handles identify the exact no-follow target and stage.
    // No data is copied, and all names are resolved relative to the pinned
    // directory. A failed write or comparison rolls back the entire exchange.
    rename_held(parent, &target, displaced).map_err(transaction_issue)?;
    rename_held(parent, &source, to).map_err(transaction_issue)?;
    drop(target);
    drop(source);

    let captured = if mode == PublishMode::Conversion {
        // The old plaintext name was never committed or visible. TxF journals
        // the namespace changes; the existing old inode is deleted at commit.
        transaction.delete(parent, displaced)?;
        CapturedAt::Absent
    } else {
        CapturedAt::Displaced
    };
    transaction.commit()?;
    Ok(captured)
}

fn rename_held(parent: &Dir, file: &File, name: &OsStr) -> io::Result<()> {
    // Win32 declares FileName as a trailing one-element flexible array.
    // A same-directory component is at most 255 UTF-16 code units.
    #[repr(C)]
    struct RenameBuffer {
        flags: u32,
        root_directory: HANDLE,
        file_name_length: u32,
        file_name: [u16; 256],
    }
    const _: () = assert!(
        offset_of!(RenameBuffer, root_directory) == offset_of!(FILE_RENAME_INFO, RootDirectory)
            && offset_of!(RenameBuffer, file_name_length)
                == offset_of!(FILE_RENAME_INFO, FileNameLength)
            && offset_of!(RenameBuffer, file_name) == offset_of!(FILE_RENAME_INFO, FileName)
    );
    let wide = wide_z(name)?;
    if wide.len() > 256 {
        return Err(invalid(
            "a Windows rename component exceeds its length limit",
        ));
    }
    let mut buffer = RenameBuffer {
        flags: 0,
        root_directory: parent.as_raw_handle(),
        file_name_length: ((wide.len() - 1) * size_of::<u16>()) as u32,
        file_name: [0; 256],
    };
    buffer.file_name[..wide.len()].copy_from_slice(&wide);
    // SAFETY: The supplied buffer matches the FILE_RENAME_INFO layout and
    // contains a terminated sibling name. Both live descriptors are held.
    succeeded(unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfo,
            ptr::from_ref(&buffer).cast(),
            size_of::<RenameBuffer>() as u32,
        )
    })
}

fn matches_open(file: &mut File, expected: &FileStamp) -> io::Result<bool> {
    let metadata = file.metadata()?;
    if metadata.len() != expected.size || link_count(file, &metadata)? != 1 {
        return Ok(false);
    }
    let max =
        usize::try_from(expected.size).map_err(|_| invalid("file size exceeds platform limit"))?;
    Ok(same_file_content(&observe_open(file, max)?.stamp, expected))
}

pub fn probe_conversion(parent: &Dir, from: &OsStr, to: &OsStr) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    set_stage_options(&mut options);
    let first = parent.open_with(from, &options)?;
    let first_stamp = stamp_from_file(&first, b"")?;
    first.sync_all()?;
    drop(first);
    let second = match parent.open_with(to, &options) {
        Ok(file) => file,
        Err(error) => {
            clean_slot(parent, from, &first_stamp)?;
            return Err(error);
        }
    };
    let second_stamp = stamp_from_file(&second, b"")?;
    second.sync_all()?;
    drop(second);

    let mut scratch_name = from.to_owned();
    scratch_name.push("-probe");
    let result = replace_existing(
        parent,
        from,
        to,
        &scratch_name,
        &second_stamp,
        &first_stamp,
        PublishMode::Conversion,
    );
    if matches!(result, Ok(CapturedAt::Absent)) {
        if !clean_slot(parent, to, &first_stamp)? {
            return Err(conflict("filesystem conversion probe result changed"));
        }
        return Ok(());
    }
    if !clean_slot(parent, from, &first_stamp)? || !clean_slot(parent, to, &second_stamp)? {
        return Err(conflict("filesystem conversion probe slots changed"));
    }
    result?;
    Err(conflict("filesystem did not support atomic conversion"))
}

pub fn clean_slot(parent: &Dir, name: &OsStr, expected: &FileStamp) -> io::Result<bool> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .access_mode(GENERIC_READ | DELETE)
        .share_mode(FILE_SHARE_READ)
        .follow(FollowSymlinks::No);
    let mut file = match parent.open_with(name, &options) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) => {
            return Ok(false);
        }
        Err(error) => return Err(error),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || is_link(&metadata)
        || handle_identity(file.as_raw_handle())? != expected.identity
        || link_count(&file, &metadata)? != 1
        || metadata.len() != expected.size
    {
        return Ok(false);
    }
    let max =
        usize::try_from(expected.size).map_err(|_| invalid("file size exceeds platform limit"))?;
    if !same_file_content(&observe_open(&mut file, max)?.stamp, expected) {
        return Ok(false);
    }

    let delete = FILE_DISPOSITION_INFO { DeleteFile: true };
    // SAFETY: This deletion targets the very handle verified above. No opens
    // for writing or deletion can coexist with this handle's sharing mode.
    succeeded(unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            ptr::from_ref(&delete).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    })?;
    drop(file);
    sync_dir(parent)?;
    Ok(true)
}

fn pinned_path(parent: &Dir) -> io::Result<PathBuf> {
    let directory = parent.dir_metadata()?;
    if is_link(&directory) {
        return Err(invalid("directory reparse point is not supported"));
    }
    final_path(parent.as_raw_handle(), VOLUME_NAME_DOS)
}

fn final_path(handle: HANDLE, volume: u32) -> io::Result<PathBuf> {
    const MAX_WINDOWS_PATH: usize = 32_767;
    let mut path = vec![0_u16; 512];
    loop {
        // SAFETY: The live handle and writable UTF-16 buffer are valid for
        // the advertised capacity. The call retains no pointers.
        let size = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                path.as_mut_ptr(),
                path.len() as u32,
                volume | FILE_NAME_NORMALIZED,
            )
        } as usize;
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        if size < path.len() {
            return Ok(PathBuf::from(OsString::from_wide(&path[..size])));
        }
        if size > MAX_WINDOWS_PATH {
            return Err(invalid("vault path exceeds the Windows path limit"));
        }
        path.resize(size + 1, 0);
    }
}

fn wide_z(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut wide: Vec<u16> = value.encode_wide().collect();
    if wide.contains(&0) || wide.len() >= 32_767 {
        return Err(invalid(
            "Windows path contains NUL or exceeds its length limit",
        ));
    }
    wide.push(0);
    Ok(wide)
}

unsafe fn os_string_from_pcwstr(value: *const u16) -> OsString {
    let mut length = 0;
    // SAFETY: The caller obtained a NUL-terminated Win32 string that remains
    // live throughout this call. The loop stops at its terminator.
    unsafe {
        while *value.add(length) != 0 {
            length += 1;
        }
        OsString::from_wide(std::slice::from_raw_parts(value, length))
    }
}

fn succeeded(result: BOOL) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn cap_file(handle: HANDLE) -> io::Result<File> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: Each caller passes ownership of a successful newly opened handle.
    Ok(File::from_std(unsafe {
        std::fs::File::from_raw_handle(handle)
    }))
}

#[derive(Debug)]
struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: Each instance owns one successful LocalAlloc result.
        unsafe {
            LocalFree(self.0);
        }
    }
}

struct UserSid(Vec<usize>);

impl UserSid {
    fn get() -> io::Result<Self> {
        let mut token = null_mut();
        // SAFETY: OpenThreadToken writes a token handle to the out pointer.
        if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_TOKEN as i32) {
                return Err(error);
            }
            // SAFETY: OpenProcessToken writes a token handle to the out pointer.
            succeeded(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
        }
        // SAFETY: One successful token open returned an owned, closeable handle.
        let token = unsafe { OwnedHandle::from_raw_handle(token) };
        let mut size = 0;
        // SAFETY: A length query deliberately supplies no buffer.
        unsafe {
            GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size);
        }
        if (size as usize) < size_of::<TOKEN_USER>() {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0_usize; (size as usize).div_ceil(size_of::<usize>())];
        // SAFETY: The buffer is aligned for TOKEN_USER and has at least size
        // bytes. Windows places a SID pointer into memory owned by this buffer.
        succeeded(unsafe {
            GetTokenInformation(
                token.as_raw_handle(),
                TokenUser,
                buffer.as_mut_ptr().cast(),
                size,
                &mut size,
            )
        })?;
        Ok(Self(buffer))
    }

    fn sid(&self) -> PSID {
        // SAFETY: The buffer was successfully filled with TOKEN_USER data.
        unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }
}

fn transaction_issue(error: io::Error) -> io::Error {
    match error.raw_os_error().map(|status| status as u32) {
        Some(
            ERROR_INVALID_FUNCTION
            | ERROR_NOT_SUPPORTED
            | ERROR_RM_NOT_ACTIVE
            | ERROR_TRANSACTIONS_UNSUPPORTED_REMOTE,
        ) => io::Error::new(
            io::ErrorKind::Unsupported,
            format!("the Windows volume does not support vault transactions: {error}"),
        ),
        Some(ERROR_SHARING_VIOLATION | ERROR_TRANSACTIONAL_CONFLICT) => {
            conflict("an external process holds the file needed by a vault transaction")
        }
        _ => error,
    }
}

struct Transaction(OwnedHandle);

impl Transaction {
    fn new() -> io::Result<Self> {
        // SAFETY: Null optional parameters request a default synchronous KTM
        // transaction with no inheritable attributes.
        let handle = unsafe { CreateTransaction(null_mut(), null_mut(), 0, 0, 0, 0, null()) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            return Err(transaction_issue(io::Error::last_os_error()));
        }
        // SAFETY: Ownership transfers from the successful CreateTransaction.
        Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle) }))
    }

    fn open(&self, parent: &Dir, name: &OsStr, directory: bool) -> io::Result<File> {
        let path = wide_z(pinned_path(parent)?.join(name).as_os_str())?;
        // SAFETY: The terminated path comes from the pinned parent. A writer
        // handle obtains a transactional lock. No writes are issued against the
        // file's content, and final-component reparse points are not followed.
        let handle = unsafe {
            CreateFileTransactedW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE | DELETE,
                FILE_SHARE_READ | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
                self.0.as_raw_handle(),
                null(),
                null(),
            )
        };
        let file = cap_file(handle).map_err(transaction_issue)?;
        let metadata = file.metadata()?;
        if is_link(&metadata)
            || if directory {
                !metadata.is_dir()
            } else {
                !metadata.is_file()
            }
        {
            return Err(invalid(
                "transactional entry is not the expected regular type",
            ));
        }
        require_file_mount(parent, &file)?;
        verify_name(&file, name)?;
        Ok(file)
    }

    fn delete(&self, parent: &Dir, name: &OsStr) -> io::Result<()> {
        let path = wide_z(pinned_path(parent)?.join(name).as_os_str())?;
        // SAFETY: A terminated sibling path in the held parent and a live
        // transaction are used. The locked namespace entry was already moved
        // to this name inside the same transaction.
        succeeded(unsafe { DeleteFileTransactedW(path.as_ptr(), self.0.as_raw_handle()) })
            .map_err(transaction_issue)
    }

    fn commit(self) -> io::Result<()> {
        // SAFETY: The transaction owns its handle and no transacted file
        // handles remain at commit.
        succeeded(unsafe { CommitTransaction(self.0.as_raw_handle()) }).map_err(transaction_issue)
    }
}

impl Drop for Transaction {
    fn drop(&mut self) {
        // SAFETY: This rollback releases any uncommitted namespace changes.
        // It has no effect if the transaction was already committed.
        unsafe {
            RollbackTransaction(self.0.as_raw_handle());
        }
    }
}
