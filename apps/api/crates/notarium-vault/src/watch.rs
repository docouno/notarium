//! Bounded collection between the OS observer and the single vault worker.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use notify::{
    Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
    event::{ModifyKind, RenameMode},
};
use tokio::{sync::Notify, time::Instant};

const MAX_PATHS: usize = 4096;
const BURST_EVENTS: u16 = 50;
const QUIET: Duration = Duration::from_millis(100);
const MAX_WINDOW: Duration = Duration::from_secs(1);

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
        let paths = event
            .paths
            .iter()
            .filter_map(|path| path.strip_prefix(&self.root).ok())
            .filter(|path| !ignored(path))
            .map(Path::to_owned)
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
            window.dirty.paths.extend(paths.iter().cloned());
            if window.dirty.paths.len() > MAX_PATHS {
                Self::lose(&mut state, now);
                self.ready.notify_one();
                return;
            }
            window.collect_rename(&event, &paths);
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
        window.first.get_or_insert(now);
        window.last = Some(now);
    }

    fn quiet_since(&self, loss: u64) -> bool {
        let state = self.state.lock().expect("vault watcher inbox");
        state.loss == loss && state.window.dirty.is_empty()
    }
}

impl Window {
    fn collect_rename(&mut self, event: &Event, paths: &[PathBuf]) {
        // A rename from an ignored area is not evidence of a vault move.
        if paths.len() != event.paths.len() || self.dirty.renames.len() == MAX_PATHS {
            return;
        }
        match (event.kind, paths) {
            (EventKind::Modify(ModifyKind::Name(RenameMode::Both)), [from, to]) => {
                self.dirty.renames.push((from.clone(), to.clone()));
            }
            (EventKind::Modify(ModifyKind::Name(mode)), [path]) => {
                let Some(tracker) = event.tracker() else {
                    return;
                };
                if self.split.len() == MAX_PATHS && !self.split.contains_key(&tracker) {
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
                    self.dirty.renames.push((from, to));
                    self.split.remove(&tracker);
                }
            }
            _ => {}
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
    _watcher: RecommendedWatcher,
}

impl VaultWatch {
    pub fn open(root: &Path) -> notify::Result<Self> {
        let inbox = Arc::new(Inbox {
            root: root.to_owned(),
            state: Mutex::default(),
            ready: Notify::new(),
        });
        let sender = inbox.clone();
        let mut watcher = RecommendedWatcher::new(
            move |event| sender.push(event),
            Config::default().with_follow_symlinks(false),
        )?;
        watcher.watch(root, RecursiveMode::Recursive)?;
        Ok(Self {
            inbox,
            _watcher: watcher,
        })
    }

    pub fn loss(&self) -> u64 {
        self.inbox.state.lock().expect("vault watcher inbox").loss
    }

    pub fn quiet_since(&self, loss: u64) -> bool {
        self.inbox.quiet_since(loss)
    }

    pub fn take(&self) -> Dirty {
        let mut state = self.inbox.state.lock().expect("vault watcher inbox");
        std::mem::take(&mut state.window).dirty
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
                    return std::mem::take(&mut state.window).dirty;
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
}
