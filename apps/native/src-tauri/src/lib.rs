//! The Deyslide app: the web app in a window, with decks as Markdown files
//! in a library folder, the account in the cloud, and the render bridge
//! that lets `deyslide mcp` draw slides for Claude Code.
//!
//! The same binary is the MCP server: `deyslide mcp` runs it on stdin and
//! stdout without starting any of the app (see [`main`]).

use std::process::ExitCode;
use std::sync::Arc;

use deyslide_core::bridge::{read_bridge, remove_bridge};
use deyslide_core::mcp::{self, ServeOptions};
use deyslide_core::paths::{DataDir, DATA_DIR_ENV};
use serde::Serialize;
use tauri::ipc::CapabilityBuilder;
use tauri::{App, AppHandle, Emitter, Manager, RunEvent};

pub mod account;
pub mod auth;
pub mod cli;
pub mod commands;
pub mod debug;
pub mod launch;
pub mod mcp_setup;
pub mod oauth;
pub mod render_bridge;
pub mod sign_in;
pub mod state;
pub mod updates;
pub mod watcher;
pub mod window;

use crate::auth::{TokenStore, AUTH_FILE};
use crate::sign_in::HttpOAuth;
use crate::state::AppState;
use crate::watcher::LibraryWatcher;
use crate::window::MAIN;

/// Something in the library folder changed.
pub const LIBRARY_CHANGED: &str = "library-changed";
/// A deck's file changed: `{ deckId }`.
pub const DECK_CHANGED: &str = "deck-changed";
/// `deyslide mcp` wants slides drawn: [`RenderRequestEvent`].
pub const RENDER_REQUEST: &str = "render-request";
/// Signed in or out.
pub const ACCOUNT_CHANGED: &str = "account-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckChanged {
    deck_id: String,
}

/// The `deyslide` binary: `deyslide mcp` serves MCP, anything else opens the app.
pub fn main() -> ExitCode {
    match cli::parse(std::env::args_os()) {
        Ok(cli::Invocation::App) => {
            run();
            ExitCode::SUCCESS
        }
        Ok(cli::Invocation::McpHelp) => {
            eprintln!("{}", mcp::USAGE);
            ExitCode::SUCCESS
        }
        Ok(cli::Invocation::Mcp(args)) => match serve_mcp(args) {
            Ok(()) => ExitCode::SUCCESS,
            Err(message) => {
                eprintln!("deyslide mcp: {message}");
                ExitCode::FAILURE
            }
        },
        Err(message) => {
            eprintln!("deyslide: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Runs the MCP server for Claude Code on a plain runtime. Nothing of the
/// app starts here: its single instance plugin would end this process when
/// the app is already open. Only MCP messages go to stdout.
fn serve_mcp(args: Vec<String>) -> Result<(), String> {
    let mut options = ServeOptions::from_args(args)?;
    // An app this server starts must use the same data folder, or the two
    // never find each other's render-bridge.json.
    let data_dir = options
        .data_dir
        .clone()
        .or_else(|| {
            std::env::var_os(DATA_DIR_ENV)
                .filter(|dir| !dir.is_empty())
                .map(Into::into)
        })
        .map(std::path::absolute)
        .transpose()
        .map_err(|error| format!("The data folder cannot be found: {error}"))?;
    options.launch_app = Some(Arc::new(move || launch::launch_app(data_dir.as_deref())));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime
        .block_on(mcp::serve(options))
        .map_err(|error| error.to_string())
}

/// Starts the app.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        // A second launch shows the open window instead.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            window::show_main(app);
        }));
        // Only a release build knows the key that signs updates.
        if updates::configured(context.config()) {
            builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        }
    }
    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init());
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_deep_link::init());
    }
    let app = builder
        .invoke_handler(tauri::generate_handler![
            commands::library_info,
            commands::library_set_root,
            commands::library_list,
            commands::library_create_project,
            commands::library_rename_project,
            commands::library_delete_project,
            commands::library_create_deck,
            commands::library_rename_deck,
            commands::library_delete_deck,
            commands::library_read_deck,
            commands::library_write_deck,
            commands::render_respond,
            commands::render_ready,
            commands::auth_sign_in,
            commands::auth_sign_out,
            commands::auth_access_token,
            commands::auth_account,
            commands::mcp_setup,
            commands::present_open,
            commands::save_file,
            commands::app_info,
            commands::app_restart,
            commands::debug_preview_log,
        ])
        .setup(|app| {
            setup(app)?;
            Ok(())
        })
        .build(context)
        .expect("Deyslide could not start");
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            stop(app);
        }
    });
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = data_dir(app)?;
    let handle = app.handle().clone();
    let auth = TokenStore::load(
        data_dir.path().join(AUTH_FILE),
        HttpOAuth::new(),
        move || {
            let _ = handle.emit(ACCOUNT_CHANGED, ());
        },
    );
    let state = AppState::new(data_dir, auth);
    let server = state.server_url();
    let renders = state.renders.clone();
    app.manage(state);
    allow_server(app, &server)?;
    // A page that reloads or closes no longer listens for render requests.
    window::build_main(app, move || renders.set_listening(false))?;
    watch_library(app.handle());
    #[cfg(desktop)]
    start_render_bridge(app.handle());
    #[cfg(all(desktop, unix))]
    exit_on_signals(app.handle());
    #[cfg(mobile)]
    finish_sign_in_from_links(app);
    Ok(())
}

