use std::{
    env,
    ffi::OsStr,
    io,
    path::{Path, PathBuf, Prefix},
};

use cap_fs_ext::{
    DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsMaybeDirExt,
    OpenOptionsSyncExt,
};
use cap_std::fs::{Dir, DirBuilder, DirBuilderExt, File, Metadata, OpenOptions, OpenOptionsExt};
use rustix::fs::{RenameFlags, renameat_with};

use super::recovery::ParkAction;
use super::{CapturedAt, FileIdentity, FileStamp, PublishMode, conflict, invalid};
#[cfg(target_os = "linux")]
use super::{observe_open, same_file_content};

pub fn system_data_path() -> io::Result<PathBuf> {
    #[cfg(not(target_os = "macos"))]
    if let Some(directory) = env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        let directory = PathBuf::from(directory);
        if !directory.is_absolute() {
            return Err(invalid("XDG_DATA_HOME must be absolute"));
        }
        return Ok(directory.join("notarium"));
    }

    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| invalid("HOME must name an absolute directory"))?;
    #[cfg(target_os = "macos")]
    let path = home.join("Library/Application Support/ai.notarium.desktop");
    #[cfg(not(target_os = "macos"))]
    let path = home.join(".local/share/notarium");
    Ok(path)
}

pub fn verify_prefix(_prefix: Prefix<'_>) -> io::Result<()> {
    Err(invalid("unexpected device prefix in desktop root"))
}

pub fn create_private_dir(parent: &Dir, name: &OsStr) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.mode(0o700);
    parent.create_dir_with(name, &builder)
}

pub fn verify_private_dir(dir: &Dir) -> io::Result<()> {
    use cap_std::fs::MetadataExt as _;
    let info = dir.dir_metadata()?;
    if info.uid() != rustix::process::geteuid().as_raw() || info.mode() & 0o7777 != 0o700 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the desktop data directory must be owned by the current user and have mode 0700",
        ));
    }
    #[cfg(target_os = "macos")]
    apple::verify_private_acl(dir, false)?;
    Ok(())
}

pub fn verify_private_ancestor(dir: &Dir) -> io::Result<()> {
    use cap_std::fs::MetadataExt as _;
    let info = dir.dir_metadata()?;
    let mode = info.mode();
    let trusted_owner = info.uid() == 0 || info.uid() == rustix::process::geteuid().as_raw();
    // Under a trusted sticky directory (such as /tmp), another user cannot
    // replace a child owned by us. Non-sticky writable ancestors lack that
    // protection for the ambient path later used by SQLite.
    if !trusted_owner || (mode & 0o022 != 0 && mode & 0o1000 == 0) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the desktop data directory has a replaceable ancestor",
        ));
    }
    #[cfg(target_os = "macos")]
    apple::verify_private_acl(dir, true)?;
    Ok(())
}

pub fn verify_storage_dir(dir: &Dir) -> io::Result<()> {
    use cap_std::fs::MetadataExt as _;
    let info = dir.dir_metadata()?;
    if info.uid() != rustix::process::geteuid().as_raw() || info.mode() & 0o022 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the private SQLite directory must be owned and writable only by the current user",
        ));
    }
    #[cfg(target_os = "macos")]
    apple::verify_private_acl(dir, true)?;
    Ok(())
}

pub fn exclude_private_backup(dir: &Dir, path: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    apple::exclude_backup(dir, path)?;
    #[cfg(not(target_os = "macos"))]
    let _ = (dir, path);
    Ok(())
}

pub fn directory_identity(dir: &Dir) -> io::Result<FileIdentity> {
    Ok(identity(&dir.dir_metadata()?))
}

pub fn open_child_dir(parent: &Dir, name: &OsStr) -> io::Result<Dir> {
    let child = parent.open_dir_nofollow(name)?;
    if !directory_name_matches(&child, name)? {
        return Err(conflict(
            "the requested vault path aliases another directory name",
        ));
    }
    Ok(child)
}

pub fn directory_name_matches(dir: &Dir, requested: &OsStr) -> io::Result<bool> {
    exact_name(dir, requested)
}

pub fn file_name_matches(file: &File, requested: &OsStr) -> io::Result<bool> {
    exact_name(file, requested)
}

