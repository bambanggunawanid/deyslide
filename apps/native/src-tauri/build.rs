/// The app's own commands. Each gets `allow-<command>` and `deny-<command>`
/// permissions, which `capabilities/default.json` grants to the app's windows.
const COMMANDS: &[&str] = &[
    "library_info",
    "library_set_root",
    "library_list",
    "library_create_project",
    "library_rename_project",
    "library_delete_project",
    "library_create_deck",
    "library_rename_deck",
    "library_delete_deck",
    "library_read_deck",
    "library_write_deck",
    "render_respond",
    "render_ready",
    "auth_sign_in",
    "auth_sign_out",
    "auth_access_token",
    "auth_account",
    "mcp_setup",
    "present_open",
    "save_file",
    "app_info",
    "debug_preview_log",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("the Tauri build script failed");
}