/// The folder for settings, the bridge file and the sign in. A computer
/// computes it the way `deyslide mcp` does; a phone has Tauri's.
fn data_dir(app: &App) -> Result<DataDir, Box<dyn std::error::Error>> {
    if cfg!(mobile) {
        Ok(DataDir::new(app.path().app_data_dir()?))
    } else {
        Ok(DataDir::locate()?)
    }
}

/// Lets the pages reach the server through the http plugin. The server
/// comes from the settings, so a new one takes effect after a restart.
fn allow_server(app: &App, server: &str) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("server")
            .windows([MAIN, "present-*"])
            .permission_scoped(
                "http:default",
                vec![serde_json::json!({ "url": format!("{server}/*") })],
                Vec::<serde_json::Value>::new(),
            ),
    )
}

/// Watches the library folder, in place of any folder watched before.
pub fn watch_library(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut watching = state.watcher.lock().unwrap();
    *watching = None;
    let root = match state.libraries().open() {
        Ok(library) => library.root().to_path_buf(),
        Err(message) => {
            eprintln!("deyslide: {message}");
            return;
        }
    };
    let emitter = app.clone();
    let started = LibraryWatcher::start(root, move |changes| {
        if changes.library {
            let _ = emitter.emit(LIBRARY_CHANGED, ());
        }
        for deck_id in changes.decks {
            let _ = emitter.emit(DECK_CHANGED, DeckChanged { deck_id });
        }
    });
    match started {
        Ok(watcher) => *watching = Some(watcher),
        Err(error) => eprintln!("deyslide: the library folder cannot be watched: {error}"),
    }
}

/// Serves the render bridge and writes `render-bridge.json` for `deyslide mcp`.
#[cfg(desktop)]
fn start_render_bridge(app: &AppHandle) {
    use crate::render_bridge::{PageRenderer, RenderRequestEvent};
    use deyslide_core::bridge::write_bridge;

    let state = app.state::<AppState>();
    let path = state.data_dir.bridge_path();
    let hub = state.renders.clone();
    let page = app.clone();
    let renderer = PageRenderer {
        hub,
        send: move |event: RenderRequestEvent| {
            // Hidden or minimized windows get no animation frames, so
            // slides would never finish drawing.
            if let Some(window) = page.get_webview_window(MAIN) {
                let _ = window.unminimize();
                let _ = window.show();
            }
            page.emit_to(MAIN, RENDER_REQUEST, event)
                .map_err(|error| error.to_string())
        },
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match render_bridge::serve(Arc::new(renderer)).await {
            Ok(info) => match write_bridge(&path, &info) {
                Ok(()) => *app.state::<AppState>().bridge_file.lock().unwrap() = Some(path),
                Err(error) => eprintln!("deyslide: {} cannot be written: {error}", path.display()),
            },
            Err(error) => eprintln!("deyslide: the render bridge cannot listen: {error}"),
        }
    });
}

