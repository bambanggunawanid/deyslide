//! The command that connects Claude Code to `deyslide mcp`, shown in the
//! app so a person can copy it. It must name a path that still works after
//! the app quits.

use std::path::Path;

use serde::Serialize;

/// The name Claude Code lists the server under.
pub const SERVER_NAME: &str = "deyslide-local";

/// `{ "command": ... }` or `{ "problem": ... }` for the app.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum McpSetup {
    Command { command: String },
    Problem { problem: String },
}

const MOVE_TO_APPLICATIONS: &str = "Move Deyslide to Applications, then open it again.";

/// The setup command for this binary.
///
/// - `exe`: this binary's path.
/// - `appimage`: the AppImage file this binary runs from, if any
///   ([`crate::launch::running_appimage`]); its mount folder disappears
///   when the app quits.
/// - `os`: [`std::env::consts::OS`].
pub fn mcp_setup(exe: &Path, appimage: Option<&Path>, os: &str) -> McpSetup {
    match os {
        "android" | "ios" => {
            return McpSetup::Problem {
                problem: "Claude Code connects to the Deyslide app on a computer.".into(),
            }
        }
        // An app opened from Downloads or a disk image runs from a random
        // folder that changes on every launch (App Translocation).
        "macos" if is_translocated(exe) => {
            return McpSetup::Problem {
                problem: MOVE_TO_APPLICATIONS.into(),
            }
        }
        _ => {}
    }
    let path = match appimage {
        Some(appimage) if os == "linux" => appimage,
        _ => exe,
    };
    McpSetup::Command {
        command: format!(
            "claude mcp add --scope user {SERVER_NAME} -- {} mcp",
            quote(&path.to_string_lossy(), os)
        ),
    }
}

fn is_translocated(exe: &Path) -> bool {
    let path = exe.to_string_lossy();
    path.contains("/AppTranslocation/") || path.starts_with("/Volumes/")
}

/// The path in double quotes, as a shell reads it back.
fn quote(path: &str, os: &str) -> String {
    if os == "windows" {
        // Windows paths cannot contain a double quote.
        return format!("\"{path}\"");
    }
    let mut quoted = String::with_capacity(path.len() + 2);
    quoted.push('"');
    for character in path.chars() {
        if matches!(character, '"' | '\\' | '$' | '`') {
            quoted.push('\\');
        }
        quoted.push(character);
    }
    quoted.push('"');
    quoted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(text: &str) -> McpSetup {
        McpSetup::Command {
            command: text.into(),
        }
    }

    #[test]
    fn linux_uses_the_binary_path() {
        assert_eq!(
            mcp_setup(Path::new("/usr/bin/deyslide"), None, "linux"),
            command(r#"claude mcp add --scope user deyslide-local -- "/usr/bin/deyslide" mcp"#)
        );
    }

    #[test]
    fn an_appimage_uses_the_appimage_file() {
        assert_eq!(
            mcp_setup(
                Path::new("/tmp/.mount_DeysliXyz/usr/bin/deyslide"),
                Some(Path::new("/home/a/Apps/Deyslide_0.1.0_amd64.AppImage")),
                "linux"
            ),
            command(
                r#"claude mcp add --scope user deyslide-local -- "/home/a/Apps/Deyslide_0.1.0_amd64.AppImage" mcp"#
            )
        );
    }

    #[test]
    fn an_appimage_the_app_was_merely_started_from_is_not_named() {
        // The .deb app, opened from the terminal of an editor that is an AppImage.
        let exe = Path::new("/usr/bin/deyslide");
        let appimage = crate::launch::appimage_file(
            exe,
            Some(std::ffi::OsStr::new("/home/a/Apps/Editor.AppImage")),
            Some(std::ffi::OsStr::new("/tmp/.mount_EditXyz")),
        );
        assert_eq!(
            mcp_setup(exe, appimage.as_deref(), "linux"),
            command(r#"claude mcp add --scope user deyslide-local -- "/usr/bin/deyslide" mcp"#)
        );
    }

    #[test]
    fn macos_uses_the_binary_inside_the_app() {
        assert_eq!(
            mcp_setup(
                Path::new("/Applications/Deyslide.app/Contents/MacOS/deyslide"),
                None,
                "macos"
            ),
            command(
                r#"claude mcp add --scope user deyslide-local -- "/Applications/Deyslide.app/Contents/MacOS/deyslide" mcp"#
            )
        );
    }

    #[test]
    fn macos_asks_to_move_a_translocated_app() {
        let problem = McpSetup::Problem {
            problem: "Move Deyslide to Applications, then open it again.".into(),
        };
        assert_eq!(
            mcp_setup(
                Path::new("/private/var/folders/x1/abc/T/AppTranslocation/1F2E/d/Deyslide.app/Contents/MacOS/deyslide"),
                None,
                "macos"
            ),
            problem
        );
        assert_eq!(
            mcp_setup(
                Path::new("/Volumes/Deyslide/Deyslide.app/Contents/MacOS/deyslide"),
                None,
                "macos"
            ),
            problem
        );
    }

    #[test]
    fn windows_quotes_the_path() {
        assert_eq!(
            mcp_setup(
                Path::new(r"C:\Users\Ana Lee\AppData\Local\Deyslide\deyslide.exe"),
                None,
                "windows"
            ),
            command(
                r#"claude mcp add --scope user deyslide-local -- "C:\Users\Ana Lee\AppData\Local\Deyslide\deyslide.exe" mcp"#
            )
        );
    }

    #[test]
    fn shell_characters_in_a_path_are_escaped() {
        assert_eq!(
            mcp_setup(Path::new("/home/a/$HOME \"x\"/deyslide"), None, "linux"),
            command(
                r#"claude mcp add --scope user deyslide-local -- "/home/a/\$HOME \"x\"/deyslide" mcp"#
            )
        );
    }

    #[test]
    fn android_has_no_command() {
        assert!(matches!(
            mcp_setup(
                Path::new("/data/app/x/lib/libdeyslide_app.so"),
                None,
                "android"
            ),
            McpSetup::Problem { .. }
        ));
    }

    #[test]
    fn the_result_is_command_or_problem_json() {
        assert_eq!(
            serde_json::to_value(command("x")).unwrap(),
            serde_json::json!({ "command": "x" })
        );
        assert_eq!(
            serde_json::to_value(McpSetup::Problem {
                problem: "y".into()
            })
            .unwrap(),
            serde_json::json!({ "problem": "y" })
        );
    }
}
