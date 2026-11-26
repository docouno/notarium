use std::{
    io,
    path::{Path, PathBuf},
};

use crate::{
    filesystem::{CapturedFile, FileStamp, Publication, PublishMode, VaultDir, Withdrawal},
    journal::{Action, DesiredFile, Intent, Journal, PublishAction, PublishPurpose},
    paths::digest,
};

/// Constrain each file read independently of the event queue and SQL writer.
pub(crate) const MAX_NOTE_BYTES: usize = 8 * 1024 * 1024;

pub(crate) enum Placement {
    Applied {
        stamp: FileStamp,
        captured: Option<CapturedFile>,
    },
    Conflict(Option<PathBuf>),
}

/// Start with a durable intent even for no-replace creation. A filename slot
/// is never derived from a user's requested name.
pub(crate) fn plan(
    journal: &Journal,
    target: PathBuf,
    expected: Option<FileStamp>,
    desired: DesiredFile,
    purpose: PublishPurpose,
    retire: Option<(PathBuf, FileStamp)>,
) -> io::Result<Intent> {
    journal.intent(
        target,
        Action::Publish(Box::new(PublishAction {
            desired,
            purpose,
            expected,
            staged: None,
            retire,
            abandoned: false,
        })),
    )
}

pub(crate) fn place(
    vault: &VaultDir,
    journal: &Journal,
    intent: &mut Intent,
    bytes: &[u8],
) -> io::Result<Placement> {
    let slot = slot(intent)?;
    let target = &intent.target;
    let Action::Publish(action) = &mut intent.action else {
        return Err(invalid());
    };
    let PublishAction {
        desired,
        purpose,
        expected,
        staged,
        abandoned,
        ..
    } = action.as_mut();
    if *abandoned || digest(bytes) != desired.disk_digest {
        return Err(invalid());
    }
    let displaced = VaultDir::displaced_slot(&slot)?;
    let Some(stage) = staged else {
        if vault.entry_kind(&slot)?.is_some() || vault.entry_kind(&displaced)?.is_some() {
            // The record was durable but the staged object's fingerprint was
            // not. Preserve the unproven object for explicit resolution.
            return Ok(Placement::Conflict(first_present(
                vault,
                [&slot, &displaced],
            )?));
        }
        if expected.is_none() && vault.entry_kind(target)?.is_some() {
            return Ok(Placement::Conflict(None));
        }
        if let Some(dir) = target.parent() {
            vault.create_dir_all(dir)?;
        }
        let stamp = vault.stage(target, &slot, bytes)?;
        *staged = Some(stamp);
        journal.save(intent)?;
        return place(vault, journal, intent, bytes);
    };
    if let Some(applied) =
        already_published(vault, target, stage, expected.as_ref(), [&slot, &displaced])?
    {
        return Ok(applied);
    }
    let mode = match purpose {
        PublishPurpose::Conversion => PublishMode::Conversion,
        _ => PublishMode::Regular,
    };
    match vault.publish(target, &slot, expected.as_ref(), stage, mode)? {
        Publication::Applied {
            published,
            displaced,
        } => Ok(Placement::Applied {
            stamp: published,
            captured: displaced,
        }),
        Publication::Conflict => {
            let preserved = capture_if_changed(vault, &slot, &displaced, stage)?;
            Ok(Placement::Conflict(preserved))
        }
    }
}

pub(crate) fn recover_published(
    vault: &VaultDir,
    intent: &Intent,
) -> io::Result<Option<Placement>> {
    let Action::Publish(action) = &intent.action else {
        return Ok(None);
    };
    let PublishAction {
        staged: Some(staged),
        expected,
        ..
    } = action.as_ref()
    else {
        return Ok(None);
    };
    let slot = slot(intent)?;
    let displaced = VaultDir::displaced_slot(&slot)?;
    already_published(
        vault,
        &intent.target,
        staged,
        expected.as_ref(),
        [&slot, &displaced],
    )
}

