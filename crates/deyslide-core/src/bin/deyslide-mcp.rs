//! `deyslide-mcp`: the on-device MCP server without the app around it, for
//! development and tests. The app runs the same server as `deyslide mcp`.
//!
//! - `deyslide-mcp [--library <dir>] [--data-dir <dir>]` serves MCP on stdin and stdout.
//! - `deyslide-mcp split` reads Markdown on stdin and prints its slides as JSON.
//! - `deyslide-mcp join` reads a JSON list of slide texts on stdin and prints the deck.
//!
//! Only MCP messages and command results go to stdout; logs go to stderr.

use std::io::{self, Read, Write};
use std::process::ExitCode;

use deyslide_core::mcp::{self, ServeOptions};
use deyslide_core::slides::{frontmatter_errors, join_slides, slide_texts, split_slides};
use serde_json::json;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("split") => split(),
        Some("join") => join(),
        Some("--help" | "-h") => {
            eprintln!(
                "{}\n       deyslide-mcp split < deck.md\n       deyslide-mcp join < slides.json",
                mcp::USAGE.replace("deyslide mcp", "deyslide-mcp")
            );
            Ok(())
        }
        _ => serve(args),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("deyslide-mcp: {message}");
            ExitCode::FAILURE
        }
    }
}

fn serve(args: Vec<String>) -> Result<(), String> {
    let options = ServeOptions::from_args(args)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime
        .block_on(mcp::serve(options))
        .map_err(|error| error.to_string())
}

fn stdin_text() -> Result<String, String> {
    let mut text = String::new();
    io::stdin()
        .read_to_string(&mut text)
        .map_err(|error| format!("cannot read stdin: {error}"))?;
    Ok(text)
}

fn print(text: &str) -> Result<(), String> {
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(text.as_bytes())
        .and_then(|()| stdout.flush())
        .map_err(|error| format!("cannot write stdout: {error}"))
}

/// The slides as Slidev's parser reads them, the deck joined back from
/// their texts and the frontmatter problems, for the parity scenarios.
fn split() -> Result<(), String> {
    let markdown = stdin_text()?;
    let output = json!({
        "slides": split_slides(&markdown),
        "joined": join_slides(&slide_texts(&markdown)),
        "frontmatterErrors": frontmatter_errors(&markdown),
    });
    print(&output.to_string())
}

fn join() -> Result<(), String> {
    let texts: Vec<String> = serde_json::from_str(&stdin_text()?)
        .map_err(|error| format!("stdin must be a JSON list of slide texts: {error}"))?;
    print(&join_slides(&texts))
}
