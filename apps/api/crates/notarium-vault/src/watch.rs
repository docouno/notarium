//! Bounded collection between the OS observer and the single vault worker.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use notify::{
    Config, Event, EventKind, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher,
    event::{ModifyKind, RenameMode},
};
use tokio::{sync::Notify, time::Instant};

use crate::{
    filesystem::path_error,
    paths::{PathUse, path_use},
};

const MAX_PATHS: usize = 4096;
const BURST_EVENTS: u16 = 50;
const QUIET: Duration = Duration::from_millis(100);
const MAX_WINDOW: Duration = Duration::from_secs(1);
const POLL_FALLBACK: Duration = Duration::from_secs(2);

#[derive(Debug, Default)]
pub(crate) struct Dirty {
    pub paths: HashSet<PathBuf>,
    pub renames: Vec<(PathBuf, PathBuf)>,
    pub rescan: bool,
    pub storm: bool,
}

impl Dirty {
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty() && !self.rescan
    }

    pub fn merge(&mut self, next: Self) {
        if self.rescan || next.rescan {
            *self = Self {
                rescan: true,
                ..Self::default()
            };
            return;
        }
        self.paths.extend(next.paths);
        self.renames.extend(next.renames);
        self.storm |= next.storm;
        if self.paths.len() > MAX_PATHS || self.renames.len() > MAX_PATHS {
            *self = Self {
                rescan: true,
                ..Self::default()
            };
        }
    }
}

#[derive(Default)]
struct Window {
    dirty: Dirty,
    split: HashMap<usize, SplitRename>,
    untracked: HashSet<PathBuf>,
    completed: HashSet<usize>,
    completed_from: HashSet<PathBuf>,
    completed_to: HashSet<PathBuf>,
    count: u16,
    first: Option<Instant>,
    last: Option<Instant>,
}

#[derive(Default)]
struct SplitRename {
    from: Option<PathBuf>,
    to: Option<PathBuf>,
}

struct Inbox {
    root: PathBuf,
    state: Mutex<State>,
    ready: Notify,
}

#[derive(Default)]
struct State {
    window: Window,
    loss: u64,
}

impl Inbox {
    fn push_polled(&self, event: notify::Result<Event>) {
        if matches!(&event, Err(error) if inaccessible_descendant(error, &self.root)) {
            // The partial inventory diagnoses this path. Polling already
            // excludes destructive decisions that require native coverage.
            return;
        }
        self.push(event);
    }