/// A newer canonical head alone carries no evidence about the namespace.
/// The old name and both slots must still describe an unapplied operation.
pub(crate) fn is_unapplied(vault: &VaultDir, intent: &Intent) -> io::Result<bool> {
    let Action::Publish(action) = &intent.action else {
        return Err(invalid());
    };
    match (
        &action.expected,
        vault.read(&intent.target, MAX_NOTE_BYTES)?,
    ) {
        (None, None) => {}
        (Some(expected), Some(actual)) if same(expected, &actual.stamp) => {}
        _ => return Ok(false),
    }
    let stage = slot(intent)?;
    let displaced = VaultDir::displaced_slot(&stage)?;
    if vault.entry_kind(&displaced)?.is_some()
        || vault.recovered_capture(&displaced)?.is_some()
        || vault.recovered_capture(&stage)?.is_some()
    {
        return Ok(false);
    }
    if let Some(expected) = &action.staged
        && let Some(actual) = vault.read(&stage, MAX_NOTE_BYTES)?
    {
        return Ok(same(expected, &actual.stamp));
    }
    Ok(true)
}

fn already_published(
    vault: &VaultDir,
    target: &Path,
    staged: &FileStamp,
    expected: Option<&FileStamp>,
    capture_slots: [&Path; 2],
) -> io::Result<Option<Placement>> {
    let Some(current) = vault.read(target, MAX_NOTE_BYTES)? else {
        return Ok(None);
    };
    if !same(&current.stamp, staged) {
        return Ok(None);
    }
    let mut captured = None;
    for path in capture_slots {
        if let Some(file) = vault.read(path, MAX_NOTE_BYTES)? {
            if captured.is_some() || !expected.is_some_and(|old| same(old, &file.stamp)) {
                return Ok(Some(Placement::Conflict(Some(path.to_owned()))));
            }
            captured = Some(CapturedFile {
                path: path.to_owned(),
                stamp: file.stamp,
            });
        } else if let Some(recovered) = vault.recovered_capture(path)? {
            let Some(expected) = expected.filter(|_| captured.is_none()) else {
                return Ok(Some(Placement::Conflict(Some(recovered))));
            };
            captured = Some(CapturedFile {
                path: path.to_owned(),
                stamp: expected.clone(),
            });
        }
    }
    // A restart can see the new name before the namespace commit was
    // flushed. Make the recovered name durable before recording its stamp.
    vault.sync_parent(target)?;
    Ok(Some(Placement::Applied {
        stamp: current.stamp,
        captured,
    }))
}

fn capture_if_changed(
    vault: &VaultDir,
    slot: &Path,
    displaced: &Path,
    stage: &FileStamp,
) -> io::Result<Option<PathBuf>> {
    if vault.entry_kind(displaced)?.is_some() {
        return Ok(Some(displaced.to_owned()));
    }
    match vault.read(slot, MAX_NOTE_BYTES)? {
        Some(file) if !same(&file.stamp, stage) => Ok(Some(slot.to_owned())),
        _ => Ok(None),
    }
}

pub(crate) enum Removal {
    Withdrawn(Option<CapturedFile>),
    Conflict(Option<PathBuf>),
}

pub(crate) fn remove(vault: &VaultDir, intent: &Intent) -> io::Result<Removal> {
    let Action::Withdraw { expected } = &intent.action else {
        return Err(invalid());
    };
    let slot = slot(intent)?;
    if vault.recovered_capture(&slot)?.is_some() {
        return Ok(Removal::Withdrawn(Some(CapturedFile {
            path: slot,
            stamp: expected.clone(),
        })));
    }
    if let Some(capture) = vault.read(&slot, MAX_NOTE_BYTES)? {
        vault.sync_parent(&slot)?;
        return Ok(if same(&capture.stamp, expected) {
            Removal::Withdrawn(Some(CapturedFile {
                path: slot,
                stamp: capture.stamp,
            }))
        } else {
            Removal::Conflict(Some(slot))
        });
    }
    match vault.withdraw(&intent.target, &slot, expected)? {
        Withdrawal::Captured(file) => Ok(Removal::Withdrawn(Some(file))),
        Withdrawal::Missing => Ok(Removal::Withdrawn(None)),
        Withdrawal::Conflict => Ok(Removal::Conflict(first_present(vault, [&slot])?)),
    }
}

pub(crate) fn slot(intent: &Intent) -> io::Result<PathBuf> {
    VaultDir::operation_slot(&intent.target, &intent.id.to_hex())
}

fn first_present<'a>(
    vault: &VaultDir,
    paths: impl IntoIterator<Item = &'a PathBuf>,
) -> io::Result<Option<PathBuf>> {
    for path in paths {
        if vault.entry_kind(path)?.is_some() {
            return Ok(Some(path.clone()));
        }
    }
    Ok(None)
}

fn same(left: &FileStamp, right: &FileStamp) -> bool {
    left.identity == right.identity && left.digest == right.digest && left.size == right.size
}

fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "invalid vault publication record",
    )
}