fn exact_name(object: &impl std::os::fd::AsRawFd, requested: &OsStr) -> io::Result<bool> {
    #[cfg(target_os = "macos")]
    let actual = apple::physical_path(object)?;
    #[cfg(target_os = "linux")]
    let actual = linux::physical_path(object)?;
    Ok(actual.file_name() == Some(requested))
}

pub fn is_link(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

pub fn file_identity(_file: &File, metadata: &Metadata) -> io::Result<FileIdentity> {
    Ok(identity(metadata))
}

pub fn link_count(_file: &File, metadata: &Metadata) -> io::Result<u64> {
    Ok(metadata.nlink())
}

pub fn same_read_metadata(before: &Metadata, after: &Metadata) -> io::Result<bool> {
    use cap_std::fs::MetadataExt as _;
    Ok(before.len() == after.len()
        && before.mtime() == after.mtime()
        && before.mtime_nsec() == after.mtime_nsec()
        && before.ctime() == after.ctime()
        && before.ctime_nsec() == after.ctime_nsec())
}

pub fn still_names(parent: &Dir, name: &OsStr, file: &File) -> io::Result<bool> {
    let actual = match parent.symlink_metadata(name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        result => result?,
    };
    let opened = file.metadata()?;
    Ok(actual.is_file()
        && actual.nlink() == 1
        && identity(&actual) == identity(&opened)
        && same_read_metadata(&opened, &actual)?)
}

fn identity(metadata: &Metadata) -> FileIdentity {
    FileIdentity {
        volume: metadata.dev(),
        file: metadata.ino().into(),
    }
}

pub fn require_same_mount(parent: &Dir, child: &Dir) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    let same_mount = linux::mount_id(parent)? == linux::mount_id(child)?;
    #[cfg(not(target_os = "linux"))]
    let same_mount = parent.dir_metadata()?.dev() == child.dir_metadata()?.dev();

    if !same_mount {
        return Err(invalid("nested mount inside the vault"));
    }
    Ok(())
}

pub fn require_file_mount(parent: &Dir, file: &File) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    let same_mount = linux::mount_id(parent)? == linux::mount_id(file)?;
    #[cfg(not(target_os = "linux"))]
    let same_mount = parent.dir_metadata()?.dev() == file.metadata()?.dev();

    if !same_mount {
        return Err(invalid("mounted file inside the vault"));
    }
    Ok(())
}

pub fn backing_path(dir: &Dir, path: &Path) -> io::Result<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let _ = path;
        linux::backing_path(dir)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = dir;
        Ok(path.to_owned())
    }
}

pub fn set_stage_options(options: &mut OpenOptions) {
    options.mode(0o600);
}

pub fn set_lock_options(options: &mut OpenOptions) {
    set_stage_options(options);
}

pub fn set_read_options(_options: &mut OpenOptions) {}

pub fn set_metadata_options(_options: &mut OpenOptions) {}

pub fn set_private_metadata_options(options: &mut OpenOptions) {
    set_metadata_options(options);
}

pub fn verify_private_file(_file: &File) -> io::Result<()> {
    Ok(())
}

pub fn open_existing_lock(dir: &Dir, name: &OsStr, checked: &File) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .nonblock(true)
        .follow(FollowSymlinks::No);
    set_lock_options(&mut options);
    let file = dir.open_with(name, &options)?;
    if identity(&file.metadata()?) != identity(&checked.metadata()?) {
        return Err(conflict(
            "sidecar lock changed before its handle was acquired",
        ));
    }
    Ok(file)
}

pub fn verify_name(file: &File, requested: &OsStr) -> io::Result<()> {
    if !file_name_matches(file, requested)? {
        return Err(conflict(
            "the requested vault path aliases another filename",
        ));
    }
    Ok(())
}

pub fn sync_dir(dir: &Dir) -> io::Result<()> {
    // An O_PATH capability is sufficient for traversal and rename. Reopen the
    // exact pinned directory for its durability barrier.
    dir.open_with(".", OpenOptions::new().read(true).maybe_dir(true))?
        .sync_all()
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
    renameat_with(source, from, target, to, RenameFlags::NOREPLACE).map_err(Into::into)
}

