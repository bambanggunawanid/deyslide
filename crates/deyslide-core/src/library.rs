//! The Deyslide library on this computer: a folder whose subfolders are
//! projects, each holding decks as plain Slidev Markdown files (`.md`).
//!
//! Projects and decks have short ids made from a hash of their names, so
//! an id never turns back into a path: it is looked up by listing the
//! library. Every path is checked to stay inside the library, and every
//! change happens under a lock that the app and `deyslide mcp` share.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};
use sha2::{Digest, Sha256};

use crate::paths::{write_atomically, DataDir};
use crate::settings::Settings;
use crate::slides::{js_length, js_trim, split_slides};

/// The longest project or deck name, in UTF-16 units like the web app counts.
pub const NAME_MAX_LENGTH: usize = 80;
pub const PROJECT_ID_PREFIX: &str = "local-p-";
pub const DECK_ID_PREFIX: &str = "local-d-";
const DECK_EXTENSION: &str = ".md";
const FORBIDDEN: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];
/// Names Windows keeps for devices, with or without an extension. Windows
/// also counts COM0, LPT0 and the ports written with superscript digits.
const RESERVED: &[&str] = &[
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM0",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "COM\u{b9}",
    "COM\u{b2}",
    "COM\u{b3}",
    "LPT0",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
    "LPT\u{b9}",
    "LPT\u{b2}",
    "LPT\u{b3}",
];

#[derive(Debug)]
pub enum LibraryError {
    ProjectNotFound,
    DeckNotFound,
    /// The message says which rule the name breaks.
    InvalidName(String),
    NameTaken(String),
    NotText,
    /// The deck file is marked read-only, so it is left as it is.
    ReadOnly,
    Io(io::Error),
}

impl fmt::Display for LibraryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ProjectNotFound => {
                formatter.write_str("There is no project with that id in this library.")
            }
            Self::DeckNotFound => {
                formatter.write_str("There is no deck with that id in this library.")
            }
            Self::InvalidName(message) | Self::NameTaken(message) => formatter.write_str(message),
            Self::NotText => formatter.write_str("The deck file is not UTF-8 text."),
            Self::ReadOnly => {
                formatter.write_str("The deck file is read-only. Make it writable first.")
            }
            Self::Io(error) => write!(
                formatter,
                "The library folder cannot be read or changed: {error}"
            ),
        }
    }
}

impl std::error::Error for LibraryError {}

impl From<io::Error> for LibraryError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl Serialize for LibraryError {
    /// App commands report errors as their message.
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, LibraryError>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    /// Milliseconds since 1970, like JavaScript's `Date.now()`.
    pub created_at: u64,
    pub updated_at: u64,
    pub decks: Vec<DeckInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckInfo {
    pub id: String,
    pub project_id: String,
    pub project_name: String,
    /// The file name without `.md`.
    pub name: String,
    pub path: PathBuf,
    pub slide_count: usize,
    pub created_at: u64,
    pub updated_at: u64,
}

/// What a compare and swap write did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WriteOutcome {
    Written,
    /// The file no longer holds the expected content. Nothing was written.
    Conflict {
        current: String,
    },
}

impl Serialize for WriteOutcome {
    /// `{ "ok": true }` or `{ "conflict": true, "current": "..." }`, for the app.
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Written => {
                let mut state = serializer.serialize_struct("WriteOutcome", 1)?;
                state.serialize_field("ok", &true)?;
                state.end()
            }
            Self::Conflict { current } => {
                let mut state = serializer.serialize_struct("WriteOutcome", 2)?;
                state.serialize_field("conflict", &true)?;
                state.serialize_field("current", current)?;
                state.end()
            }
        }
    }
}

/// Checks a project or deck name and returns it trimmed. The rules keep
/// names valid as file names on Windows, macOS, Linux and Android.
pub fn clean_name(name: &str) -> Result<String> {
    let name = js_trim(name);
    let problem = if name.is_empty() {
        Some("A name is required".to_string())
    } else if js_length(name) > NAME_MAX_LENGTH {
        Some(format!(
            "A name can have at most {NAME_MAX_LENGTH} characters"
        ))
    } else if name.contains(FORBIDDEN) {
        Some("A name cannot contain / \\ : * ? \" < > or |".to_string())
    } else if name.chars().any(char::is_control) {
        Some("A name cannot contain control characters".to_string())
    } else if name.starts_with('.') {
        Some("A name cannot start with a dot".to_string())
    } else if name.ends_with('.') {
        // Windows drops a final dot, so the folder would get another name.
        Some("A name cannot end with a dot".to_string())
    } else if is_reserved(name) {
        Some(format!(
            "\"{name}\" is a name Windows keeps for itself. Pick another name"
        ))
    } else {
        None
    };
    match problem {
        Some(message) => Err(LibraryError::InvalidName(message)),
        None => Ok(name.to_string()),
    }
}