    fn push(&self, event: notify::Result<Event>) {
        let now = Instant::now();
        let mut state = self.state.lock().expect("vault watcher inbox");
        let event = match event {
            Ok(event) if !event.need_rescan() => event,
            _ => {
                Self::lose(&mut state, now);
                self.ready.notify_one();
                return;
            }
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        let relative = event
            .paths
            .iter()
            .filter_map(|path| path.strip_prefix(&self.root).ok())
            .map(Path::to_owned)
            .collect::<Vec<_>>();
        let paths = relative
            .iter()
            .filter(|path| !ignored(path))
            .collect::<Vec<_>>();
        if paths.is_empty() {
            return;
        }
        // The watched name itself has changed. The actor revalidates the root
        // capability before acting on any subsequent event.
        if paths.iter().any(|p| p.as_os_str().is_empty()) {
            Self::lose(&mut state, now);
            self.ready.notify_one();
            return;
        }
        let window = &mut state.window;
        if !window.dirty.rescan {
            window.dirty.paths.extend(paths.into_iter().cloned());
            if window.dirty.paths.len() > MAX_PATHS {
                Self::lose(&mut state, now);
                self.ready.notify_one();
                return;
            }
            window.collect_rename(&event, &relative);
        }
        window.count = window.count.saturating_add(1);
        window.dirty.storm = window.count > BURST_EVENTS;
        window.first.get_or_insert(now);
        window.last = Some(now);
        self.ready.notify_one();
    }

    fn lose(state: &mut State, now: Instant) {
        state.loss = state.loss.wrapping_add(1);
        let window = &mut state.window;
        window.dirty = Dirty {
            rescan: true,
            ..Dirty::default()
        };
        window.split.clear();
        window.untracked.clear();
        window.first.get_or_insert(now);
        window.last = Some(now);
    }

    fn quiet_since(&self, loss: u64) -> bool {
        let state = self.state.lock().expect("vault watcher inbox");
        state.loss == loss && state.window.dirty.is_empty()
    }

    fn finish_window(state: &mut State) -> Dirty {
        let Window {
            mut dirty,
            split,
            untracked,
            ..
        } = std::mem::take(&mut state.window);
        if !split.is_empty() || !untracked.is_empty() {
            // A tracked rename straddled this cut. Its missing half may
            // still be in flight, so reopen admission from an inventory.
            state.loss = state.loss.wrapping_add(1);
            dirty.rescan = true;
        }
        dirty
    }
}

impl Window {
    fn collect_rename(&mut self, event: &Event, paths: &[PathBuf]) {
        // Raw pairs involving Git bookkeeping or a staging name still
        // prove a rename completed. They never prove a note identity.
        if paths.len() != event.paths.len() {
            return;
        }
        if self.dirty.renames.len() == MAX_PATHS
            || self.completed.len() == MAX_PATHS
            || self.completed_to.len() == MAX_PATHS
        {
            self.dirty.rescan = true;
            return;
        }
        match (event.kind, paths) {
            (EventKind::Modify(ModifyKind::Name(RenameMode::Both)), [from, to]) => {
                self.record_pair(event.tracker(), from.clone(), to.clone());
            }
            (
                EventKind::Modify(ModifyKind::Name(mode @ (RenameMode::From | RenameMode::To))),
                [path],
            ) => {
                if path_use(path) != PathUse::Notes {
                    return;
                }
                let Some(tracker) = event.tracker() else {
                    let observed = if mode == RenameMode::From {
                        self.completed_from.contains(path)
                    } else {
                        self.completed_to.contains(path)
                    };
                    if !observed {
                        self.untracked.insert(path.clone());
                    }
                    return;
                };
                if self.completed.contains(&tracker) {
                    return;
                }
                if self.split.len() == MAX_PATHS && !self.split.contains_key(&tracker) {
                    self.dirty.rescan = true;
                    return;
                }
                let (from, to) = {
                    let pair = self.split.entry(tracker).or_default();
                    match mode {
                        RenameMode::From => pair.from = Some(path.clone()),
                        RenameMode::To => pair.to = Some(path.clone()),
                        _ => return,
                    }
                    (pair.from.clone(), pair.to.clone())
                };
                if let (Some(from), Some(to)) = (from, to) {
                    self.record_pair(Some(tracker), from, to);
                }
            }
            _ => {}
        }
    }

    fn record_pair(&mut self, tracker: Option<usize>, from: PathBuf, to: PathBuf) {
        if let Some(tracker) = tracker {
            self.split.remove(&tracker);
            if !self.completed.insert(tracker) {
                return;
            }
        }
        self.untracked.remove(&from);
        self.untracked.remove(&to);
        self.completed_from.insert(from.clone());
        self.completed_to.insert(to.clone());
        if path_use(&from) == PathUse::Notes && path_use(&to) == PathUse::Notes {
            self.dirty.renames.push((from, to));
        }
    }