pub fn park_private_capture(
    source: &Dir,
    from: &OsStr,
    target: &Dir,
    to: &OsStr,
    _expected: Option<&FileStamp>,
) -> io::Result<ParkAction> {
    rename_no_replace_between(source, from, target, to)?;
    Ok(ParkAction::Relocated)
}

pub fn verify_parked_capture(_dir: &Dir, _name: &OsStr) -> io::Result<()> {
    // POSIX traversal of the private recovery directory already excludes
    // other accounts.
    Ok(())
}

pub fn exchange_dirs(parent: &Dir, from: &OsStr, to: &OsStr) -> io::Result<()> {
    // These names alone are swapped. The exchange does not resolve either as a link.
    renameat_with(parent, from, parent, to, RenameFlags::EXCHANGE).map_err(Into::into)
}

pub fn replace_existing(
    parent: &Dir,
    from: &OsStr,
    to: &OsStr,
    _displaced: &OsStr,
    _expected: &FileStamp,
    _staged: &FileStamp,
    _mode: PublishMode,
) -> io::Result<CapturedAt> {
    exchange_dirs(parent, from, to)?;
    Ok(CapturedAt::Stage)
}

pub fn probe_conversion(parent: &Dir, from: &OsStr, to: &OsStr) -> io::Result<()> {
    // Both names are private probes. No untrusted process can replace their
    // directory entries through the shared vault namespace.
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .follow(FollowSymlinks::No);
    set_stage_options(&mut options);
    let first = parent.open_with(from, &options)?;
    let second = match parent.open_with(to, &options) {
        Ok(file) => file,
        Err(error) => {
            if still_names(parent, from, &first)? {
                parent.remove_file(from)?;
                sync_dir(parent)?;
            }
            return Err(error);
        }
    };

    let swapped = exchange_dirs(parent, from, to);
    let (first_name, second_name) = if swapped.is_ok() {
        (to, from)
    } else {
        (from, to)
    };
    if !still_names(parent, first_name, &first)? || !still_names(parent, second_name, &second)? {
        return Err(conflict("filesystem conversion probe slots changed"));
    }
    parent.remove_file(first_name)?;
    parent.remove_file(second_name)?;
    sync_dir(parent)?;
    swapped
}

#[cfg(target_os = "macos")]
pub fn clean_slot(parent: &Dir, name: &OsStr, _expected: &FileStamp) -> io::Result<bool> {
    // An ordinary process cannot acquire a Darwin file lease. An editor can
    // still hold the captured inode writable after the namespace exchange.
    // Keep that inode and the durable conflict until explicit resolution.
    match parent.symlink_metadata(name) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
pub fn clean_slot(parent: &Dir, name: &OsStr, expected: &FileStamp) -> io::Result<bool> {
    // The caller has already relocated the inode into the verified private
    // recovery directory. The lease excludes users of the captured inode.
    let mut options = OpenOptions::new();
    options.read(true).nonblock(true).follow(FollowSymlinks::No);
    let mut file = match parent.open_with(name, &options) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        result => result?,
    };
    let info = file.metadata()?;
    if !info.is_file() || identity(&info) != expected.identity || info.nlink() != 1 {
        return Ok(false);
    }

    if !linux::try_read_lease(&file)? {
        return Ok(false);
    }

    let max =
        usize::try_from(expected.size).map_err(|_| invalid("file size exceeds platform limit"))?;
    if info.len() != expected.size
        || !same_file_content(&observe_open(&mut file, max)?.stamp, expected)
        || !still_names(parent, name, &file)?
    {
        return Ok(false);
    }
    if !linux::read_lease_intact(&file)? {
        return Ok(false);
    }
    parent.remove_file(name)?;
    sync_dir(parent)?;
    Ok(true)
}

#[cfg(target_os = "linux")]
#[allow(unsafe_code)]
mod linux {
    use super::*;
    use rustix::{
        fd::AsFd,
        fs::{AtFlags, StatxFlags, statx},
    };
    use std::{
        ffi::OsString,
        os::{fd::AsRawFd, unix::ffi::OsStringExt},
    };

