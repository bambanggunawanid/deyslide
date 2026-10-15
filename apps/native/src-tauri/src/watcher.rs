//! Watches the library folder so the pages see changes made outside the
//! app, such as Claude Code writing a deck through `deyslide mcp`. Bursts
//! of file events are gathered for [`QUIET`] and then reported once.
//!
//! Only changes count. Reading a file is no change: the pages read decks
//! when they hear of one, and counting that read would make them read again
//! and again.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use deyslide_core::library::{clean_name, deck_id};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};

/// How long the folder must stay quiet before changes are reported.
pub const QUIET: Duration = Duration::from_millis(150);

/// Changes are reported at least this often while events keep coming.
const LONGEST_WAIT: Duration = Duration::from_secs(1);

/// What changed in one quiet period.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Changes {
    /// Anything in the library: a project or deck added, removed, renamed or edited.
    pub library: bool,
    /// Decks whose file changed, by id.
    pub decks: BTreeSet<String>,
}

impl Changes {
    /// Adds a changed path. Paths outside the library, hidden files (such
    /// as the temporary files atomic writes use) and files Deyslide does
    /// not list are left out.
    pub fn add(&mut self, root: &Path, path: &Path) {
        let Ok(relative) = path.strip_prefix(root) else {
            return;
        };
        let mut parts = Vec::new();
        for component in relative.components() {
            match component {
                Component::Normal(part) => match part.to_str() {
                    Some(part) => parts.push(part),
                    None => return,
                },
                _ => return,
            }
        }
        match parts.as_slice() {
            [] => self.library = true,
            [project] if listed(project) => self.library = true,
            [project, file] if listed(project) => {
                if let Some(name) = file.strip_suffix(".md").filter(|name| listed(name)) {
                    self.library = true;
                    self.decks.insert(deck_id(project, &format!("{name}.md")));
                }
            }
            _ => {}
        }
    }

    pub fn is_empty(&self) -> bool {
        !self.library && self.decks.is_empty()
    }
}

fn listed(name: &str) -> bool {
    clean_name(name).is_ok_and(|clean| clean == name)
}

/// Gathers paths from `paths` and calls `report` once the stream has been
/// quiet for `quiet`. Returns when the sender side is gone.
pub fn gather(
    root: &Path,
    paths: Receiver<PathBuf>,
    quiet: Duration,
    mut report: impl FnMut(Changes),
) {
    while let Ok(first) = paths.recv() {
        let mut changes = Changes::default();
        changes.add(root, &first);
        let started = Instant::now();
        let mut open = true;
        while started.elapsed() < LONGEST_WAIT {
            match paths.recv_timeout(quiet) {
                Ok(path) => changes.add(root, &path),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    open = false;
                    break;
                }
            }
        }
        if !changes.is_empty() {
            report(changes);
        }
        if !open {
            return;
        }
    }
}

/// Whether an event is a change to the folder. Opening, reading and
/// closing files are not.
pub fn is_change(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_))
}

/// Linux and Android watch each folder on its own (inotify), so only the
/// library folder and its project folders are watched: a library inside a
/// big folder tree would otherwise use up the system's watches and slow the
/// start. Other systems watch a whole tree at once.
const ONE_FOLDER_AT_A_TIME: bool = cfg!(any(target_os = "linux", target_os = "android"));

/// Watches a library folder until dropped.
pub struct LibraryWatcher {
    _watcher: Arc<Mutex<RecommendedWatcher>>,
    root: PathBuf,
}

