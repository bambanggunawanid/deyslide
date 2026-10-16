# Deyslide apps

The Deyslide app for Windows, macOS, Linux and Android, built with [Tauri 2](https://tauri.app). It shows the web app from `apps/web`, built in mode `app` into `apps/web/dist-app`, and adds what a browser cannot do:

- Decks saved as Markdown files in a library folder on the device (`crates/deyslide-core`).
- Signing in to a Deyslide account through the system browser, with tokens kept in `auth.json` in the app data folder.
- `deyslide mcp`, the MCP server Claude Code starts on a computer to edit the decks in that folder, and the render bridge that lets it draw slides in the open app.

| Path | Purpose |
| --- | --- |
| `src-tauri/src/lib.rs`, `cli.rs` | Starts the app, or the MCP server for `deyslide mcp` |
| `src-tauri/src/launch.rs` | Opens the app, detached, when `deyslide mcp` needs slide images |
| `src-tauri/src/mcp_setup.rs` | The `claude mcp add` command the home page shows under Connect Claude Code |
| `src-tauri/src/window.rs` | Builds every window that shows a slide preview (see below) |
| `src-tauri/src/commands.rs` | The commands the pages call (`apps/web/src/platform/native.ts` wraps each one) |
| `src-tauri/src/render_bridge.rs` | The HTTP server `deyslide mcp` asks to draw slides |
| `src-tauri/src/auth.rs`, `oauth.rs`, `sign_in.rs`, `account.rs` | Signing in and keeping the tokens fresh |
| `src-tauri/src/watcher.rs` | Tells the pages when files in the library change |
| `src-tauri/src/debug.rs` | `DEYSLIDE_DEBUG_PREVIEW` (see "Checking slide previews") |
| `src-tauri/capabilities/` | What the app's windows may call |
| `src-tauri/gen/android/` | The Android project, made by `tauri android init` |
| `app-icon.svg` | The source of every icon, turned into `src-tauri/icons/` by `pnpm tauri icon app-icon.svg` |
| `scripts/app-version.sh` | The version a release build gets from its tag |

The pages themselves live in `apps/web`: `src/platform/` tells the website from the app (`native.ts` wraps every command and event), `src/projects/local-store.ts` keeps device decks in their files, and `src/platform/render-bridge.ts` draws slides for Claude Code. The library, the MCP tools and the render bridge's contract are in `crates/deyslide-core`, shared with `deyslide-mcp`, the same server without the app, which `pnpm test` builds for its scenarios.

## Building

Install Rust with [rustup](https://rustup.rs) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system (WebKitGTK 4.1 on Linux). Then, from this folder:

```sh
pnpm dev                     # the app with the web app's dev server (hot reload)
pnpm build                   # installers for this system in target/release/bundle
pnpm build --no-bundle       # only the binary, target/release/deyslide
```

Both build the Motion Canvas animations and the web app first, from the repository root (`pnpm --filter @deyslide/web build:app` into `apps/web/dist-app`; `dev:app` for `pnpm dev`). The web app's `.env.app` names the server the app uses by default.

Before a pull request that touches Rust, run from the repository root:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

For Android, install the Android SDK, the NDK and the Rust Android targets, set `ANDROID_HOME` and `NDK_HOME`, then:

```sh
pnpm android:build --apk --target aarch64
```

A release APK is signed only when all four of `storeFile`, `storePassword`, `keyAlias` and `keyPassword` are known: from `src-tauri/gen/android/keystore.properties` (git ignores it), or from the variables `ANDROID_KEYSTORE_FILE`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`, which win and are read as they are. A properties file reads a backslash as an escape and drops leading spaces, so a password with either belongs in the variable. Keep the keystore safe: every update must be signed with the same key, and uninstalling the app to change keys deletes the decks kept inside it.

Release builds run in `.github/workflows/release.yml` when a version tag is pushed. The repository's README, under "Releases", lists what each job makes and the signing secrets it reads.

## Data folder and settings

The app and `deyslide mcp` share one data folder: `id.bambanggunawan.deyslide` inside the system's data folder (`~/.local/share` on Linux, `~/Library/Application Support` on macOS, the roaming `AppData` folder on Windows), or the folder in `DEYSLIDE_DATA_DIR`. On Android it is the app's own data folder. It holds:

| File | Holds |
| --- | --- |
| `settings.json` | `libraryRoot`, the library folder the person picked (missing means `Documents/Deyslide`, or `decks` in the data folder on Android), and `serverUrl`, the Deyslide server to sign in to (missing means the default one; a change takes effect after a restart) |
| `auth.json` | The account's tokens (on Linux and macOS, readable by the owner only) |
| `render-bridge.json` | The port and token of the open app's render bridge, removed when the app quits |
| `library.lock` | The lock every process holds while it changes the library |

`deyslide mcp [--library <dir>] [--data-dir <dir>]` reads `settings.json` again on every call, so a library folder changed in the app applies at once.

## Drawing slides for Claude Code

`deyslide mcp` finds the open app through `render-bridge.json` in the app data folder, and starts the app when there is none. An app it starts gets the same data folder (`--data-dir` or `DEYSLIDE_DATA_DIR`); an app that is already open keeps its own. The app holds each request until the page in its main window listens (`onRenderRequest` in `apps/web/src/platform/native.ts` tells it through `render_ready`), and sends it again if that page reloads before answering.

## Why the content security policy is off

`app.security.csp` is `null`. Slides run inside the preview's sandboxed frame, which has an opaque origin and cannot reach the app's commands; Tauri injects its IPC only into the main frame. A policy on the app's pages would have to allow everything decks load (fonts, images, code from CDNs, inline styles) and would protect nothing more.

That sandboxed frame loads the app's own module scripts as cross origin requests with `Origin: null`. Tauri answers its files with `Access-Control-Allow-Origin` set to the window's origin, which the frame does not match, so every window that shows a preview is built in Rust with a handler that replaces the header with `*` (`window.rs`).

## Checking slide previews

`DEYSLIDE_DEBUG_PREVIEW=1` makes the main window show a preview frame that draws one slide, and prints every message preview frames send, and any error on the page, to stderr:

```sh
DEYSLIDE_DEBUG_PREVIEW=1 ../../target/release/deyslide
# deyslide preview: {"type":"deyslide:ready"}
# deyslide preview: {"type":"deyslide:rendered","clicks":0}
```
