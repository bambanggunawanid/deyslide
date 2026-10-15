//! The app's windows. Every window that shows a slide preview is built in
//! Rust with [`allow_any_origin`]: the preview runs in a sandboxed frame
//! whose origin is `null`, and its module scripts load only when the app's
//! files answer with `Access-Control-Allow-Origin: *`.

use std::borrow::Cow;

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use tauri::http::header::{HeaderValue, ACCESS_CONTROL_ALLOW_ORIGIN};
use tauri::http::{Request, Response};
use tauri::webview::PageLoadEvent;
use tauri::{App, AppHandle, Manager, Runtime, WebviewWindowBuilder, WindowEvent};

use crate::debug;

pub const MAIN: &str = "main";

/// What a path segment keeps as it is.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

/// Answers every file the app serves with `Access-Control-Allow-Origin: *`,
/// in place of Tauri's own value (the window's origin). Replacing matters:
/// a second header makes the engine refuse the file.
pub fn allow_any_origin(_request: Request<Vec<u8>>, response: &mut Response<Cow<'static, [u8]>>) {
    response
        .headers_mut()
        .insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
}

/// Builds the main window from `tauri.conf.json`, where it is not created
/// on its own. `page_gone` runs when its page starts loading again or the
/// window closes.
pub fn build_main(app: &App, page_gone: impl Fn() + Send + Sync + 'static) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN)
        .cloned()
        .unwrap_or_default();
    let page_gone = std::sync::Arc::new(page_gone);
    let reloading = page_gone.clone();
    let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_web_resource_request(allow_any_origin)
        .on_page_load(move |_, payload| {
            if payload.event() == PageLoadEvent::Started {
                reloading();
            }
        });
    if debug::enabled() {
        builder = builder.initialization_script(debug::SCRIPT);
    }
    let window = builder.build()?;
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            page_gone();
        }
    });
    Ok(())
}

/// Brings the main window back from the Dock, the taskbar or hiding.
/// Android has one window, always in front while the app is.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    #[cfg(mobile)]
    let _ = app;
}

/// The audience window's label for a deck: `present-` and the deck id,
/// with characters a label cannot hold replaced.
pub fn present_label(deck_id: &str) -> String {
    let id: String = deck_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    format!("present-{id}")
}

/// The page the audience window opens, under the app's hash history.
pub fn present_route(project_id: &str, deck_id: &str) -> String {
    let part = |text: &str| utf8_percent_encode(text, SEGMENT).to_string();
    format!(
        "index.html#/p/{}/d/{}/present",
        part(project_id),
        part(deck_id)
    )
}

/// Opens the audience window for a deck, or brings it forward.
#[cfg(desktop)]
pub fn open_present(app: &AppHandle, project_id: &str, deck_id: &str) -> tauri::Result<()> {
    let label = present_label(deck_id);
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::App(present_route(project_id, deck_id).into()),
    )
    .title("Deyslide")
    .inner_size(1280.0, 720.0)
    .min_inner_size(360.0, 203.0)
    .on_web_resource_request(allow_any_origin)
    .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_preview_files_allow_any_origin() {
        let mut response = Response::builder()
            .header(ACCESS_CONTROL_ALLOW_ORIGIN, "tauri://localhost")
            .body(Cow::Borrowed(&b"export {}"[..]))
            .unwrap();
        allow_any_origin(Request::new(Vec::new()), &mut response);
        let values: Vec<_> = response
            .headers()
            .get_all(ACCESS_CONTROL_ALLOW_ORIGIN)
            .iter()
            .collect();
        assert_eq!(values, [HeaderValue::from_static("*")]);
    }

    #[test]
    fn audience_windows_are_named_after_their_deck() {
        assert_eq!(
            present_label("local-d-0123abcd"),
            "present-local-d-0123abcd"
        );
        assert_eq!(present_label("a/b c"), "present-a_b_c");
    }

    #[test]
    fn audience_windows_open_the_present_page() {
        assert_eq!(
            present_route("local-p-1", "local-d-2"),
            "index.html#/p/local-p-1/d/local-d-2/present"
        );
        assert_eq!(
            present_route("p 1", "d/2"),
            "index.html#/p/p%201/d/d%2F2/present"
        );
    }
}
