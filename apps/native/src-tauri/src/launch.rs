//! Starts the app from `deyslide mcp`, so render_slides can draw slides.
//! The app must outlive the MCP server and must not hold Claude Code's
//! pipes open, so it starts detached with no standard input or output. It
//! shows its window as usual: a hidden window gets no animation frames.
//!
//! The app gets the data folder `deyslide mcp` uses when that is not the
//! usual one, so it writes `render-bridge.json` where the server looks.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};

use deyslide_core::paths::{APP_IDENTIFIER, DATA_DIR_ENV};

/// The AppImage file this binary runs from, if any. The AppImage runtime
/// sets `APPIMAGE` (the file) and `APPDIR` (its mount folder) for the
/// program inside, and every program started from there inherits both,
/// such as a terminal in an editor that ships as an AppImage. So
/// `APPIMAGE` counts only when this binary lies inside `APPDIR`.
pub fn appimage_file(
    exe: &Path,
    appimage: Option<&OsStr>,
    appdir: Option<&OsStr>,
) -> Option<PathBuf> {
    let appimage = appimage.filter(|path| !path.is_empty())?;
    let appdir = Path::new(appdir.filter(|path| !path.is_empty())?);
    let appdir = std::fs::canonicalize(appdir).unwrap_or_else(|_| appdir.to_path_buf());
    exe.starts_with(&appdir).then(|| PathBuf::from(appimage))
}

/// [`appimage_file`] for this process.
pub fn running_appimage(exe: &Path) -> Option<PathBuf> {
    appimage_file(
        exe,
        std::env::var_os("APPIMAGE").as_deref(),
        std::env::var_os("APPDIR").as_deref(),
    )
}

/// The program to start on Linux: the AppImage file when this binary runs
/// from one (its mount folder goes away when this process ends), else this
/// binary.
pub fn linux_program(exe: PathBuf) -> PathBuf {
    running_appimage(&exe).unwrap_or(exe)
}

/// `open`'s arguments on macOS. `--env` hands the app the data folder,
/// which Launch Services would not pass on from this process.
pub fn macos_open_args(data_dir: Option<&Path>) -> Vec<OsString> {
    let mut args = Vec::new();
    if let Some(data_dir) = data_dir {
        let mut variable = OsString::from(format!("{DATA_DIR_ENV}="));
        variable.push(data_dir);
        args.extend([OsString::from("--env"), variable]);
    }
    args.extend([OsString::from("-b"), OsString::from(APP_IDENTIFIER)]);
    args
}

/// Starts the Deyslide app, for [`deyslide_core::mcp::LaunchApp`].
/// `data_dir` is the data folder when it is not the usual one (set by
/// `--data-dir` or `DEYSLIDE_DATA_DIR`). An app that is already open keeps
/// its own folder.
pub fn launch_app(data_dir: Option<&Path>) -> io::Result<()> {
    imp::launch(data_dir)
}

#[cfg(target_os = "macos")]
mod imp {
    use std::io;
    use std::path::Path;
    use std::process::{Command, Stdio};

    /// Through Launch Services, like a click in the Dock, so the app runs
    /// as itself and not as a child of this process.
    pub fn launch(data_dir: Option<&Path>) -> io::Result<()> {
        let status = Command::new("open")
            .args(super::macos_open_args(data_dir))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "macOS could not open the Deyslide app ({status})"
            )))
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::io;
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::{Command, Stdio};

    use deyslide_core::paths::DATA_DIR_ENV;

    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    pub fn launch(data_dir: Option<&Path>) -> io::Result<()> {
        // Windows hands every inheritable handle to a new process, so the
        // app would keep Claude Code's pipes open after this server ends.
        for which in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            // SAFETY: both calls only take handle values; an invalid or null
            // handle makes them fail, which is fine here.
            unsafe {
                let handle = GetStdHandle(which);
                if !handle.is_null() {
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
                }
            }
        }
        let mut command = Command::new(std::env::current_exe()?);
        if let Some(data_dir) = data_dir {
            command.env(DATA_DIR_ENV, data_dir);
        }
        command
            .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        Ok(())
    }
}

