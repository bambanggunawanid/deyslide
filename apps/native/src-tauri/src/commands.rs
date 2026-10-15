//! The commands the web pages call with `invoke`. Errors come back as
//! their message. The wrappers in `apps/web/src/platform/native.ts` name
//! every command and its payload.

use std::path::{Path, PathBuf};

use deyslide_core::bridge::RenderedSlide;
use deyslide_core::library::{DeckInfo, Library, LibraryError, ProjectInfo, WriteOutcome};
use deyslide_core::settings::write_settings;
use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

use crate::auth::AuthError;
use crate::mcp_setup::{mcp_setup as setup_command, McpSetup};
use crate::render_bridge::RenderAnswer;
use crate::sign_in::Account;
use crate::state::AppState;
use crate::{account, debug, LIBRARY_CHANGED};

type CommandResult<T> = Result<T, String>;

/// Runs file work off the async threads: the library waits on a lock that
/// `deyslide mcp` may hold.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

fn message(error: LibraryError) -> String {
    error.to_string()
}

async fn with_library<T: Send + 'static>(
    state: &AppState,
    work: impl FnOnce(Library) -> Result<T, LibraryError> + Send + 'static,
) -> CommandResult<T> {
    let libraries = state.libraries();
    blocking(move || work(libraries.open()?).map_err(message)).await
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LibraryInfo {
    /// The library folder.
    pub root: String,
    /// Whether that folder exists yet. The app creates it on first use.
    pub exists: bool,
}

fn library_info_for(root: &Path) -> LibraryInfo {
    LibraryInfo {
        root: root.to_string_lossy().into_owned(),
        exists: root.is_dir(),
    }
}

#[tauri::command]
pub async fn library_info(state: State<'_, AppState>) -> CommandResult<LibraryInfo> {
    let root = state.library_root()?;
    blocking(move || Ok(library_info_for(&root))).await
}

/// Makes `path` the library folder for the app and `deyslide mcp`.
#[tauri::command]
pub async fn library_set_root(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CommandResult<LibraryInfo> {
    if cfg!(mobile) {
        return Err("The library folder cannot be changed on this device.".into());
    }
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err("Pick a whole folder path for the library.".into());
    }
    let mut settings = state.settings()?;
    let settings_path = state.data_dir.settings_path();
    let lock = state.data_dir.lock_path();
    let root = blocking(move || {
        let library = Library::open(&path, lock).map_err(|error| {
            format!(
                "The folder {} cannot be used for the library: {error}",
                path.display()
            )
        })?;
        let root = library.root().to_path_buf();
        settings.library_root = Some(root.to_string_lossy().into_owned());
        write_settings(&settings_path, &settings)
            .map_err(|error| format!("The setting could not be saved: {error}"))?;
        Ok(root)
    })
    .await?;
    crate::watch_library(&app);
    let _ = app.emit(LIBRARY_CHANGED, ());
    Ok(library_info_for(&root))
}

#[tauri::command]
pub async fn library_list(state: State<'_, AppState>) -> CommandResult<Vec<ProjectInfo>> {
    with_library(&state, |library| library.list()).await
}

#[tauri::command]
pub async fn library_create_project(
    state: State<'_, AppState>,
    name: String,
) -> CommandResult<ProjectInfo> {
    with_library(&state, move |library| library.create_project(&name)).await
}

/// Renames a project's folder. The project and its decks get new ids.
#[tauri::command]
pub async fn library_rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> CommandResult<ProjectInfo> {
    with_library(&state, move |library| library.rename_project(&id, &name)).await
}

/// Moves a project's folder to the trash where the system has one. The
/// page asks the person first.
#[tauri::command]
pub async fn library_delete_project(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    with_library(&state, move |library| {
        library.locked(|| {
            let project = library.project(&id)?;
            remove(&project.path)
        })
    })
    .await
}

#[tauri::command]
pub async fn library_create_deck(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
    markdown: String,
) -> CommandResult<DeckInfo> {
    with_library(&state, move |library| {
        library.create_deck(&project_id, &name, &markdown)
    })
    .await
}

/// Renames a deck's file. The deck gets a new id.
#[tauri::command]
pub async fn library_rename_deck(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> CommandResult<DeckInfo> {
    with_library(&state, move |library| library.rename_deck(&id, &name)).await
}

/// Moves a deck's file to the trash where the system has one.
#[tauri::command]
pub async fn library_delete_deck(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    with_library(&state, move |library| {
        library.locked(|| {
            let deck = library.deck(&id)?;
            remove(&deck.path)
        })
    })
    .await
}

#[tauri::command]
pub async fn library_read_deck(state: State<'_, AppState>, id: String) -> CommandResult<String> {
    with_library(&state, move |library| library.read_deck(&id)).await
}

/// Writes a deck only when its file still holds `expected`; otherwise
/// answers `{ conflict: true, current }` and writes nothing.
#[tauri::command]
pub async fn library_write_deck(
    state: State<'_, AppState>,
    id: String,
    content: String,
    expected: Option<String>,
) -> CommandResult<WriteOutcome> {
    with_library(&state, move |library| {
        library.write_deck(&id, &content, expected.as_deref())
    })
    .await
}

/// To the system's trash on a computer when it has one, else deleted.
fn remove(path: &Path) -> Result<(), LibraryError> {
    #[cfg(desktop)]
    if trash::delete(path).is_ok() {
        return Ok(());
    }
    if path.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// The page's answer to a `render-request` event.
#[tauri::command]
pub fn render_respond(state: State<'_, AppState>, id: String, slides: Vec<RenderedSlide>) {
    state.renders.respond(RenderAnswer { id, slides });
}

/// The main window's page started (or stopped) listening for
/// `render-request`. Requests wait for it, since Tauri drops events that
/// nobody listens to. Other windows do not draw for Claude Code.
#[tauri::command]
pub fn render_ready(window: WebviewWindow, state: State<'_, AppState>, ready: bool) {
    if window.label() == crate::window::MAIN {
        state.renders.set_listening(ready);
    }
}

/// Signs in through the browser. On a computer it returns once signed in;
/// on Android once the browser is open. Both send `account-changed` when
/// the sign in ends.
#[tauri::command]
pub async fn auth_sign_in(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let server = state.server_url();
    if cfg!(mobile) {
        account::begin_sign_in_on_phone(&app, &state, &server).await
    } else {
        account::sign_in_on_computer(&app, &state, &server).await
    }
}

#[tauri::command]
pub async fn auth_sign_out(app: AppHandle, state: State<'_, AppState>) -> CommandResult<()> {
    let ended = state
        .auth
        .sign_out()
        .await
        .map_err(|error| error.to_string())?;
    let _ = app.emit(crate::ACCOUNT_CHANGED, ());
    if let Some(tokens) = ended {
        if let Some(refresh_token) = tokens.refresh_token {
            state
                .auth
                .endpoint()
                .revoke(&tokens.server, &tokens.client_id, &refresh_token)
                .await;
        }
    }
    Ok(())
}

/// A working access token for the server's API.
#[tauri::command]
pub async fn auth_access_token(state: State<'_, AppState>) -> CommandResult<String> {
    let server = state.server_url();
    state
        .auth
        .access_token(&server)
        .await
        .map_err(|error| error.to_string())
}

/// The signed in person, or `null` when signed out.
#[tauri::command]
pub async fn auth_account(state: State<'_, AppState>) -> CommandResult<Option<Account>> {
    let server = state.server_url();
    let token = match state.auth.access_token(&server).await {
        Ok(token) => token,
        Err(AuthError::SignedOut) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    state.auth.endpoint().account(&server, &token).await
}

/// The command that connects Claude Code to this app.
#[tauri::command]
pub fn mcp_setup() -> McpSetup {
    match std::env::current_exe() {
        Ok(exe) => setup_command(
            &exe,
            crate::launch::running_appimage(&exe).as_deref(),
            std::env::consts::OS,
        ),
        Err(error) => McpSetup::Problem {
            problem: format!("Deyslide could not find its own program file: {error}"),
        },
    }
}

/// Opens the audience window for a deck (computers only). Async, since
/// building a window in a synchronous command deadlocks on Windows.
#[tauri::command]
pub async fn present_open(
    app: AppHandle,
    project_id: String,
    deck_id: String,
) -> CommandResult<()> {
    open_present(&app, &project_id, &deck_id)
}

#[cfg(desktop)]
fn open_present(app: &AppHandle, project_id: &str, deck_id: &str) -> CommandResult<()> {
    crate::window::open_present(app, project_id, deck_id).map_err(|error| error.to_string())
}

#[cfg(mobile)]
fn open_present(_app: &AppHandle, _project_id: &str, _deck_id: &str) -> CommandResult<()> {
    Err("A second window is not available on this device. Present in this window.".into())
}

/// The header that carries `save_file`'s path, URI encoded.
pub const SAVE_PATH_HEADER: &str = "x-deyslide-path";

/// Saves bytes to a path the person picked in a save dialog (computers
/// only; Android saves through the fs plugin). The bytes are the request
/// body, the path is in [`SAVE_PATH_HEADER`].
#[tauri::command]
pub async fn save_file(request: Request<'_>) -> CommandResult<()> {
    if cfg!(mobile) {
        return Err("Saving through save_file is not available on this device.".into());
    }
    let path = request
        .headers()
        .get(SAVE_PATH_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            percent_encoding::percent_decode_str(value)
                .decode_utf8()
                .ok()
        })
        .map(|path| PathBuf::from(path.as_ref()))
        .filter(|path| path.is_absolute())
        .ok_or("save_file needs the file's whole path.")?;
    let bytes =
        body_bytes(request.body()).ok_or("save_file takes the file's bytes as its body.")?;
    blocking(move || {
        deyslide_core::paths::write_atomically(&path, &bytes)
            .map_err(|error| format!("The file could not be saved to {}: {error}", path.display()))
    })
    .await
}

/// The raw body, or a JSON list of bytes when the page could not send it raw.
fn body_bytes(body: &InvokeBody) -> Option<Vec<u8>> {
    match body {
        InvokeBody::Raw(bytes) => Some(bytes.clone()),
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| value.as_u64().and_then(|byte| u8::try_from(byte).ok()))
            .collect(),
        InvokeBody::Json(_) => None,
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    /// `windows`, `macos`, `linux` or `android`.
    pub platform: &'static str,
    pub server_url: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle, state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS,
        server_url: state.server_url(),
    }
}

/// Prints a preview message to stderr when `DEYSLIDE_DEBUG_PREVIEW` is set.
#[tauri::command]
pub fn debug_preview_log(message: String) {
    debug::log(&message);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_info_says_whether_the_folder_exists() {
        let dir = tempfile::tempdir().unwrap();
        assert!(library_info_for(dir.path()).exists);
        assert!(!library_info_for(&dir.path().join("Deyslide")).exists);
        assert_eq!(
            serde_json::to_value(library_info_for(Path::new("/nowhere/Deyslide"))).unwrap(),
            serde_json::json!({ "root": "/nowhere/Deyslide", "exists": false })
        );
    }

    #[test]
    fn saved_bytes_come_raw_or_as_a_list() {
        assert_eq!(
            body_bytes(&InvokeBody::Raw(vec![1, 2, 255])),
            Some(vec![1, 2, 255])
        );
        assert_eq!(
            body_bytes(&InvokeBody::Json(serde_json::json!([1, 2, 255]))),
            Some(vec![1, 2, 255])
        );
        assert_eq!(
            body_bytes(&InvokeBody::Json(serde_json::json!([256]))),
            None
        );
        assert_eq!(
            body_bytes(&InvokeBody::Json(serde_json::json!({ "a": 1 }))),
            None
        );
    }

    #[test]
    fn app_info_is_camel_case() {
        let info = AppInfo {
            version: "0.1.0".into(),
            platform: "linux",
            server_url: "https://deyslide.example".into(),
        };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            serde_json::json!({ "version": "0.1.0", "platform": "linux", "serverUrl": "https://deyslide.example" })
        );
    }

    fn read(path: impl AsRef<Path>) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
        std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
    }

    /// The names a page passes for a command's parameters: camelCase,
    /// without the ones Tauri fills in.
    fn page_arguments(source: &str, command: &str) -> Vec<String> {
        let start = source
            .find(&format!("fn {command}("))
            .unwrap_or_else(|| panic!("no fn {command} in commands.rs"))
            + command.len()
            + 4;
        let mut depth = 0;
        let mut end = start;
        for (offset, character) in source[start..].char_indices() {
            match character {
                '(' | '<' => depth += 1,
                '>' if depth > 0 => depth -= 1,
                ')' if depth == 0 => {
                    end = start + offset;
                    break;
                }
                ')' => depth -= 1,
                _ => {}
            }
        }
        let mut parameters = Vec::new();
        let (mut depth, mut current) = (0, String::new());
        for character in source[start..end].chars() {
            match character {
                '<' => depth += 1,
                '>' => depth -= 1,
                ',' if depth == 0 => {
                    parameters.push(std::mem::take(&mut current));
                    continue;
                }
                _ => {}
            }
            current.push(character);
        }
        parameters.push(current);
        parameters
            .iter()
            .filter_map(|parameter| parameter.split_once(':'))
            .filter(|(_, kind)| {
                let kind = kind.trim();
                !kind.starts_with("State<")
                    && kind != "AppHandle"
                    && kind != "WebviewWindow"
                    && !kind.starts_with("Request<")
            })
            .map(|(name, _)| {
                let mut camel = String::new();
                let mut upper = false;
                for character in name.trim().chars() {
                    if character == '_' {
                        upper = true;
                    } else if upper {
                        camel.extend(character.to_uppercase());
                        upper = false;
                    } else {
                        camel.push(character);
                    }
                }
                camel
            })
            .collect()
    }

    /// The commands the app registers, the permissions it grants and the
    /// web wrappers (checked in features/native-bridge.feature) agree.
    #[test]
    fn every_command_is_registered_permitted_and_wrapped() {
        let lib = read("src/lib.rs");
        let build = read("build.rs");
        let capability = read("capabilities/default.json");
        let source = read("src/commands.rs");
        let feature = read("../../../features/native-bridge.feature");
        let registered: Vec<&str> = lib
            .lines()
            .filter_map(|line| line.trim().strip_prefix("commands::"))
            .map(|line| line.trim_end_matches(','))
            .collect();
        assert_eq!(registered.len(), 22);
        for command in &registered {
            assert!(
                build.contains(&format!("\"{command}\"")),
                "build.rs lacks {command}"
            );
            let permission = format!("\"allow-{}\"", command.replace('_', "-"));
            assert!(
                capability.contains(&permission),
                "the capability lacks {permission}"
            );
            if *command != "debug_preview_log" {
                assert!(
                    feature.contains(&format!("| {command} "))
                        || feature.contains(&format!("\"{command}\"")),
                    "no scenario covers {command}"
                );
            }
        }
        // Table rows `| call | command | arguments |`, and steps
        // `the app gets the command "name" with {...}`.
        let mut rows = 0;
        let mut steps = 0;
        for line in feature.lines() {
            let cells: Vec<&str> = line.split('|').map(str::trim).collect();
            let (command, arguments) = match cells.as_slice() {
                [_, _, command, arguments, _] => (*command, *arguments),
                _ => match line
                    .split_once("the app gets the command \"")
                    .and_then(|(_, rest)| rest.split_once("\" with "))
                {
                    Some((command, arguments)) if arguments.starts_with('{') => {
                        steps += 1;
                        (command, arguments)
                    }
                    _ => continue,
                },
            };
            if !registered.contains(&command) {
                continue;
            }
            rows += 1;
            let mut expected: Vec<String> = match arguments {
                "no arguments" => Vec::new(),
                json => serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(json)
                    .unwrap()
                    .keys()
                    .cloned()
                    .collect(),
            };
            let mut actual = page_arguments(&source, command);
            expected.sort();
            actual.sort();
            assert_eq!(actual, expected, "the arguments of {command}");
        }
        assert_eq!((rows, steps), (22, 2));
    }
}