    fn deadline(&self) -> Option<Instant> {
        Some((self.first? + MAX_WINDOW).min(self.last? + QUIET))
    }
}

/// Ignore Git internals except the coordination lock. Reading any notification
/// path still requires the separate vault directory capability.
fn ignored(path: &Path) -> bool {
    path.components()
        .next()
        .is_some_and(|part| part.as_os_str() == ".git")
        && path != Path::new(".git/index.lock")
}

pub(crate) struct VaultWatch {
    inbox: Arc<Inbox>,
    backend: WatchBackend,
}

enum WatchBackend {
    Native {
        _watcher: RecommendedWatcher,
    },
    Polling {
        _watcher: PollWatcher,
        next_retry: Instant,
    },
}

fn native_watch(inbox: &Arc<Inbox>) -> notify::Result<RecommendedWatcher> {
    let sender = Arc::clone(inbox);
    let mut watcher = RecommendedWatcher::new(
        move |event| sender.push(event),
        Config::default().with_follow_symlinks(false),
    )?;
    watcher.watch(&inbox.root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

fn inaccessible_descendant(error: &notify::Error, root: &Path) -> bool {
    matches!(&error.kind, notify::ErrorKind::Io(error) if path_error(error))
        && !error.paths.is_empty()
        && error
            .paths
            .iter()
            .all(|path| path != root && path.starts_with(root))
}

fn polling_watch(inbox: &Arc<Inbox>) -> notify::Result<WatchBackend> {
    let sender = Arc::clone(inbox);
    let mut watcher = PollWatcher::new(
        move |event| sender.push_polled(event),
        Config::default()
            .with_follow_symlinks(false)
            .with_poll_interval(POLL_FALLBACK),
    )?;
    watcher.watch(&inbox.root, RecursiveMode::Recursive)?;
    Ok(WatchBackend::Polling {
        _watcher: watcher,
        next_retry: Instant::now() + POLL_FALLBACK,
    })
}

impl VaultWatch {
    pub fn open(root: &Path) -> notify::Result<Self> {
        let inbox = Arc::new(Inbox {
            root: root.to_owned(),
            state: Mutex::default(),
            ready: Notify::new(),
        });
        let backend = match native_watch(&inbox) {
            Ok(watcher) => WatchBackend::Native { _watcher: watcher },
            Err(error) if inaccessible_descendant(&error, root) => polling_watch(&inbox)?,
            Err(error) => return Err(error),
        };
        Ok(Self { inbox, backend })
    }

    pub fn is_polling(&self) -> bool {
        matches!(self.backend, WatchBackend::Polling { .. })
    }

    pub fn restore_native(&mut self, restore_coverage: bool) -> notify::Result<bool> {
        match &mut self.backend {
            WatchBackend::Polling { next_retry, .. } => {
                let now = Instant::now();
                if now < *next_retry {
                    return Ok(false);
                }
                *next_retry = now + POLL_FALLBACK;
            }
            WatchBackend::Native { .. } if !restore_coverage => return Ok(false),
            WatchBackend::Native { .. } => {}
        }
        match native_watch(&self.inbox) {
            Ok(watcher) => {
                self.backend = WatchBackend::Native { _watcher: watcher };
                Ok(true)
            }
            Err(error) if inaccessible_descendant(&error, &self.inbox.root) => {
                if !self.is_polling() {
                    self.backend = polling_watch(&self.inbox)?;
                }
                Ok(false)
            }
            Err(error) => Err(error),
        }
    }

    pub fn loss(&self) -> u64 {
        self.inbox.state.lock().expect("vault watcher inbox").loss
    }

    pub fn quiet_since(&self, loss: u64) -> bool {
        self.inbox.quiet_since(loss)
    }

    pub fn deletion_fence(&self, loss: u64) -> impl Fn() -> bool + Send + Sync + 'static {
        let inbox = self.inbox.clone();
        move || inbox.quiet_since(loss)
    }

    pub fn take(&self) -> Dirty {
        let mut state = self.inbox.state.lock().expect("vault watcher inbox");
        Inbox::finish_window(&mut state)
    }

    /// Wait for a quiet window, bounded even when notifications keep arriving.
    /// A consumer can also take the current cut after an inventory pass.
    pub async fn next(&self) -> Dirty {
        loop {
            let changed = self.inbox.ready.notified();
            let deadline = {
                let mut state = self.inbox.state.lock().expect("vault watcher inbox");
                let deadline = state.window.deadline();
                if state.window.dirty.rescan || deadline.is_some_and(|end| end <= Instant::now()) {
                    return Inbox::finish_window(&mut state);
                }
                deadline
            };
            if let Some(deadline) = deadline {
                tokio::select! {
                    () = changed => {}
                    () = tokio::time::sleep_until(deadline) => {}
                }
            } else {
                changed.await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inbox() -> Inbox {
        Inbox {
            root: PathBuf::from("/vault"),
            state: Mutex::default(),
            ready: Notify::new(),
        }
    }

    #[test]
    fn known_inaccessible_polled_subtrees_do_not_invalidate_accessible_work() {
        use std::io;

        let inbox = inbox();
        let denied = || notify::Error::io(io::Error::from(io::ErrorKind::PermissionDenied));
        inbox.push_polled(Err(denied().add_path("/vault/blocked".into())));
        assert!(inbox.quiet_since(0));
        inbox.push_polled(Err(denied().add_path("/vault".into())));
        assert!(!inbox.quiet_since(0));
    }

    #[test]
    fn preserves_rename_pair_without_reading_git_metadata() {
        let inbox = inbox();
        let event = Event::new(EventKind::Modify(ModifyKind::Name(RenameMode::Both)));
        inbox.push(Ok(event
            .clone()
            .add_path("/vault/old".into())
            .add_path("/vault/new".into())));
        inbox.push(Ok(event
            .add_path("/vault/.git/index.lock".into())
            .add_path("/vault/.git/index".into())));
        let state = inbox.state.lock().unwrap();
        let dirty = &state.window.dirty;
        assert_eq!(dirty.renames, vec![("old".into(), "new".into())]);
        assert_eq!(dirty.paths.len(), 3);
        assert!(dirty.paths.contains(Path::new(".git/index.lock")));
    }

    #[test]
    fn deduplicates_bursts_and_exposes_lost_observations() {
        let inbox = inbox();
        for _ in 0..=BURST_EVENTS {
            inbox.push(Ok(
                Event::new(EventKind::Any).add_path("/vault/doc.md".into())
            ));
        }
        {
            let state = inbox.state.lock().unwrap();
            assert_eq!(state.window.dirty.paths.len(), 1);
            assert!(state.window.dirty.storm);
        }
        for index in 0..MAX_PATHS {
            let path = format!("/vault/{index}.md");
            inbox.push(Ok(Event::new(EventKind::Any).add_path(path.into())));
        }
        let state = inbox.state.lock().unwrap();
        assert!(state.window.dirty.rescan);
        assert_eq!(state.loss, 1);
        assert!(state.window.dirty.paths.is_empty());
    }

    #[test]
    fn unseen_events_and_lost_events_invalidate_a_delete_cut() {
        let inbox = inbox();
        assert!(inbox.quiet_since(0));
        inbox.push(Ok(
            Event::new(EventKind::Any).add_path("/vault/new.md".into())
        ));
        assert!(!inbox.quiet_since(0));
        {
            let mut state = inbox.state.lock().unwrap();
            Inbox::lose(&mut state, Instant::now());
            std::mem::take(&mut state.window);
        }
        assert!(!inbox.quiet_since(0));
        assert!(inbox.quiet_since(1));
    }

    #[test]
    fn split_rename_at_a_window_boundary_requires_inventory() {
        let inbox = inbox();
        let half = |mode, path: &str| {
            Event::new(EventKind::Modify(ModifyKind::Name(mode)))
                .set_tracker(11)
                .add_path(path.into())
        };
        inbox.push(Ok(half(RenameMode::From, "/vault/old.md")));
        {
            let mut state = inbox.state.lock().unwrap();
            let window = Inbox::finish_window(&mut state);
            assert!(window.rescan);
            assert_eq!(state.loss, 1);
        }
        inbox.push(Ok(half(RenameMode::To, "/vault/new.md")));
        assert!(!inbox.quiet_since(1));
        let mut state = inbox.state.lock().unwrap();
        assert!(Inbox::finish_window(&mut state).rescan);
    }

    #[test]
    fn git_lock_and_staging_renames_do_not_request_inventory() {
        let inbox = inbox();
        let rename = |mode, tracker| {
            Event::new(EventKind::Modify(ModifyKind::Name(mode))).set_tracker(tracker)
        };
        inbox.push(Ok(
            rename(RenameMode::From, 5).add_path("/vault/.git/index.lock".into())
        ));
        inbox.push(Ok(rename(RenameMode::Both, 5)
            .add_path("/vault/.git/index.lock".into())
            .add_path("/vault/.git/index".into())));
        inbox.push(Ok(
            rename(RenameMode::From, 6).add_path("/vault/.notarium-stage-witness".into())
        ));
        inbox.push(Ok(
            rename(RenameMode::From, 7).add_path("/vault/note.md".into())
        ));
        inbox.push(Ok(rename(RenameMode::Both, 7)
            .add_path("/vault/note.md".into())
            .add_path("/vault/.notarium-stage-witness".into())));
        let mut state = inbox.state.lock().unwrap();
        let window = Inbox::finish_window(&mut state);
        assert!(!window.rescan);
        assert!(window.renames.is_empty());
        assert!(window.paths.contains(Path::new(".git/index.lock")));
    }
}
