//! Updates from new releases, on computers. A release build gets the
//! updater's public key and the address of `latest.json` through the
//! release workflow's `--config` file (`apps/native/scripts/app-version.sh`).
//! A build without them, such as one made on a laptop, has no updater: its
//! pages link to the download page instead.

/// Whether the build carries what the updater needs: a public key and at
/// least one address to ask. The updater plugin refuses to start without
/// a key, so the app adds it only then.
pub fn configured(config: &tauri::Config) -> bool {
    let Some(updater) = config.plugins.0.get("updater") else {
        return false;
    };
    let has_key = updater
        .get("pubkey")
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty());
    let has_endpoint = updater
        .get("endpoints")
        .and_then(|endpoints| endpoints.as_array())
        .is_some_and(|endpoints| endpoints.iter().any(|url| url.is_string()));
    has_key && has_endpoint
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(plugins: serde_json::Value) -> tauri::Config {
        let mut config: tauri::Config = serde_json::from_value(serde_json::json!({
            "identifier": "id.bambanggunawan.deyslide",
        }))
        .unwrap();
        config.plugins = serde_json::from_value(plugins).unwrap();
        config
    }

    const LATEST: &str =
        "https://github.com/bambanggunawanid/deyslide/releases/latest/download/latest.json";

    #[test]
    fn a_release_build_with_a_key_has_updates() {
        let plugins = serde_json::json!({
            "updater": { "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ=", "endpoints": [LATEST] },
        });
        assert!(configured(&config(plugins)));
    }

    #[test]
    fn a_build_without_a_key_has_none() {
        assert!(!configured(&config(serde_json::json!({}))));
        let empty_key = serde_json::json!({ "updater": { "pubkey": " ", "endpoints": [LATEST] } });
        assert!(!configured(&config(empty_key)));
        let no_endpoint = serde_json::json!({ "updater": { "pubkey": "a2V5", "endpoints": [] } });
        assert!(!configured(&config(no_endpoint)));
    }

    /// The configuration in the repository is the one a build without the
    /// release workflow gets, so it has no updater.
    #[test]
    fn the_committed_configuration_has_no_updater() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert!(config["plugins"].get("updater").is_none());
    }
}
