//! `settings.json` in the data folder: the choices the app saves and
//! `deyslide mcp` reads again on every call, so both use the same library.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::paths::write_atomically;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// The library folder the person picked. Missing means the default one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub library_root: Option<String>,
    /// The Deyslide server the app signs in to. Missing means the public one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    /// Keys a newer app wrote, kept as they are when an older one saves.
    #[serde(flatten)]
    pub other: Map<String, Value>,
}

#[derive(Debug)]
pub enum SettingsError {
    Io(PathBuf, io::Error),
    Invalid(PathBuf, serde_json::Error),
}

impl fmt::Display for SettingsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(path, error) => write!(
                formatter,
                "The Deyslide settings file {} cannot be read: {error}",
                path.display()
            ),
            Self::Invalid(path, error) => write!(
                formatter,
                "The Deyslide settings file {} is not valid: {error}",
                path.display()
            ),
        }
    }
}

impl std::error::Error for SettingsError {}

/// The settings in `path`, or the defaults when the file does not exist yet.
pub fn read_settings(path: &Path) -> Result<Settings, SettingsError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| SettingsError::Invalid(path.into(), error)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(error) => Err(SettingsError::Io(path.into(), error)),
    }
}

/// Saves the settings in one step, creating the data folder when needed.
pub fn write_settings(path: &Path, settings: &Settings) -> io::Result<()> {
    let mut json = serde_json::to_vec_pretty(settings).map_err(io::Error::other)?;
    json.push(b'\n');
    write_atomically(path, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_settings_are_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read_settings(&dir.path().join("settings.json")).unwrap(),
            Settings::default()
        );
    }

    #[test]
    fn settings_round_trip_and_keep_unknown_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{ "libraryRoot": "/decks", "theme": "dark" }"#).unwrap();
        let mut settings = read_settings(&path).unwrap();
        assert_eq!(settings.library_root.as_deref(), Some("/decks"));
        settings.server_url = Some("https://example.test".into());
        write_settings(&path, &settings).unwrap();
        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            saved,
            serde_json::json!({ "libraryRoot": "/decks", "serverUrl": "https://example.test", "theme": "dark" })
        );
    }

    #[test]
    fn broken_settings_say_where_they_are() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ nope").unwrap();
        let error = read_settings(&path).unwrap_err().to_string();
        assert!(error.contains("settings.json is not valid"), "{error}");
    }
}