impl LibraryWatcher {
    /// `root` must be the library's canonical path, as `Library::root` gives it.
    pub fn start(
        root: PathBuf,
        mut report: impl FnMut(Changes) + Send + 'static,
    ) -> notify::Result<Self> {
        let (sender, receiver) = channel();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else {
                return;
            };
            if is_change(&event.kind) {
                for path in event.paths {
                    let _ = sender.send(path);
                }
            }
        })?;
        let watcher = Arc::new(Mutex::new(watcher));
        if ONE_FOLDER_AT_A_TIME {
            watch_folder(&watcher, &root)?;
            for project in project_folders(&root) {
                let _ = watch_folder(&watcher, &project);
            }
        } else {
            watcher
                .lock()
                .unwrap()
                .watch(&root, RecursiveMode::Recursive)?;
        }
        let gathering_root = root.clone();
        let adding: Weak<Mutex<RecommendedWatcher>> = Arc::downgrade(&watcher);
        std::thread::Builder::new()
            .name("deyslide-library-watcher".into())
            .spawn(move || {
                gather(&gathering_root, receiver, QUIET, |changes| {
                    if ONE_FOLDER_AT_A_TIME && changes.library {
                        // New and renamed project folders get watched too.
                        if let Some(watcher) = adding.upgrade() {
                            for project in project_folders(&gathering_root) {
                                let _ = watch_folder(&watcher, &project);
                            }
                        }
                    }
                    report(changes);
                })
            })
            .map_err(|error| notify::Error::generic(&error.to_string()))?;
        Ok(Self {
            _watcher: watcher,
            root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

fn watch_folder(watcher: &Mutex<RecommendedWatcher>, folder: &Path) -> notify::Result<()> {
    watcher
        .lock()
        .unwrap()
        .watch(folder, RecursiveMode::NonRecursive)
}

/// The folders in `root` that Deyslide lists as projects.
fn project_folders(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| entry.file_name().to_str().is_some_and(listed))
        .map(|entry| entry.path())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn changes_for(paths: &[&str]) -> Changes {
        let mut changes = Changes::default();
        for path in paths {
            changes.add(Path::new("/lib"), Path::new(path));
        }
        changes
    }

    #[test]
    fn a_deck_file_names_its_deck() {
        let changes = changes_for(&["/lib/Talks/Intro.md"]);
        assert!(changes.library);
        assert_eq!(
            changes.decks,
            BTreeSet::from([deck_id("Talks", "Intro.md")])
        );
    }

    #[test]
    fn a_project_folder_changes_the_library_only() {
        let changes = changes_for(&["/lib/Talks"]);
        assert!(changes.library);
        assert!(changes.decks.is_empty());
        assert_eq!(
            changes_for(&["/lib"]),
            Changes {
                library: true,
                decks: BTreeSet::new()
            }
        );
    }

    #[test]
    fn hidden_and_unlisted_files_are_left_out() {
        assert!(changes_for(&[
            "/lib/Talks/.deyslide-1-2-3.tmp",
            "/lib/.git/index",
            "/lib/Talks/notes.txt",
            "/lib/Talks/assets/logo.png",
            "/elsewhere/Talks/Intro.md",
            "/lib/Talks/CON.md",
        ])
        .is_empty());
    }

    #[test]
    fn bursts_are_reported_once_after_a_quiet_moment() {
        let (sender, receiver) = mpsc::channel();
        let (reports, received) = mpsc::channel();
        let gathering = std::thread::spawn(move || {
            gather(
                Path::new("/lib"),
                receiver,
                Duration::from_millis(50),
                move |changes| {
                    reports.send(changes).unwrap();
                },
            )
        });
        for path in [
            "/lib/Talks/.deyslide-1.tmp",
            "/lib/Talks/Intro.md",
            "/lib/Talks/Outro.md",
        ] {
            sender.send(PathBuf::from(path)).unwrap();
        }
        let first = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            first.decks,
            BTreeSet::from([deck_id("Talks", "Intro.md"), deck_id("Talks", "Outro.md")])
        );
        sender.send(PathBuf::from("/lib/Talks/Intro.md")).unwrap();
        let second = received.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(second.decks, BTreeSet::from([deck_id("Talks", "Intro.md")]));
        drop(sender);
        gathering.join().unwrap();
        assert!(received.try_recv().is_err());
    }

    #[test]
    fn the_watcher_sees_a_deck_written_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce_root(dir.path());
        std::fs::create_dir(root.join("Talks")).unwrap();
        let (reports, received) = mpsc::channel();
        let watcher = LibraryWatcher::start(root.clone(), move |changes| {
            let _ = reports.send(changes);
        })
        .unwrap();
        assert_eq!(watcher.root(), root);
        deyslide_core::paths::write_atomically(&root.join("Talks/Intro.md"), b"# Hi\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut seen = BTreeSet::new();
        while Instant::now() < deadline && seen.is_empty() {
            if let Ok(changes) = received.recv_timeout(Duration::from_millis(200)) {
                seen.extend(changes.decks);
            }
        }
        assert_eq!(seen, BTreeSet::from([deck_id("Talks", "Intro.md")]));
    }

    fn dunce_root(path: &Path) -> PathBuf {
        std::fs::canonicalize(path).unwrap()
    }

    fn watch(root: &Path) -> (LibraryWatcher, mpsc::Receiver<Changes>) {
        let (reports, received) = mpsc::channel();
        let watcher = LibraryWatcher::start(root.to_path_buf(), move |changes| {
            let _ = reports.send(changes);
        })
        .unwrap();
        (watcher, received)
    }

    /// Everything reported within `wait`.
    fn reports_within(received: &mpsc::Receiver<Changes>, wait: Duration) -> Vec<Changes> {
        let deadline = Instant::now() + wait;
        let mut reports = Vec::new();
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match received.recv_timeout(left) {
                Ok(changes) => reports.push(changes),
                Err(_) => break,
            }
        }
        reports
    }

    /// Waits up to 5 s for a report that passes `check`.
    fn wait_for(received: &mpsc::Receiver<Changes>, check: impl Fn(&Changes) -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match received.recv_timeout(left) {
                Ok(changes) if check(&changes) => return true,
                Ok(_) => {}
                Err(_) => return false,
            }
        }
        false
    }

    #[test]
    fn reading_decks_and_listing_the_library_change_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let root = dunce_root(dir.path());
        let library =
            deyslide_core::library::Library::open(&root, data.path().join("lock")).unwrap();
        let project = library.create_project("Talks").unwrap();
        let deck = library.create_deck(&project.id, "Intro", "# Hi\n").unwrap();
        let (_watcher, received) = watch(&root);
        for _ in 0..3 {
            assert_eq!(library.read_deck(&deck.id).unwrap(), "# Hi\n");
            assert_eq!(library.list().unwrap().len(), 1);
        }
        assert_eq!(
            reports_within(&received, Duration::from_millis(800)),
            Vec::<Changes>::new()
        );
        library.write_deck(&deck.id, "# Hello\n", None).unwrap();
        assert!(wait_for(&received, |changes| changes
            .decks
            .contains(&deck.id)));
    }

    #[test]
    fn decks_in_new_and_renamed_project_folders_are_seen() {
        let dir = tempfile::tempdir().unwrap();
        let root = dunce_root(dir.path());
        let (_watcher, received) = watch(&root);
        std::fs::create_dir(root.join("Talks")).unwrap();
        assert!(wait_for(&received, |changes| changes.library));
        deyslide_core::paths::write_atomically(&root.join("Talks/Intro.md"), b"# Hi\n").unwrap();
        let intro = deck_id("Talks", "Intro.md");
        assert!(wait_for(&received, |changes| changes
            .decks
            .contains(&intro)));
        std::fs::rename(root.join("Talks"), root.join("Lectures")).unwrap();
        assert!(wait_for(&received, |changes| changes.library));
        std::fs::write(root.join("Lectures/Intro.md"), b"# Hello\n").unwrap();
        let moved = deck_id("Lectures", "Intro.md");
        assert!(wait_for(&received, |changes| changes
            .decks
            .contains(&moved)));
    }

    #[test]
    fn only_changes_count() {
        use notify::event::{AccessKind, AccessMode, CreateKind, ModifyKind, RemoveKind};
        assert!(!is_change(&EventKind::Access(AccessKind::Open(
            AccessMode::Any
        ))));
        assert!(!is_change(&EventKind::Access(AccessKind::Close(
            AccessMode::Read
        ))));
        assert!(!is_change(&EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
        assert!(is_change(&EventKind::Create(CreateKind::File)));
        assert!(is_change(&EventKind::Modify(ModifyKind::Any)));
        assert!(is_change(&EventKind::Remove(RemoveKind::Folder)));
        assert!(is_change(&EventKind::Any));
    }
}
