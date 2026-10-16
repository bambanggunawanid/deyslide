//! Where the app and `deyslide mcp` keep their shared files. Both compute
//! the same folder without Tauri: `dirs::data_dir()` plus the app
//! identifier, which is what Tauri's `app_data_dir()` returns on desktop.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// The app's identifier in `tauri.conf.json`.
pub const APP_IDENTIFIER: &str = "id.bambanggunawan.deyslide";

/// Moves the data folder elsewhere, for tests.
pub const DATA_DIR_ENV: &str = "DEYSLIDE_DATA_DIR";

/// The folder that holds `settings.json`, `render-bridge.json` and the library lock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DataDir(PathBuf);

impl DataDir {
    /// A data folder at a known place, such as the one Tauri gives the app on Android.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    /// The data folder this computer uses: `DEYSLIDE_DATA_DIR` when set,
    /// else [`app_data_dir`].
    pub fn locate() -> io::Result<Self> {
        app_data_dir().map(Self)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn settings_path(&self) -> PathBuf {
        self.0.join("settings.json")
    }

    pub fn bridge_path(&self) -> PathBuf {
        self.0.join("render-bridge.json")
    }

    /// The file every process locks while it changes the library.
    pub fn lock_path(&self) -> PathBuf {
        self.0.join("library.lock")
    }
}

/// `dirs::data_dir()/id.bambanggunawan.deyslide`, or `DEYSLIDE_DATA_DIR` when set.
pub fn app_data_dir() -> io::Result<PathBuf> {
    if let Some(path) = std::env::var_os(DATA_DIR_ENV).filter(|path| !path.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    dirs::data_dir()
        .map(|dir| dir.join(APP_IDENTIFIER))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("This computer has no folder for app data. Set {DATA_DIR_ENV}."),
            )
        })
}

pub fn settings_path() -> io::Result<PathBuf> {
    Ok(DataDir::locate()?.settings_path())
}

pub fn bridge_path() -> io::Result<PathBuf> {
    Ok(DataDir::locate()?.bridge_path())
}

pub fn lock_path() -> io::Result<PathBuf> {
    Ok(DataDir::locate()?.lock_path())
}

/// Writes a file so readers see either the old content or the new, never
/// a part: a temporary file in the same folder, then a rename over the old
/// one, whose permissions the new file keeps. The temporary name starts
/// with a dot, so the library skips it. A link at `path` is replaced by a
/// plain file: callers that want to keep it pass the link's target.
pub fn write_atomically(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_atomically_with(path, contents, false)
}

/// Like [`write_atomically`], but only the owner can read the file (on Unix).
pub fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    write_atomically_with(path, contents, true)
}

fn write_atomically_with(path: &Path, contents: &[u8], private: bool) -> io::Result<()> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let folder = path
        .parent()
        .filter(|folder| !folder.as_os_str().is_empty());
    let folder = folder.unwrap_or(Path::new("."));
    fs::create_dir_all(folder)?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.subsec_nanos())
        .unwrap_or_default();
    let temp = folder.join(format!(
        ".deyslide-{}-{}-{nanos}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    // A private file is always for its owner only; any other keeps what the old one allowed.
    let permissions = if private {
        None
    } else {
        fs::metadata(path).ok().map(|old| old.permissions())
    };
    let result = (|| {
        let mut file = create_new(&temp, private)?;
        file.write_all(contents)?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)?;
        }
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, path)?;
        sync_folder(folder);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn create_new(path: &Path, private: bool) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    options.open(path)
}

/// Makes a rename durable where the system allows it.
fn sync_folder(folder: &Path) {
    #[cfg(unix)]
    if let Ok(dir) = File::open(folder) {
        let _ = dir.sync_all();
    }
    #[cfg(not(unix))]
    let _ = folder;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_files_live_in_one_folder() {
        let dir = DataDir::new("/data");
        assert_eq!(dir.settings_path(), Path::new("/data/settings.json"));
        assert_eq!(dir.bridge_path(), Path::new("/data/render-bridge.json"));
        assert_eq!(dir.lock_path(), Path::new("/data/library.lock"));
    }

    #[test]
    fn the_data_folder_matches_tauri_app_data_dir() {
        // Tauri 2 resolves `app_data_dir()` as `dirs::data_dir()` joined with the identifier.
        if std::env::var_os(DATA_DIR_ENV).is_none() {
            if let Some(base) = dirs::data_dir() {
                assert_eq!(
                    app_data_dir().unwrap(),
                    base.join("id.bambanggunawan.deyslide")
                );
            }
        }
    }

    #[test]
    fn atomic_writes_replace_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deep/file.txt");
        write_atomically(&path, b"first").unwrap();
        write_atomically(&path, b"second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["file.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_replaced_file_keeps_its_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("deck.md");
        write_atomically(&path, b"first").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write_atomically(&path, b"second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn private_files_are_for_the_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.json");
        write_private(&path, b"{}").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