#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "android", target_os = "ios"))
))]
mod imp {
    use std::io;
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::{Command, Stdio};

    use deyslide_core::paths::DATA_DIR_ENV;

    /// The app's command, before it is made a session of its own.
    pub fn command(program: &Path, data_dir: Option<&Path>) -> Command {
        let mut command = Command::new(program);
        if let Some(data_dir) = data_dir {
            command.env(DATA_DIR_ENV, data_dir);
        }
        command
    }

    pub fn launch(data_dir: Option<&Path>) -> io::Result<()> {
        let program = super::linux_program(std::env::current_exe()?);
        let mut command = command(&program, data_dir);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // SAFETY: setsid is async signal safe, as code between fork and exec must be.
        unsafe {
            command.pre_exec(|| {
                // A session of its own: no terminal hangs it up, and Claude
                // Code stopping this server's process group leaves it running.
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        // Collects the exit status if the app quits while this server runs.
        std::thread::spawn(move || child.wait());
        Ok(())
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
mod imp {
    use std::io;
    use std::path::Path;

    pub fn launch(_data_dir: Option<&Path>) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Claude Code starts Deyslide only on a computer",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(text: &str) -> Option<&OsStr> {
        Some(OsStr::new(text))
    }

    #[test]
    fn the_appimage_counts_when_this_binary_runs_from_it() {
        let exe = Path::new("/tmp/.mount_DeysAbc/usr/bin/deyslide");
        assert_eq!(
            appimage_file(
                exe,
                os("/home/a/Apps/Deyslide.AppImage"),
                os("/tmp/.mount_DeysAbc")
            ),
            Some(PathBuf::from("/home/a/Apps/Deyslide.AppImage"))
        );
        assert_eq!(appimage_file(exe, None, os("/tmp/.mount_DeysAbc")), None);
        assert_eq!(appimage_file(exe, os(""), os("/tmp/.mount_DeysAbc")), None);
    }

    #[test]
    fn an_appimage_this_binary_was_merely_started_from_is_ignored() {
        // `deyslide mcp` from the .deb, started by Claude Code in the
        // terminal of an editor that is itself an AppImage.
        let exe = Path::new("/usr/bin/deyslide");
        assert_eq!(
            appimage_file(
                exe,
                os("/home/a/Apps/Editor.AppImage"),
                os("/tmp/.mount_EditXyz")
            ),
            None
        );
        assert_eq!(
            appimage_file(exe, os("/home/a/Apps/Editor.AppImage"), None),
            None
        );
        // A folder name that only starts the same way is not inside it.
        assert_eq!(
            appimage_file(
                Path::new("/tmp/.mount_EditXyz2/usr/bin/deyslide"),
                os("/home/a/Apps/Editor.AppImage"),
                os("/tmp/.mount_EditXyz")
            ),
            None
        );
    }

    #[test]
    fn macos_hands_the_data_folder_to_the_app() {
        assert_eq!(
            macos_open_args(None),
            ["-b", "id.bambanggunawan.deyslide"].map(OsString::from)
        );
        assert_eq!(
            macos_open_args(Some(Path::new("/Users/a/Deyslide data"))),
            [
                "--env",
                "DEYSLIDE_DATA_DIR=/Users/a/Deyslide data",
                "-b",
                "id.bambanggunawan.deyslide"
            ]
            .map(OsString::from)
        );
    }

    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "android", target_os = "ios"))
    ))]
    #[test]
    fn linux_hands_the_data_folder_to_the_app() {
        let program = Path::new("/usr/bin/deyslide");
        let with = imp::command(program, Some(Path::new("/home/a/data")));
        assert_eq!(with.get_program(), program);
        assert_eq!(
            with.get_envs().collect::<Vec<_>>(),
            [(
                OsStr::new("DEYSLIDE_DATA_DIR"),
                Some(OsStr::new("/home/a/data"))
            )]
        );
        assert_eq!(imp::command(program, None).get_envs().count(), 0);
    }
}