/// Quits the app properly when the system or a terminal asks it to end
/// (SIGTERM, SIGINT, SIGHUP), so the bridge file goes away with it.
#[cfg(all(desktop, unix))]
fn exit_on_signals(app: &AppHandle) {
    use tokio::signal::unix::{signal, SignalKind};

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (Ok(mut terminate), Ok(mut interrupt), Ok(mut hang_up)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
            signal(SignalKind::hangup()),
        ) else {
            return;
        };
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
            _ = hang_up.recv() => {}
        }
        app.exit(0);
    });
}

/// Finishes a sign in when the browser opens the app's link, whether the
/// app was still running or starts from the link.
#[cfg(mobile)]
fn finish_sign_in_from_links(app: &App) {
    use tauri_plugin_deep_link::DeepLinkExt;

    let finish = |app: AppHandle, url: String| {
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            let server = state.server_url();
            if let Err(message) = account::finish_from_link(&app, &state, &server, &url).await {
                eprintln!("deyslide: {message}");
            }
        });
    };
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            finish(app.handle().clone(), url.to_string());
        }
    }
    let handle = app.handle().clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            finish(handle.clone(), url.to_string());
        }
    });
}

/// Removes the bridge file when this app wrote it.
fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    let path = state.bridge_file.lock().unwrap().take();
    if let Some(path) = path {
        if read_bridge(&path).is_some_and(|info| info.pid == std::process::id()) {
            let _ = remove_bridge(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render_bridge::RenderRequestEvent;
    use deyslide_core::bridge::{BridgeSlide, Clicks};

    /// The events in features/native-bridge.feature's examples, with
    /// the payloads the page hears there.
    fn feature_events() -> Vec<(String, serde_json::Value)> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../features/native-bridge.feature");
        let feature = std::fs::read_to_string(&path).unwrap();
        feature
            .lines()
            .filter_map(|line| {
                let cells: Vec<&str> = line.split('|').map(str::trim).collect();
                let [_, wrapper, event, payload, _, _] = cells.as_slice() else {
                    return None;
                };
                let payload = serde_json::from_str(payload).ok()?;
                wrapper
                    .starts_with("on")
                    .then(|| (event.to_string(), payload))
            })
            .collect()
    }

    /// The names and payloads the app sends are the ones the web wrappers expect.
    #[test]
    fn events_match_the_web_wrappers() {
        let sent = [
            (LIBRARY_CHANGED, serde_json::to_value(()).unwrap()),
            (
                DECK_CHANGED,
                serde_json::to_value(DeckChanged {
                    deck_id: "local-d-0123456789abcdef".into(),
                })
                .unwrap(),
            ),
            (
                RENDER_REQUEST,
                serde_json::to_value(RenderRequestEvent {
                    id: "r1".into(),
                    markdown: "Hello".into(),
                    slides: vec![BridgeSlide {
                        number: 1,
                        clicks: Clicks::Last,
                    }],
                    width: 1280,
                    height: 720,
                })
                .unwrap(),
            ),
            (ACCOUNT_CHANGED, serde_json::to_value(()).unwrap()),
        ];
        let heard = feature_events();
        assert_eq!(heard.len(), 5, "{heard:?}");
        for (event, payload) in sent {
            assert!(
                heard.contains(&(event.to_string(), payload.clone())),
                "no scenario hears {event} with {payload}"
            );
        }
    }
}