fn is_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    RESERVED
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// Whether a name found on disk is one Deyslide could have made.
fn is_clean(name: &str) -> bool {
    clean_name(name).is_ok_and(|clean| clean == name)
}

fn deck_name(file: &str) -> Option<&str> {
    file.strip_suffix(DECK_EXTENSION)
        .filter(|name| is_clean(name))
}

fn same_name(left: &str, right: &str) -> bool {
    // Windows and macOS see names that differ only in case as the same file.
    left.to_lowercase() == right.to_lowercase()
}

fn short_hash(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// `local-p-` and the first 16 hex characters of the folder name's SHA-256.
pub fn project_id(folder: &str) -> String {
    format!("{PROJECT_ID_PREFIX}{}", short_hash(folder))
}

/// `local-d-` and the first 16 hex characters of the SHA-256 of `folder/file.md`.
pub fn deck_id(folder: &str, file: &str) -> String {
    format!(
        "{DECK_ID_PREFIX}{}",
        short_hash(&format!("{folder}/{file}"))
    )
}

/// The library folder: the one in the settings, else this platform's default.
/// A relative folder in the settings counts from the data folder.
pub fn library_root(settings: &Settings, data_dir: &DataDir) -> PathBuf {
    match settings.library_root.as_deref().map(str::trim) {
        Some(root) if !root.is_empty() => data_dir.path().join(root),
        _ => default_library_root(data_dir),
    }
}

/// `Documents/Deyslide` on a computer, the app's own `decks` folder on Android.
pub fn default_library_root(data_dir: &DataDir) -> PathBuf {
    if cfg!(target_os = "android") {
        return data_dir.path().join("decks");
    }
    dirs::document_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Documents")))
        .map(|documents| documents.join("Deyslide"))
        .unwrap_or_else(|| data_dir.path().join("decks"))
}

fn millis(time: io::Result<SystemTime>) -> Option<u64> {
    let since = time.ok()?.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

/// A folder or file found in the library.
#[derive(Clone, Debug)]
struct Entry {
    name: String,
    path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct Library {
    root: PathBuf,
    lock: PathBuf,
}

impl Library {
    /// Opens the library folder, creating it when it is missing. `lock` is
    /// the file every process locks while it changes the library.
    pub fn open(root: impl AsRef<Path>, lock: impl Into<PathBuf>) -> Result<Self> {
        fs::create_dir_all(root.as_ref())?;
        Ok(Self {
            root: dunce::canonicalize(root)?,
            lock: lock.into(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Runs `change` while holding the library lock. Other processes and
    /// threads wait for it, so a read and the write after it see the same
    /// file. The lock is not reentrant: `change` must not call the methods
    /// here that change the library, since they take the lock themselves.
    pub fn locked<T>(&self, change: impl FnOnce() -> Result<T>) -> Result<T> {
        if let Some(folder) = self.lock.parent() {
            fs::create_dir_all(folder)?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.lock)?;
        lock_file(&file)?;
        let result = change();
        unlock_file(&file);
        result
    }

    /// Every project with its decks, sorted by name. A project folder this
    /// process cannot read (another user's, or one the system guards) is
    /// left out, so it does not hide the rest of the library.
    pub fn list(&self) -> Result<Vec<ProjectInfo>> {
        Ok(self
            .projects()?
            .iter()
            .filter_map(|project| match self.project_info(project) {
                Ok(info) => Some(info),
                Err(error) => {
                    skipped(project, &error);
                    None
                }
            })
            .collect())
    }

    pub fn project(&self, id: &str) -> Result<ProjectInfo> {
        self.project_info(&self.find_project(id)?)
    }

    pub fn deck(&self, id: &str) -> Result<DeckInfo> {
        let (project, deck) = self.find_deck(id)?;
        Ok(self.deck_info(&project, &deck))
    }

    pub fn create_project(&self, name: &str) -> Result<ProjectInfo> {
        let name = clean_name(name)?;
        self.locked(|| {
            let taken =
                || LibraryError::NameTaken(format!("There is already a project named \"{name}\""));
            if self
                .projects()?
                .iter()
                .any(|project| same_name(&project.name, &name))
            {
                return Err(taken());
            }
            let path = self.child(&self.root, &name)?;
            if let Err(error) = fs::create_dir(&path) {
                return Err(match error.kind() {
                    io::ErrorKind::AlreadyExists => taken(),
                    _ => error.into(),
                });
            }
            self.project_info(&Entry {
                name: name.clone(),
                path,
            })
        })
    }

    /// Renames a project's folder. Its id and its decks' ids change with it.
    pub fn rename_project(&self, id: &str, name: &str) -> Result<ProjectInfo> {
        let name = clean_name(name)?;
        self.locked(|| {
            let project = self.find_project(id)?;
            if project.name == name {
                return self.project_info(&project);
            }
            let target = self.child(&self.root, &name)?;
            let taken = self
                .projects()?
                .iter()
                .any(|other| other.name != project.name && same_name(&other.name, &name));
            if taken || (!same_name(&project.name, &name) && target.symlink_metadata().is_ok()) {
                return Err(LibraryError::NameTaken(format!(
                    "There is already a project named \"{name}\""
                )));
            }
            fs::rename(&project.path, &target)?;
            self.project_info(&Entry {
                name: name.clone(),
                path: target,
            })
        })
    }

    /// Deletes a project's folder and every file in it.
    pub fn delete_project(&self, id: &str) -> Result<()> {
        self.locked(|| {
            let project = self.find_project(id)?;
            fs::remove_dir_all(&project.path)?;
            Ok(())
        })
    }

    pub fn create_deck(&self, project_id: &str, name: &str, markdown: &str) -> Result<DeckInfo> {
        let name = clean_name(name)?;
        self.locked(|| {
            let project = self.find_project(project_id)?;
            let file = format!("{name}{DECK_EXTENSION}");
            let path = self.child(&project.path, &file)?;
            let taken = self
                .decks(&project)?
                .iter()
                .any(|deck| same_name(&deck.name, &file));
            if taken || path.symlink_metadata().is_ok() {
                return Err(LibraryError::NameTaken(format!(
                    "There is already a deck named \"{name}\" in this project"
                )));
            }
            write_atomically(&path, markdown.as_bytes())?;
            Ok(self.deck_info(&project, &Entry { name: file, path }))
        })
    }

    /// Renames a deck's file. Its id changes with it.
    pub fn rename_deck(&self, id: &str, name: &str) -> Result<DeckInfo> {
        let name = clean_name(name)?;
        self.locked(|| {
            let (project, deck) = self.find_deck(id)?;
            let file = format!("{name}{DECK_EXTENSION}");
            if deck.name == file {
                return Ok(self.deck_info(&project, &deck));
            }
            let target = self.child(&project.path, &file)?;
            let taken = self
                .decks(&project)?
                .iter()
                .any(|other| other.name != deck.name && same_name(&other.name, &file));
            if taken || (!same_name(&deck.name, &file) && target.symlink_metadata().is_ok()) {
                return Err(LibraryError::NameTaken(format!(
                    "There is already a deck named \"{name}\" in this project"
                )));
            }
            fs::rename(&deck.path, &target)?;
            Ok(self.deck_info(
                &project,
                &Entry {
                    name: file,
                    path: target,
                },
            ))
        })
    }

    pub fn delete_deck(&self, id: &str) -> Result<()> {
        self.locked(|| {
            let (_, deck) = self.find_deck(id)?;
            fs::remove_file(&deck.path)?;
            Ok(())
        })
    }

    pub fn read_deck(&self, id: &str) -> Result<String> {
        let (_, deck) = self.find_deck(id)?;
        read_text(&deck.path)
    }

    /// A deck's details and content, found with one look through the library.
    pub fn open_deck(&self, id: &str) -> Result<(DeckInfo, String)> {
        let (project, deck) = self.find_deck(id)?;
        let content = read_text(&deck.path)?;
        Ok((self.deck_info(&project, &deck), content))
    }

    /// Writes a deck's file only when it still holds `expected` (any content
    /// when `expected` is `None`). Otherwise nothing changes and the result
    /// carries what the file holds now.
    pub fn write_deck(
        &self,
        id: &str,
        content: &str,
        expected: Option<&str>,
    ) -> Result<WriteOutcome> {
        self.locked(|| {
            let (_, deck) = self.find_deck(id)?;
            let current = read_text(&deck.path)?;
            if expected.is_some_and(|expected| expected != current) {
                return Ok(WriteOutcome::Conflict { current });
            }
            self.replace_deck_file(&deck.path, content)?;
            Ok(WriteOutcome::Written)
        })
    }

    /// Reads a deck and, still under the lock, writes what `change` returns
    /// in its place (nothing when it returns `None`). For edits that must not
    /// lose a change another process makes between the read and the write.
    pub fn update_deck<T>(
        &self,
        id: &str,
        change: impl FnOnce(&DeckInfo, &str) -> (Option<String>, T),
    ) -> Result<(DeckInfo, T)> {
        self.locked(|| {
            let (project, deck) = self.find_deck(id)?;
            let current = read_text(&deck.path)?;
            let (next, value) = change(&self.deck_info(&project, &deck), &current);
            if let Some(next) = next {
                self.replace_deck_file(&deck.path, &next)?;
            }
            Ok((self.deck_info(&project, &deck), value))
        })
    }

    /// Saves a deck file in place of the old one. A link inside the library
    /// is followed, so the file it points to changes and the link stays. The
    /// new file keeps the old one's permissions, and a read-only file is refused.
    fn replace_deck_file(&self, path: &Path, content: &str) -> Result<()> {
        let real = match dunce::canonicalize(path) {
            Ok(real) if real.starts_with(&self.root) => real,
            Ok(_) => return Err(LibraryError::DeckNotFound),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(LibraryError::DeckNotFound)
            }
            Err(error) => return Err(error.into()),
        };
        if fs::metadata(&real)?.permissions().readonly() {
            return Err(LibraryError::ReadOnly);
        }
        write_atomically(&real, content.as_bytes())?;
        Ok(())
    }

    /// `parent/name`, refusing a name that is more than one plain path part.
    fn child(&self, parent: &Path, name: &str) -> Result<PathBuf> {
        let mut components = Path::new(name).components();
        match (components.next(), components.next()) {
            (Some(Component::Normal(part)), None) if part == name => Ok(parent.join(name)),
            _ => Err(LibraryError::InvalidName(
                "A name cannot be a path".to_string(),
            )),
        }
    }

    /// `root/parts...` when every part is one plain path part and the real
    /// path, after following links, is still inside the library.
    fn inside(&self, parts: &[&str]) -> Option<PathBuf> {
        let mut path = self.root.clone();
        for part in parts {
            path = self.child(&path, part).ok()?;
        }
        let real = dunce::canonicalize(&path).ok()?;
        (real.starts_with(&self.root) && real != self.root).then_some(path)
    }

    /// Project folders: visible subfolders with names Deyslide accepts.
    fn projects(&self) -> Result<Vec<Entry>> {
        let mut projects = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !is_clean(&name) {
                continue;
            }
            if let Some(path) = self.inside(&[&name]) {
                if path.is_dir() {
                    projects.push(Entry { name, path });
                }
            }
        }
        projects.sort_by(|left, right| {
            (left.name.to_lowercase(), &left.name).cmp(&(right.name.to_lowercase(), &right.name))
        });
        Ok(projects)
    }

    /// A project's decks: visible `.md` files with names Deyslide accepts.
    fn decks(&self, project: &Entry) -> Result<Vec<Entry>> {
        let mut decks = Vec::new();
        let entries = match fs::read_dir(&project.path) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(decks),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if deck_name(&name).is_none() {
                continue;
            }
            if let Some(path) = self.inside(&[&project.name, &name]) {
                if path.is_file() {
                    decks.push(Entry { name, path });
                }
            }
        }
        decks.sort_by(|left, right| {
            (left.name.to_lowercase(), &left.name).cmp(&(right.name.to_lowercase(), &right.name))
        });
        Ok(decks)
    }

    fn find_project(&self, id: &str) -> Result<Entry> {
        if !id.starts_with(PROJECT_ID_PREFIX) {
            return Err(LibraryError::ProjectNotFound);
        }
        self.projects()?
            .into_iter()
            .find(|project| project_id(&project.name) == id)
            .ok_or(LibraryError::ProjectNotFound)
    }

    fn find_deck(&self, id: &str) -> Result<(Entry, Entry)> {
        if !id.starts_with(DECK_ID_PREFIX) {
            return Err(LibraryError::DeckNotFound);
        }
        for project in self.projects()? {
            // A folder that cannot be read holds no deck this process can open.
            let decks = match self.decks(&project) {
                Ok(decks) => decks,
                Err(error) => {
                    skipped(&project, &error);
                    continue;
                }
            };
            if let Some(deck) = decks
                .into_iter()
                .find(|deck| deck_id(&project.name, &deck.name) == id)
            {
                return Ok((project, deck));
            }
        }
        Err(LibraryError::DeckNotFound)
    }

    fn project_info(&self, project: &Entry) -> Result<ProjectInfo> {
        let decks: Vec<DeckInfo> = self
            .decks(project)?
            .iter()
            .map(|deck| self.deck_info(project, deck))
            .collect();
        let metadata = fs::metadata(&project.path).ok();
        let modified = metadata
            .as_ref()
            .and_then(|data| millis(data.modified()))
            .unwrap_or(0);
        let created = metadata
            .as_ref()
            .and_then(|data| millis(data.created()))
            .unwrap_or(modified);
        let updated = decks
            .iter()
            .map(|deck| deck.updated_at)
            .fold(modified, u64::max);
        Ok(ProjectInfo {
            id: project_id(&project.name),
            name: project.name.clone(),
            path: project.path.clone(),
            created_at: created,
            updated_at: updated,
            decks,
        })
    }

    fn deck_info(&self, project: &Entry, deck: &Entry) -> DeckInfo {
        let metadata = fs::metadata(&deck.path).ok();
        let modified = metadata
            .as_ref()
            .and_then(|data| millis(data.modified()))
            .unwrap_or(0);
        let created = metadata
            .as_ref()
            .and_then(|data| millis(data.created()))
            .unwrap_or(modified);
        let slide_count = fs::read(&deck.path)
            .map(|bytes| split_slides(&String::from_utf8_lossy(&bytes)).len())
            .unwrap_or(0);
        DeckInfo {
            id: deck_id(&project.name, &deck.name),
            project_id: project_id(&project.name),
            project_name: project.name.clone(),
            name: deck_name(&deck.name).unwrap_or(&deck.name).to_string(),
            path: deck.path.clone(),
            slide_count,
            created_at: created,
            updated_at: modified,
        }
    }
}

/// Says on stderr which project folder a listing or lookup left out.
fn skipped(project: &Entry, error: &LibraryError) {
    eprintln!(
        "deyslide: skipped the project folder {}: {error}",
        project.path.display()
    );
}

/// Waits until this process holds the lock on `file`. std's `File::lock`
/// only answers "not supported" on Android, so every Unix system, Android
/// included, calls `flock` itself. Tests on Linux then run the code phones use.
#[cfg(unix)]
fn lock_file(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    loop {
        // SAFETY: `flock` only reads the descriptor, which `file` keeps open.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(unix)]
fn unlock_file(file: &File) {
    use std::os::fd::AsRawFd;
    // SAFETY: as in `lock_file`. Closing the file would release the lock too.
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
}

#[cfg(not(unix))]
fn lock_file(file: &File) -> io::Result<()> {
    file.lock()
}

#[cfg(not(unix))]
fn unlock_file(file: &File) {
    let _ = file.unlock();
}

fn read_text(path: &Path) -> Result<String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == io::ErrorKind::InvalidData => Err(LibraryError::NotText),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Err(LibraryError::DeckNotFound),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _dir: tempfile::TempDir,
        library: Library,
    }

    fn library() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let library = Library::open(
            dir.path().join("library"),
            dir.path().join("data/library.lock"),
        )
        .unwrap();
        Fixture { _dir: dir, library }
    }

    #[test]
    fn ids_are_short_hashes_of_names() {
        assert_eq!(
            project_id("Talks"),
            format!(
                "local-p-{}",
                &format!("{:x}", Sha256::digest(b"Talks"))[..16]
            )
        );
        assert_eq!(deck_id("Talks", "Sorting.md").len(), "local-d-".len() + 16);
        assert_ne!(
            deck_id("Talks", "Sorting.md"),
            deck_id("Talk", "sSorting.md")
        );
    }

    #[test]
    fn names_follow_the_rules() {
        assert_eq!(clean_name("  Talks  ").unwrap(), "Talks");
        for bad in [
            "",
            "   ",
            "a/b",
            "a\\b",
            "a:b",
            "what?",
            "star*",
            "\"quoted\"",
            "<tag>",
            "pipe|",
            "tab\there",
            ".hidden",
            "ends.",
            "CON",
            "con",
            "nul.md",
            "COM1",
            "lpt9.txt",
            "AUX .txt",
            "COM0",
            "lpt0.md",
            "COM\u{b9}",
            "com\u{b2}.txt",
            "LPT\u{b3}",
        ] {
            assert!(clean_name(bad).is_err(), "{bad:?} should be refused");
        }
        assert!(clean_name("COM10").is_ok());
        assert!(clean_name("COM\u{b9}0").is_ok());
        assert!(clean_name("Console").is_ok());
        assert!(clean_name("Résumé 2026").is_ok());
        assert!(clean_name(&"a".repeat(80)).is_ok());
        assert_eq!(
            clean_name(&"a".repeat(81)).unwrap_err().to_string(),
            "A name can have at most 80 characters"
        );
    }

    #[test]
    fn creates_lists_and_reads() {
        let fixture = library();
        let library = &fixture.library;
        let project = library.create_project("Talks").unwrap();
        assert_eq!(project.id, project_id("Talks"));
        let deck = library
            .create_deck(&project.id, "Sorting", "# One\n\n---\n\n# Two\n")
            .unwrap();
        assert_eq!(deck.id, deck_id("Talks", "Sorting.md"));
        assert_eq!(deck.slide_count, 2);
        assert_eq!(deck.path, library.root().join("Talks/Sorting.md"));
        let listed = library.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].decks, vec![deck.clone()]);
        assert_eq!(
            library.read_deck(&deck.id).unwrap(),
            "# One\n\n---\n\n# Two\n"
        );
    }

    #[test]
    fn skips_hidden_and_foreign_files() {
        let fixture = library();
        let library = &fixture.library;
        let root = library.root();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("Talks")).unwrap();
        fs::write(root.join("Talks/notes.txt"), "x").unwrap();
        fs::write(root.join("Talks/.draft.md"), "x").unwrap();
        fs::write(root.join("Talks/Deck.md"), "# A").unwrap();
        fs::write(root.join("loose.md"), "x").unwrap();
        let listed = library.list().unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|project| project.name.as_str())
                .collect::<Vec<_>>(),
            ["Talks"]
        );
        assert_eq!(
            listed[0]
                .decks
                .iter()
                .map(|deck| deck.name.as_str())
                .collect::<Vec<_>>(),
            ["Deck"]
        );
    }

    #[test]
    fn taken_names_are_refused_in_any_case() {
        let fixture = library();
        let library = &fixture.library;
        let project = library.create_project("Talks").unwrap();
        assert!(matches!(
            library.create_project("talks"),
            Err(LibraryError::NameTaken(_))
        ));
        library.create_deck(&project.id, "Sorting", "# A").unwrap();
        assert!(matches!(
            library.create_deck(&project.id, "SORTING", "# B"),
            Err(LibraryError::NameTaken(_))
        ));
    }

    #[test]
    fn renames_give_new_ids() {
        let fixture = library();
        let library = &fixture.library;
        let project = library.create_project("Talks").unwrap();
        let deck = library.create_deck(&project.id, "Sorting", "# A").unwrap();
        let renamed = library.rename_deck(&deck.id, "Searching").unwrap();
        assert_eq!(renamed.id, deck_id("Talks", "Searching.md"));
        assert!(matches!(
            library.read_deck(&deck.id),
            Err(LibraryError::DeckNotFound)
        ));
        let moved = library.rename_project(&project.id, "Lectures").unwrap();
        assert_eq!(moved.id, project_id("Lectures"));
        assert_eq!(moved.decks[0].id, deck_id("Lectures", "Searching.md"));
        assert_eq!(library.read_deck(&moved.decks[0].id).unwrap(), "# A");
        let other = library.create_project("Other").unwrap();
        assert!(matches!(
            library.rename_project(&other.id, "lectures"),
            Err(LibraryError::NameTaken(_))
        ));
        library.rename_project(&moved.id, "lectures").unwrap();
    }

    #[test]
    fn deletes() {
        let fixture = library();
        let library = &fixture.library;
        let project = library.create_project("Talks").unwrap();
        let deck = library.create_deck(&project.id, "Sorting", "# A").unwrap();
        library.delete_deck(&deck.id).unwrap();
        assert!(library.project(&project.id).unwrap().decks.is_empty());
        library.delete_project(&project.id).unwrap();
        assert!(library.list().unwrap().is_empty());
    }

    #[test]
    fn writes_compare_and_swap() {
        let fixture = library();
        let library = &fixture.library;
        let project = library.create_project("Talks").unwrap();
        let deck = library
            .create_deck(&project.id, "Sorting", "# A\n")
            .unwrap();
        assert_eq!(
            library
                .write_deck(&deck.id, "# B\n", Some("# A\n"))
                .unwrap(),
            WriteOutcome::Written
        );
        assert_eq!(
            library
                .write_deck(&deck.id, "# C\n", Some("# A\n"))
                .unwrap(),
            WriteOutcome::Conflict {
                current: "# B\n".into()
            }
        );
        assert_eq!(library.read_deck(&deck.id).unwrap(), "# B\n");
        assert_eq!(
            library.write_deck(&deck.id, "# D\n", None).unwrap(),
            WriteOutcome::Written
        );
        assert_eq!(
            serde_json::to_value(WriteOutcome::Conflict {
                current: "x".into()
            })
            .unwrap(),
            serde_json::json!({ "conflict": true, "current": "x" })
        );
        assert_eq!(
            serde_json::to_value(WriteOutcome::Written).unwrap(),
            serde_json::json!({ "ok": true })
        );
    }

    #[test]
    fn updates_read_and_write_under_one_lock() {
        let fixture = library();
        let library = &fixture.library;
        let project = library.create_project("Talks").unwrap();
        let deck = library
            .create_deck(&project.id, "Sorting", "# A\n")
            .unwrap();
        let (_, seen) = library
            .update_deck(&deck.id, |_, current| {
                (Some(format!("{current}more\n")), current.to_string())
            })
            .unwrap();
        assert_eq!(seen, "# A\n");
        assert_eq!(library.read_deck(&deck.id).unwrap(), "# A\nmore\n");
    }

    #[test]
    fn ids_never_become_paths() {
        let fixture = library();
        let library = &fixture.library;
        let outside = library.root().parent().unwrap().join("secret.md");
        fs::write(&outside, "secret").unwrap();
        for id in [
            "local-d-../secret.md",
            "../secret.md",
            outside.to_str().unwrap(),
            "local-d-",
            "local-d-0000000000000000",
        ] {
            assert!(
                matches!(library.read_deck(id), Err(LibraryError::DeckNotFound)),
                "{id}"
            );
        }
        assert!(matches!(
            library.create_deck("local-p-..", "x", "# A"),
            Err(LibraryError::ProjectNotFound)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn links_cannot_leave_the_library() {
        let fixture = library();
        let library = &fixture.library;
        let outside = library.root().parent().unwrap().join("elsewhere");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("Secret.md"), "secret").unwrap();
        std::os::unix::fs::symlink(&outside, library.root().join("Linked")).unwrap();
        let project = library.create_project("Talks").unwrap();
        std::os::unix::fs::symlink(
            outside.join("Secret.md"),
            library.root().join("Talks/Secret.md"),
        )
        .unwrap();
        assert_eq!(library.list().unwrap().len(), 1);
        assert!(library.project(&project.id).unwrap().decks.is_empty());
        assert!(matches!(
            library.read_deck(&deck_id("Linked", "Secret.md")),
            Err(LibraryError::DeckNotFound)
        ));
        assert!(matches!(
            library.read_deck(&deck_id("Talks", "Secret.md")),
            Err(LibraryError::DeckNotFound)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn saving_through_a_link_keeps_the_link_and_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = library();
        let library = &fixture.library;
        let root = library.root();
        fs::create_dir_all(root.join("Shared")).unwrap();
        let project = library.create_project("Talks").unwrap();
        fs::write(root.join("Shared/Intro.md"), "# Intro\n").unwrap();
        fs::set_permissions(
            root.join("Shared/Intro.md"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        std::os::unix::fs::symlink("../Shared/Intro.md", root.join("Talks/Intro.md")).unwrap();
        let deck = library.project(&project.id).unwrap().decks[0].clone();
        library
            .write_deck(&deck.id, "# Intro v2\n", Some("# Intro\n"))
            .unwrap();
        library
            .update_deck(&deck.id, |_, current| {
                (Some(format!("{current}more\n")), ())
            })
            .unwrap();
        let link = fs::symlink_metadata(root.join("Talks/Intro.md")).unwrap();
        assert!(link.file_type().is_symlink());
        assert_eq!(
            fs::read_to_string(root.join("Shared/Intro.md")).unwrap(),
            "# Intro v2\nmore\n"
        );
        let mode = fs::metadata(root.join("Shared/Intro.md"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_read_only_deck_is_left_alone() {
        let fixture = library();
        let library = &fixture.library;
        let project = library.create_project("Talks").unwrap();
        let deck = library
            .create_deck(&project.id, "Sorting", "# A\n")
            .unwrap();
        let mut permissions = fs::metadata(&deck.path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&deck.path, permissions).unwrap();
        assert!(matches!(
            library.write_deck(&deck.id, "# B\n", Some("# A\n")),
            Err(LibraryError::ReadOnly)
        ));
        assert!(matches!(
            library.update_deck(&deck.id, |_, _| (Some("# C\n".to_string()), ())),
            Err(LibraryError::ReadOnly)
        ));
        assert_eq!(library.read_deck(&deck.id).unwrap(), "# A\n");
        assert!(fs::metadata(&deck.path).unwrap().permissions().readonly());
    }

    #[cfg(unix)]
    #[test]
    fn a_project_folder_that_cannot_be_read_hides_nothing_else() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = library();
        let library = &fixture.library;
        let archive = library.create_project("Archive").unwrap();
        library.create_deck(&archive.id, "Old", "# Old\n").unwrap();
        let talks = library.create_project("Talks").unwrap();
        let deck = library.create_deck(&talks.id, "Sorting", "# A\n").unwrap();
        fs::set_permissions(&archive.path, fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads any folder, so there the folder only stands for one that can be read.
        let unreadable = fs::read_dir(&archive.path).is_err();
        let listed = library.list();
        let read = library.read_deck(&deck.id);
        let asked = library.project(&archive.id);
        fs::set_permissions(&archive.path, fs::Permissions::from_mode(0o755)).unwrap();
        let names: Vec<String> = listed
            .unwrap()
            .into_iter()
            .map(|project| project.name)
            .collect();
        assert_eq!(read.unwrap(), "# A\n");
        if unreadable {
            assert_eq!(names, ["Talks"]);
            assert!(matches!(asked, Err(LibraryError::Io(_))));
        } else {
            assert_eq!(names, ["Archive", "Talks"]);
        }
    }

    #[test]
    fn the_lock_lets_one_writer_in_at_a_time() {
        let fixture = library();
        let library = fixture.library.clone();
        let project = library.create_project("Talks").unwrap();
        let deck = library.create_deck(&project.id, "Count", "0").unwrap();
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let library = library.clone();
                let id = deck.id.clone();
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        library
                            .update_deck(&id, |_, current| {
                                let next = current.parse::<u32>().unwrap() + 1;
                                (Some(next.to_string()), ())
                            })
                            .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
        assert_eq!(library.read_deck(&deck.id).unwrap(), "80");
    }

    #[test]
    fn the_library_root_comes_from_settings() {
        let data = DataDir::new("/data");
        let settings = Settings {
            library_root: Some("/decks".into()),
            ..Settings::default()
        };
        assert_eq!(library_root(&settings, &data), PathBuf::from("/decks"));
        let relative = Settings {
            library_root: Some("mine".into()),
            ..Settings::default()
        };
        assert_eq!(library_root(&relative, &data), PathBuf::from("/data/mine"));
        assert!(library_root(&Settings::default(), &data).ends_with("Deyslide"));
    }
}
