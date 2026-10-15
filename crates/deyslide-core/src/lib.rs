//! Deyslide's core for the apps, without Tauri or a web view, so it builds
//! for computers and Android alike: the library of decks on disk, an exact
//! port of Slidev's slide splitting, the render bridge to the running app
//! and the MCP server Claude Code starts on this computer.

pub mod bridge;
pub mod draft;
pub mod library;
pub mod mcp;
pub mod paths;
pub mod settings;
pub mod slides;
pub mod yaml;
