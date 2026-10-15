//! `DEYSLIDE_DEBUG_PREVIEW=1`: checks that slide previews work in the app,
//! where the preview's sandboxed frame must load module scripts from the
//! app's own files. The main window then shows a preview frame drawing one
//! slide with a code block (Shiki loads its grammar with a dynamic import),
//! and every message a preview frame sends, and every error on the page, is
//! printed to stderr.

pub const ENV: &str = "DEYSLIDE_DEBUG_PREVIEW";

pub fn enabled() -> bool {
    std::env::var_os(ENV).is_some_and(|value| !value.is_empty() && value != "0")
}

/// Prints a preview message, for the `debug_preview_log` command.
pub fn log(message: &str) {
    if enabled() {
        eprintln!("deyslide preview: {message}");
    }
}

pub const SCRIPT: &str = r#"
(() => {
  const log = message => window.__TAURI_INTERNALS__.invoke('debug_preview_log', { message })
  window.addEventListener('error', event => log('page error: ' + event.message))
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    log('page error: ' + (reason && reason.stack ? reason.stack : String(reason)))
  })
  window.addEventListener('message', (event) => {
    const type = event.data && event.data.type
    if (typeof type === 'string' && type.startsWith('deyslide:') && type !== 'deyslide:render')
      log(JSON.stringify(event.data))
  })
  window.addEventListener('DOMContentLoaded', () => {
    log('page ' + location.href)
    const frame = document.createElement('iframe')
    frame.src = '/preview.html'
    frame.sandbox = 'allow-scripts'
    frame.title = 'Debug slide preview'
    frame.style.cssText = 'position:fixed;right:16px;bottom:16px;width:480px;height:270px;border:2px solid #38bdf8;background:#000;z-index:2147483647'
    const slide = {
      content: '# Preview works\n\nDrawn in the app\n\n```ts\nconst answer: number = 42\n```\n',
      frontmatter: {},
      first: true,
    }
    window.addEventListener('message', (event) => {
      if (event.source === frame.contentWindow && event.data && event.data.type === 'deyslide:ready')
        frame.contentWindow.postMessage({ type: 'deyslide:render', slide, headmatter: {}, clicks: 0 }, '*')
    })
    document.body.appendChild(frame)
  })
})()
"#;