    pub fn mount_id(descriptor: impl AsFd) -> io::Result<u64> {
        match statx(&descriptor, "", AtFlags::EMPTY_PATH, StatxFlags::MNT_ID) {
            Ok(info) if info.stx_mask & StatxFlags::MNT_ID.bits() != 0 => {
                return Ok(info.stx_mnt_id);
            }
            Ok(_) | Err(rustix::io::Errno::NOSYS | rustix::io::Errno::INVAL) => {}
            Err(error) => return Err(error.into()),
        }
        // fdinfo supplies a pinned mount ID on kernels whose statx predates
        // STATX_MNT_ID. Fail closed if neither source can prove the identity.
        let info = std::fs::read_to_string(format!(
            "/proc/self/fdinfo/{}",
            descriptor.as_fd().as_raw_fd()
        ))?;
        info.lines()
            .find_map(|line| line.strip_prefix("mnt_id:"))
            .and_then(|id| id.trim().parse().ok())
            .ok_or_else(incomplete_mount_info)
    }

    pub fn physical_path(descriptor: &impl AsRawFd) -> io::Result<PathBuf> {
        std::fs::read_link(format!("/proc/self/fd/{}", descriptor.as_raw_fd()))
    }

    pub fn backing_path(dir: &Dir) -> io::Result<PathBuf> {
        let mount = mount_id(dir)?.to_string();
        let current = physical_path(dir)?;
        let mount_info = std::fs::read("/proc/self/mountinfo")?;
        for line in mount_info.split(|byte| *byte == b'\n') {
            let mut fields = line.split(|byte| *byte == b' ');
            if fields.next() != Some(mount.as_bytes()) {
                continue;
            }
            // mountinfo exposes the volume-relative mount root, including bind
            // mount aliases that do not appear in lexical path components.
            let mount_root = decode(fields.nth(2).ok_or_else(incomplete_mount_info)?)?;
            let mount_point = decode(fields.next().ok_or_else(incomplete_mount_info)?)?;
            let relative = current
                .strip_prefix(mount_point)
                .map_err(|_| incomplete_mount_info())?;
            return Ok(PathBuf::from(mount_root).join(relative));
        }
        Err(incomplete_mount_info())
    }

    fn decode(raw: &[u8]) -> io::Result<OsString> {
        let mut out = Vec::with_capacity(raw.len());
        let mut bytes = raw.iter().copied();
        while let Some(byte) = bytes.next() {
            if byte != b'\\' {
                out.push(byte);
                continue;
            }
            let octet =
                std::array::from_fn::<_, 3, _>(|_| bytes.next().and_then(|x| x.checked_sub(b'0')));
            let [Some(a @ 0..=3), Some(b @ 0..=7), Some(c @ 0..=7)] = octet else {
                return Err(incomplete_mount_info());
            };
            out.push(a * 64 + b * 8 + c);
        }
        Ok(OsString::from_vec(out))
    }

