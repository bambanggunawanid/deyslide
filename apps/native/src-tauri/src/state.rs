//! What the app keeps while it runs.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use deyslide_core::library::{library_root, Library};
use deyslide_core::paths::DataDir;
use deyslide_core::settings::{read_settings, Settings};
use url::Url;

use crate::auth::TokenStore;
use crate::render_bridge::RenderHub;
use crate::sign_in::HttpOAuth;
use crate::watcher::LibraryWatcher;

/// The Deyslide server the app signs in to unless the settings name another.
pub const DEFAULT_SERVER_URL: &str = "https://deyslide.bambanggunawan.id";

pub struct AppState {
    pub data_dir: DataDir,
    pub auth: Arc<TokenStore<HttpOAuth>>,
    pub renders: Arc<RenderHub>,
    pub watcher: Mutex<Option<LibraryWatcher>>,
    /// `render-bridge.json`, once the bridge listens.
    pub bridge_file: Mutex<Option<PathBuf>>,
}

impl AppState {
    pub fn new(data_dir: DataDir, auth: TokenStore<HttpOAuth>) -> Self {
        Self {
            data_dir,
            auth: Arc::new(auth),
            renders: Arc::default(),
            watcher: Mutex::new(None),
            bridge_file: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> Result<Settings, String> {
        read_settings(&self.data_dir.settings_path()).map_err(|error| error.to_string())
    }

    /// The server from the settings, or the public one.
    pub fn server_url(&self) -> String {
        server_url(
            self.settings()
                .ok()
                .and_then(|settings| settings.server_url)
                .as_deref(),
        )
    }

    /// Where the library is, as `deyslide mcp` finds it too.
    pub fn library_root(&self) -> Result<PathBuf, String> {
        Ok(library_root(&self.settings()?, &self.data_dir))
    }

    pub fn libraries(&self) -> Libraries {
        Libraries {
            data_dir: self.data_dir.clone(),
        }
    }
}

/// Opens the library afresh for each command, so a folder the person
/// picked in another window, or edited settings, take effect at once.
#[derive(Clone)]
pub struct Libraries {
    data_dir: DataDir,
}

impl Libraries {
    pub fn open(&self) -> Result<Library, String> {
        let settings =
            read_settings(&self.data_dir.settings_path()).map_err(|error| error.to_string())?;
        let root = library_root(&settings, &self.data_dir);
        Library::open(&root, self.data_dir.lock_path()).map_err(|error| {
            format!(
                "The library folder {} cannot be opened: {error}",
                root.display()
            )
        })
    }
}

/// A server address from the settings, without a trailing slash, when it
/// is an http or https URL; else the public server.
pub fn server_url(setting: Option<&str>) -> String {
    setting
        .map(|value| value.trim().trim_end_matches('/'))
        .filter(|value| {
            Url::parse(value).is_ok_and(|url| {
                matches!(url.scheme(), "http" | "https") && url.host_str().is_some()
            })
        })
        .unwrap_or(DEFAULT_SERVER_URL)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_comes_from_the_settings_when_it_is_a_web_address() {
        assert_eq!(server_url(None), "https://deyslide.bambanggunawan.id");
        assert_eq!(
            server_url(Some("https://slides.example.org/")),
            "https://slides.example.org"
        );
        assert_eq!(
            server_url(Some(" http://localhost:3001 ")),
            "http://localhost:3001"
        );
        assert_eq!(server_url(Some("ftp://files.example")), DEFAULT_SERVER_URL);
        assert_eq!(server_url(Some("not a url")), DEFAULT_SERVER_URL);
        assert_eq!(server_url(Some("")), DEFAULT_SERVER_URL);
    }
}
