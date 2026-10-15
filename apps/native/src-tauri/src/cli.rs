//! What the `deyslide` binary was asked to do. `deyslide mcp` runs the MCP
//! server for Claude Code; anything else opens the app.

use std::ffi::OsString;

#[derive(Debug, PartialEq, Eq)]
pub enum Invocation {
    /// `deyslide mcp [--library <dir>] [--data-dir <dir>]`, with the
    /// arguments that follow `mcp`.
    Mcp(Vec<String>),
    /// `deyslide mcp --help`.
    McpHelp,
    App,
}

/// Reads the command line, program name included.
pub fn parse<I: IntoIterator<Item = OsString>>(args: I) -> Result<Invocation, String> {
    let mut args = args.into_iter().skip(1);
    if args.next().is_none_or(|first| first != "mcp") {
        return Ok(Invocation::App);
    }
    let rest = args
        .map(|arg| {
            arg.into_string()
                .map_err(|arg| format!("The argument {} is not valid text.", arg.to_string_lossy()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if rest.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(Invocation::McpHelp);
    }
    Ok(Invocation::Mcp(rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_strs(args: &[&str]) -> Result<Invocation, String> {
        parse(args.iter().map(OsString::from))
    }

    #[test]
    fn no_arguments_open_the_app() {
        assert_eq!(parse_strs(&["deyslide"]), Ok(Invocation::App));
        assert_eq!(parse_strs(&[]), Ok(Invocation::App));
    }

    #[test]
    fn other_arguments_open_the_app() {
        // A file manager or the single instance plugin can pass anything.
        assert_eq!(
            parse_strs(&["deyslide", "/home/a/deck.md"]),
            Ok(Invocation::App)
        );
        assert_eq!(parse_strs(&["deyslide", "MCP"]), Ok(Invocation::App));
    }

    #[test]
    fn mcp_runs_the_server_with_the_rest_of_the_arguments() {
        assert_eq!(
            parse_strs(&["deyslide", "mcp"]),
            Ok(Invocation::Mcp(vec![]))
        );
        assert_eq!(
            parse_strs(&["/opt/Deyslide.AppImage", "mcp", "--library", "/decks"]),
            Ok(Invocation::Mcp(vec!["--library".into(), "/decks".into()]))
        );
    }

    #[test]
    fn mcp_help_prints_the_usage() {
        assert_eq!(
            parse_strs(&["deyslide", "mcp", "--help"]),
            Ok(Invocation::McpHelp)
        );
        assert_eq!(
            parse_strs(&["deyslide", "mcp", "-h"]),
            Ok(Invocation::McpHelp)
        );
    }

    #[cfg(unix)]
    #[test]
    fn mcp_arguments_must_be_text() {
        use std::os::unix::ffi::OsStringExt;
        let args = vec![
            OsString::from("deyslide"),
            OsString::from("mcp"),
            OsString::from_vec(vec![0xff, 0xfe]),
        ];
        assert!(parse(args).unwrap_err().contains("is not valid text"));
    }
}