    fn incomplete_mount_info() -> io::Error {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "cannot verify the backing mount of a desktop directory",
        )
    }

    pub fn try_read_lease(file: &File) -> io::Result<bool> {
        // Linux fcntl UAPI F_SETSIG from asm-generic/fcntl.h. Desktop Linux
        // targets use this UAPI on x86 and ARM. SIGURG has an ignore default,
        // unlike SIGIO, and is reserved here for the short lease lifetime.
        const F_SETSIG: libc::c_int = 10;
        let fd = file.as_raw_fd();
        // SAFETY: The opened file borrows a live descriptor. These fcntl
        // commands take promoted integer arguments and retain no pointers.
        let result = unsafe {
            if libc::fcntl(fd, F_SETSIG, libc::SIGURG) < 0 {
                return Err(io::Error::last_os_error());
            }
            libc::fcntl(fd, libc::F_SETLEASE, libc::F_RDLCK)
        };
        if result == 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            // A writer, remote filesystem or a foreign inode owner is never
            // proof that the captured file is safe to remove.
            Some(
                libc::EAGAIN
                | libc::EACCES
                | libc::EPERM
                | libc::ENOSYS
                | libc::EOPNOTSUPP
                | libc::EINVAL,
            ) => Ok(false),
            _ => Err(error),
        }
    }

    pub fn read_lease_intact(file: &File) -> io::Result<bool> {
        // SAFETY: F_GETLEASE uses the live descriptor and has no third argument.
        let result = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLEASE) };
        if result < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(result == libc::F_RDLCK)
    }
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod apple {
    use super::*;
    use std::{
        ffi::{CStr, OsStr},
        os::{fd::AsRawFd, unix::ffi::OsStrExt},
        process::Command,
    };

    pub fn physical_path(file: &impl AsRawFd) -> io::Result<PathBuf> {
        let mut path = [0; libc::PATH_MAX as usize];
        // SAFETY: F_GETPATH writes a terminated path of at most PATH_MAX
        // bytes into the supplied stack buffer, using a live file descriptor.
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, path.as_mut_ptr()) } < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: On success F_GETPATH wrote a NUL-terminated path.
        let path = unsafe { CStr::from_ptr(path.as_ptr()) };
        Ok(PathBuf::from(OsStr::from_bytes(path.to_bytes())))
    }

    pub fn verify_private_acl(dir: &Dir, permit_denials: bool) -> io::Result<()> {
        // Darwin's extended ACL can grant access even with 0700 mode.
        const ACL_TYPE_EXTENDED: libc::c_int = 0x100;
        const ACL_FIRST_ENTRY: libc::c_int = 0;
        const ACL_NEXT_ENTRY: libc::c_int = -1;
        const ACL_EXTENDED_DENY: libc::c_int = 2;

        unsafe extern "C" {
            fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut libc::c_void;
            fn acl_get_entry(
                acl: *mut libc::c_void,
                entry_id: libc::c_int,
                entry: *mut *mut libc::c_void,
            ) -> libc::c_int;
            fn acl_get_tag_type(entry: *mut libc::c_void, tag: *mut libc::c_int) -> libc::c_int;
            fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
        }

        struct Acl(*mut libc::c_void);
        impl Drop for Acl {
            fn drop(&mut self) {
                // SAFETY: Owns a non-null allocation returned by acl_get_fd_np.
                unsafe {
                    acl_free(self.0);
                }
            }
        }

        // SAFETY: The descriptor remains live. ACL API results are owned by
        // this function and released exactly once with acl_free.
        unsafe {
            let acl = acl_get_fd_np(dir.as_raw_fd(), ACL_TYPE_EXTENDED);
            if acl.is_null() {
                let err = io::Error::last_os_error();
                return if err.raw_os_error() == Some(libc::ENOENT) {
                    Ok(())
                } else {
                    Err(err)
                };
            }
            let acl = Acl(acl);
            let mut index = ACL_FIRST_ENTRY;
            let mut entry = std::ptr::null_mut();
            while acl_get_entry(acl.0, index, &mut entry) == 0 {
                let mut tag = 0;
                if permit_denials && acl_get_tag_type(entry, &mut tag) != 0 {
                    return Err(io::Error::last_os_error());
                }
                if permit_denials && tag == ACL_EXTENDED_DENY {
                    index = ACL_NEXT_ENTRY;
                    continue;
                }
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "the desktop data path has an unsafe macOS extended ACL",
                ));
            }
            let err = io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::EINVAL) {
                Ok(())
            } else {
                Err(err)
            }
        }
    }

    pub fn exclude_backup(dir: &Dir, selected: &Path) -> io::Result<()> {
        let file = dir.open_with(".", OpenOptions::new().read(true).maybe_dir(true))?;
        let actual = physical_path(&file)?;
        if &actual != selected || std::fs::canonicalize(selected)? != actual {
            return Err(invalid(
                "desktop data directory changed before backup exclusion",
            ));
        }
        let tool = "/usr/bin/tmutil";
        let add = Command::new(tool)
            .arg("addexclusion")
            .arg(selected)
            .env("LC_ALL", "C")
            .output()?;
        let read = Command::new(tool)
            .arg("isexcluded")
            .arg(selected)
            .env("LC_ALL", "C")
            .output()?;
        if !add.status.success()
            || !read.status.success()
            || !read.stdout.starts_with(b"[Excluded]")
            || physical_path(&file)? != actual
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Time Machine exclusion could not be applied and verified",
            ));
        }
        Ok(())
    }
}
