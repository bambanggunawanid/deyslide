// No console window on Windows. Pipes still work, so Claude Code can run
// `deyslide mcp` from a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> std::process::ExitCode {
    deyslide_app::main()
}
