//! The MCP server Claude Code starts on this computer (`deyslide mcp`, or
//! `deyslide-mcp` on its own). It offers the cloud server's tools over the
//! decks in the library folder, with the same names, schemas, limits and
//! answers where they apply.
//!
//! `tools.json`, `guide.md` and `instructions.md` come from the cloud
//! server through `pnpm guide:sync`. The tools are served as they are,
//! except for the descriptions [`local_description`] changes.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    JsonObject, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler, ServiceExt};
use serde::de::{DeserializeOwned, Error as _};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::bridge::{self, BridgeError, BridgeInfo, BridgeRequest, BridgeSlide, Clicks};
use crate::draft::{check_markdown, DeckDraft, EditError};
use crate::library::{clean_name, library_root, DeckInfo, Library, LibraryError, WriteOutcome};
use crate::paths::DataDir;
use crate::settings::read_settings;
use crate::slides::{js_length, split_slides, title_of};

/// The cloud server's tools, written by `pnpm guide:sync`.
pub const TOOLS_JSON: &str = include_str!("tools.json");
/// The cloud server's guide with the device appendix, for `get_guide`.
pub const GUIDE: &str = include_str!("guide.md");
/// The cloud server's instructions with the device appendix, sent on connect.
pub const INSTRUCTIONS: &str = include_str!("instructions.md");

pub const SERVER_NAME: &str = "deyslide-local";
pub const SERVER_TITLE: &str = "Deyslide (this computer)";

/// Slides one render_slides call draws, as in the cloud.
pub const MAX_RENDERED_SLIDES: usize = 6;
/// How long render_slides waits for the app to start and open its bridge.
pub const APP_START_TIMEOUT: Duration = Duration::from_secs(20);

/// Where this server says something other than the cloud server: there
/// are no accounts, sharing or editor links on this computer, only files.
///
/// create_deck and read_deck keep the hosted description with
/// [`FILE_PATH`] in place of [`EDITOR_LINK`], so a change to the hosted text
/// reaches them through `pnpm guide:sync`.
pub const FILE_PATH_TOOLS: &[&str] = &["create_deck", "read_deck"];
pub const EDITOR_LINK: &str = "editor link";
pub const FILE_PATH: &str = "file path";

/// list_decks says something else entirely. [`HOSTED_LIST_DECKS`] is the
/// hosted text it was written against: when `pnpm guide:sync` brings a new
/// one, the tests fail until [`LOCAL_LIST_DECKS`] is brought up to date.
pub const HOSTED_LIST_DECKS: &str = "Lists the person's projects and the decks in each, then projects and decks other people shared with them and the role they have. Includes deck ids, slide counts and editor links.";
pub const LOCAL_LIST_DECKS: &str = "Lists the projects in the Deyslide library folder on this computer and the decks in each. Includes deck ids, slide counts and file paths. Decks on this computer are not shared with anyone.";

/// write_deck says a read comes first: the hosted server merges a write
/// with what people changed since Claude read the deck, while this server
/// saves nothing over a file Claude has not read. [`HOSTED_WRITE_DECK`] is
/// the hosted text [`LOCAL_WRITE_DECK`] was written against.
pub const HOSTED_WRITE_DECK: &str = "Replaces all of a deck's Markdown. Use it for a first draft or a full rewrite; edit_slides is safer for a few slides. Call read_deck first: edits people make while you work are then kept. Writing a deck you have not read overwrites them. The first slide's frontmatter holds the deck settings.";
pub const LOCAL_WRITE_DECK: &str = "Replaces all of a deck's Markdown. Use it for a first draft or a full rewrite; edit_slides is safer for a few slides. Call read_deck first: write_deck saves nothing until you have read the deck, and nothing over a file that changed on disk since you last read or wrote it. The first slide's frontmatter holds the deck settings.";

/// A tool's description on this computer, from its hosted one.
pub fn local_description(tool: &str, hosted: &str) -> String {
    if tool == "list_decks" {
        LOCAL_LIST_DECKS.to_string()
    } else if tool == "write_deck" {
        LOCAL_WRITE_DECK.to_string()
    } else if FILE_PATH_TOOLS.contains(&tool) {
        hosted.replace(EDITOR_LINK, FILE_PATH)
    } else {
        hosted.to_string()
    }
}

const DECK_NOT_FOUND: &str =
    "There is no deck with that id in this library. Call list_decks to see the decks.";
const PROJECT_NOT_FOUND: &str =
    "There is no project with that id in this library. Call list_decks, or create_project first.";
const CHANGED_ON_DISK: &str =
    "The deck changed on disk since you last read or wrote it. Call read_deck again, then make your change.";
const NOT_READ: &str = "Call read_deck first, then make your change.";
const NO_APP: &str = "Open the Deyslide app to see slide images. The deck is saved.";

/// Starts the Deyslide app in the background, for render_slides. The app
/// binary provides one; without it render_slides only asks the person.
pub type LaunchApp = Arc<dyn Fn() -> io::Result<()> + Send + Sync>;

#[derive(Clone, Default)]
pub struct ServeOptions {
    /// The library folder, in place of the one in the settings.
    pub library: Option<PathBuf>,
    /// The data folder, in place of the app's.
    pub data_dir: Option<PathBuf>,
    pub launch_app: Option<LaunchApp>,
}

impl ServeOptions {
    /// Reads `[--library <dir>] [--data-dir <dir>]`.
    pub fn from_args<I: IntoIterator<Item = String>>(args: I) -> Result<Self, String> {
        let mut options = Self::default();
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            let (flag, inline) = match arg.split_once('=') {
                Some((flag, value)) => (flag.to_string(), Some(value.to_string())),
                None => (arg, None),
            };
            let target = match flag.as_str() {
                "--library" => &mut options.library,
                "--data-dir" => &mut options.data_dir,
                _ => return Err(format!("Unknown option {flag}. {USAGE}")),
            };
            let value = inline
                .or_else(|| args.next())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| format!("{flag} needs a folder. {USAGE}"))?;
            *target = Some(PathBuf::from(value));
        }
        Ok(options)
    }
}

pub const USAGE: &str = "Usage: deyslide mcp [--library <dir>] [--data-dir <dir>]";

/// Serves MCP over stdin and stdout until the client closes the pipe.
/// Nothing else may print to stdout meanwhile.
pub async fn serve(options: ServeOptions) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let server = LocalServer::new(options)?;
    let running = server.serve(rmcp::transport::stdio()).await?;
    running.waiting().await?;
    Ok(())
}

/// The cloud tools with this server's descriptions.
pub fn local_tools() -> Vec<Tool> {
    let mut tools: Vec<Tool> =
        serde_json::from_str(TOOLS_JSON).expect("tools.json holds MCP tool definitions");
    for tool in &mut tools {
        if let Some(hosted) = &tool.description {
            tool.description = Some(local_description(&tool.name, hosted).into());
        }
    }
    tools
}

#[derive(Clone)]
pub struct LocalServer {
    state: Arc<State>,
}

struct State {
    data_dir: DataDir,
    library: Option<PathBuf>,
    launch_app: Option<LaunchApp>,
    tools: Vec<Tool>,
    /// The content Claude last saw of each deck in this process: what
    /// read_deck returned, or what create_deck, write_deck or edit_slides
    /// saved since. Both writing tools save only while the file still holds
    /// it, so a change made in the app or another editor is never lost, and
    /// slide numbers mean what Claude saw. A deck missing here, because
    /// Claude has not read it since this server started, is not written.
    seen: Mutex<HashMap<String, String>>,
    /// [`APP_START_TIMEOUT`], shorter in tests.
    app_start_timeout: Duration,
}

impl LocalServer {
    pub fn new(options: ServeOptions) -> io::Result<Self> {
        let data_dir = match options.data_dir {
            Some(path) => DataDir::new(path),
            None => DataDir::locate()?,
        };
        Ok(Self {
            state: Arc::new(State {
                data_dir,
                library: options.library,
                launch_app: options.launch_app,
                tools: local_tools(),
                seen: Mutex::new(HashMap::new()),
                app_start_timeout: APP_START_TIMEOUT,
            }),
        })
    }

    /// Runs one tool call. Problems Claude can fix come back as error results.
    pub async fn call(&self, name: &str, arguments: JsonObject) -> CallToolResult {
        let state = self.state.clone();
        match name {
            "get_guide" => text(GUIDE),
            "render_slides" => match parse::<RenderArgs>(name, arguments) {
                Ok(args) => state.render_slides(args).await,
                Err(message) => problem(message),
            },
            "list_decks" | "create_project" | "create_deck" | "read_deck" | "write_deck"
            | "edit_slides" => {
                let name = name.to_string();
                tokio::task::spawn_blocking(move || state.call_blocking(&name, arguments))
                    .await
                    .unwrap_or_else(|error| problem(format!("The tool stopped: {error}")))
            }
            _ => problem(format!("Tool {name} not found")),
        }
    }
}

impl ServerHandler for LocalServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new(SERVER_NAME, env!("CARGO_PKG_VERSION"))
                    .with_title(SERVER_TITLE),
            )
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(self.state.tools.clone()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let arguments = request.arguments.unwrap_or_default();
        Ok(self.call(&request.name, arguments).await.into())
    }
}

fn text(value: impl Into<String>) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(value)])
}

fn text_with(value: impl Into<String>, structured: Value) -> CallToolResult {
    let mut result = text(value);
    result.structured_content = Some(structured);
    result
}

fn problem(message: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message)])
}

/// Reads a tool's arguments, refusing them like the cloud's schema check
/// would. The error is the message for Claude.
fn parse<T: DeserializeOwned + Validate>(tool: &str, arguments: JsonObject) -> Result<T, String> {
    let invalid = |reason: String| {
        format!("Input validation error: Invalid arguments for tool {tool}: {reason}")
    };
    let args: T = serde_json::from_value(Value::Object(arguments))
        .map_err(|error| invalid(error.to_string()))?;
    args.validate().map_err(invalid)?;
    Ok(args)
}

/// Bounds the cloud's schemas set that serde does not check.
trait Validate {
    fn validate(&self) -> Result<(), String> {
        Ok(())
    }
}

fn check_length(field: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    let length = js_length(value);
    if length < min || length > max {
        return Err(format!(
            "{field} must have between {min} and {max} characters"
        ));
    }
    Ok(())
}

const ID_MAX_LENGTH: usize = 100;
const SLIDE_TEXT_MAX_LENGTH: usize = 20_000;
const MAX_EDITS: usize = 50;

/// A whole JSON number at least `MIN` and at most `Number.MAX_SAFE_INTEGER`, like Zod's `int().min(MIN)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Int<const MIN: u64>(u64);

impl<'de, const MIN: u64> Deserialize<'de> for Int<MIN> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
        let number = serde_json::Number::deserialize(deserializer)?;
        let value = number
            .as_u64()
            .or_else(|| {
                number
                    .as_f64()
                    .filter(|value| {
                        value.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(value)
                    })
                    .map(|value| value as u64)
            })
            .filter(|value| *value >= MIN && *value as f64 <= MAX_SAFE_INTEGER)
            .ok_or_else(|| {
                D::Error::custom(format!(
                    "expected a whole number of at least {MIN}, got {number}"
                ))
            })?;
        Ok(Self(value))
    }
}

type SlideNumber = Int<1>;

#[derive(Deserialize)]
struct NoArgs {}
impl Validate for NoArgs {}

#[derive(Deserialize)]
struct CreateProjectArgs {
    name: String,
}
impl Validate for CreateProjectArgs {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateDeckArgs {
    project_id: String,
    name: String,
    markdown: Option<String>,
}
impl Validate for CreateDeckArgs {
    fn validate(&self) -> Result<(), String> {
        check_length("projectId", &self.project_id, 1, ID_MAX_LENGTH)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeckArgs {
    deck_id: String,
}
impl Validate for DeckArgs {
    fn validate(&self) -> Result<(), String> {
        check_length("deckId", &self.deck_id, 1, ID_MAX_LENGTH)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteDeckArgs {
    deck_id: String,
    markdown: String,
}
impl Validate for WriteDeckArgs {
    fn validate(&self) -> Result<(), String> {
        check_length("deckId", &self.deck_id, 1, ID_MAX_LENGTH)?;
        if self.markdown.is_empty() {
            return Err("markdown must not be empty".to_string());
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase")]
enum Edit {
    Replace { slide: SlideNumber, text: String },
    Insert { position: SlideNumber, text: String },
    Delete { slide: SlideNumber },
    Move { slide: SlideNumber, to: SlideNumber },
}

impl Edit {
    fn action(&self) -> &'static str {
        match self {
            Self::Replace { .. } => "replace",
            Self::Insert { .. } => "insert",
            Self::Delete { .. } => "delete",
            Self::Move { .. } => "move",
        }
    }

    fn apply(&self, draft: &mut DeckDraft) -> Result<(), EditError> {
        match self {
            Self::Replace { slide, text } => draft.replace(slide.0, text),
            Self::Insert { position, text } => draft.insert(position.0, text),
            Self::Delete { slide } => draft.remove(slide.0),
            Self::Move { slide, to } => draft.move_slide(slide.0, to.0),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditSlidesArgs {
    deck_id: String,
    edits: Vec<Edit>,
}
impl Validate for EditSlidesArgs {
    fn validate(&self) -> Result<(), String> {
        check_length("deckId", &self.deck_id, 1, ID_MAX_LENGTH)?;
        if self.edits.is_empty() || self.edits.len() > MAX_EDITS {
            return Err(format!("edits must have between 1 and {MAX_EDITS} items"));
        }
        for edit in &self.edits {
            if let Edit::Replace { text, .. } | Edit::Insert { text, .. } = edit {
                check_length("text", text, 0, SLIDE_TEXT_MAX_LENGTH)?;
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ClickName {
    First,
    Last,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Click {
    Name(ClickName),
    Step(Int<0>),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderArgs {
    deck_id: String,
    slides: Option<Vec<SlideNumber>>,
    click: Option<Click>,
}
impl Validate for RenderArgs {
    fn validate(&self) -> Result<(), String> {
        check_length("deckId", &self.deck_id, 1, ID_MAX_LENGTH)?;
        match &self.slides {
            Some(slides) if slides.is_empty() || slides.len() > MAX_RENDERED_SLIDES => Err(
                format!("slides must have between 1 and {MAX_RENDERED_SLIDES} items"),
            ),
            _ => Ok(()),
        }
    }
}

/// Numbered titles of each slide's content, like `outline` in the cloud's `mcp/tools.ts`.
fn outline(markdown: &str) -> String {
    split_slides(markdown)
        .iter()
        .enumerate()
        .map(|(index, slide)| format!("{}. {}", index + 1, title_of(&slide.content)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn plural(count: u64, word: &str) -> String {
    format!("{count} {word}{}", if count == 1 { "" } else { "s" })
}

fn path_text(path: &std::path::Path) -> String {
    path.display().to_string()
}

fn deck_json(deck: &DeckInfo) -> Value {
    json!({ "id": deck.id, "name": deck.name, "slideCount": deck.slide_count, "path": path_text(&deck.path) })
}

/// ISO 8601 in UTC with milliseconds, like JavaScript's `toISOString`.
fn iso_time(millis: u64) -> String {
    let seconds = millis / 1000;
    let days = i64::try_from(seconds / 86_400).unwrap_or(0);
    let rest = seconds % 86_400;
    // Days since 1970 to a civil date (Howard Hinnant's algorithm).
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        millis % 1000
    )
}

impl State {
    fn library(&self) -> Result<Library, String> {
        let root = match &self.library {
            Some(root) => root.clone(),
            None => {
                let settings = read_settings(&self.data_dir.settings_path())
                    .map_err(|error| error.to_string())?;
                library_root(&settings, &self.data_dir)
            }
        };
        Library::open(&root, self.data_dir.lock_path()).map_err(|error| error.to_string())
    }

    fn remember(&self, deck_id: &str, content: &str) {
        if let Ok(mut seen) = self.seen.lock() {
            seen.insert(deck_id.to_string(), content.to_string());
        }
    }

    fn seen(&self, deck_id: &str) -> Option<String> {
        self.seen.lock().ok()?.get(deck_id).cloned()
    }

    fn call_blocking(&self, name: &str, arguments: JsonObject) -> CallToolResult {
        let library = match self.library() {
            Ok(library) => library,
            Err(message) => return problem(message),
        };
        let result = match name {
            "list_decks" => parse::<NoArgs>(name, arguments).map(|_| self.list_decks(&library)),
            "create_project" => {
                parse(name, arguments).map(|args| self.create_project(&library, args))
            }
            "create_deck" => parse(name, arguments).map(|args| self.create_deck(&library, args)),
            "read_deck" => parse(name, arguments).map(|args| self.read_deck(&library, args)),
            "write_deck" => parse(name, arguments).map(|args| self.write_deck(&library, args)),
            "edit_slides" => parse(name, arguments).map(|args| self.edit_slides(&library, args)),
            _ => Ok(problem(format!("Tool {name} not found"))),
        };
        result.unwrap_or_else(problem)
    }

    fn list_decks(&self, library: &Library) -> CallToolResult {
        let projects = match library.list() {
            Ok(projects) => projects,
            Err(error) => return problem(error.to_string()),
        };
        let root = path_text(library.root());
        let structured = json!({
            "library": root,
            "projects": projects.iter().map(|project| json!({
                "id": project.id,
                "name": project.name,
                "path": path_text(&project.path),
                "decks": project.decks.iter().map(|deck| json!({
                    "id": deck.id,
                    "name": deck.name,
                    "slideCount": deck.slide_count,
                    "updatedAt": iso_time(deck.updated_at),
                    "path": path_text(&deck.path),
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        });
        if projects.is_empty() {
            return text_with(
                format!(
                    "The library at {root} has no projects yet. Create one with create_project."
                ),
                structured,
            );
        }
        let mut lines = vec![format!("Library: {root}")];
        for project in &projects {
            lines.push(format!("Project \"{}\" (id {})", project.name, project.id));
            if project.decks.is_empty() {
                lines.push("  (no decks)".to_string());
            }
            for deck in &project.decks {
                lines.push(format!(
                    "  - Deck \"{}\" (id {}), {} slides, {}",
                    deck.name,
                    deck.id,
                    deck.slide_count,
                    path_text(&deck.path)
                ));
            }
        }
        text_with(lines.join("\n"), structured)
    }

    fn create_project(&self, library: &Library, args: CreateProjectArgs) -> CallToolResult {
        match library.create_project(&args.name) {
            Ok(project) => text_with(
                format!(
                    "Created the project \"{}\" with id {}. Its folder is {}.",
                    project.name,
                    project.id,
                    path_text(&project.path)
                ),
                json!({ "project": { "id": project.id, "name": project.name, "path": path_text(&project.path) } }),
            ),
            Err(error) => problem(error.to_string()),
        }
    }

    fn create_deck(&self, library: &Library, args: CreateDeckArgs) -> CallToolResult {
        // The cloud checks the name before anything else, through its schema.
        if let Err(error) = clean_name(&args.name) {
            return problem(error.to_string());
        }
        let source = match args.markdown.as_deref() {
            Some(markdown) if !crate::slides::js_trim(markdown).is_empty() => markdown.to_string(),
            _ => {
                let name = crate::slides::js_trim(&args.name);
                let title = serde_json::to_string(name).unwrap_or_default();
                format!("---\ntitle: {title}\nlayout: cover\n---\n\n# {name}\n")
            }
        };
        if let Err(message) = check_markdown(&source) {
            return problem(message);
        }
        match library.create_deck(&args.project_id, &args.name, &source) {
            Ok(deck) => {
                self.remember(&deck.id, &source);
                text_with(
                    format!(
                        "Created the deck \"{}\" with id {} and {} slides. It is saved at {}. Open it in the Deyslide app.\n\n{}",
                        deck.name,
                        deck.id,
                        deck.slide_count,
                        path_text(&deck.path),
                        outline(&source)
                    ),
                    json!({ "deck": deck_json(&deck) }),
                )
            }
            Err(LibraryError::ProjectNotFound) => problem(PROJECT_NOT_FOUND),
            Err(error) => problem(error.to_string()),
        }
    }

    fn read_deck(&self, library: &Library, args: DeckArgs) -> CallToolResult {
        let (deck, markdown) = match library.open_deck(&args.deck_id) {
            Ok(found) => found,
            Err(LibraryError::DeckNotFound) => return problem(DECK_NOT_FOUND),
            Err(error) => return problem(error.to_string()),
        };
        self.remember(&deck.id, &markdown);
        let draft = DeckDraft::new(&markdown);
        text_with(
            format!(
                "Deck \"{}\" ({} slides) in project \"{}\". File: {}\n\n{}",
                deck.name,
                draft.count(),
                deck.project_name,
                path_text(&deck.path),
                draft.numbered()
            ),
            json!({
                "deck": { "id": deck.id, "name": deck.name, "slideCount": draft.count(), "path": path_text(&deck.path) },
                "markdown": markdown,
            }),
        )
    }

    fn write_deck(&self, library: &Library, args: WriteDeckArgs) -> CallToolResult {
        if let Err(error) = library.deck(&args.deck_id) {
            return match error {
                LibraryError::DeckNotFound => problem(DECK_NOT_FOUND),
                error => problem(error.to_string()),
            };
        }
        if let Err(message) = check_markdown(&args.markdown) {
            return problem(format!("Nothing was saved. {message}"));
        }
        let Some(expected) = self.seen(&args.deck_id) else {
            return problem(format!("Nothing was saved. {NOT_READ}"));
        };
        match library.write_deck(&args.deck_id, &args.markdown, Some(&expected)) {
            Ok(WriteOutcome::Written) => {
                self.remember(&args.deck_id, &args.markdown);
                text(format!(
                    "Saved. The deck now has these slides:\n{}\n\nCheck them with render_slides.",
                    outline(&args.markdown)
                ))
            }
            Ok(WriteOutcome::Conflict { .. }) => {
                problem(format!("Nothing was saved. {CHANGED_ON_DISK}"))
            }
            Err(LibraryError::DeckNotFound) => problem(DECK_NOT_FOUND),
            Err(error) => problem(format!("Nothing was saved. {error}")),
        }
    }

    fn edit_slides(&self, library: &Library, args: EditSlidesArgs) -> CallToolResult {
        let seen = self.seen(&args.deck_id);
        let outcome = library.update_deck(&args.deck_id, |_, current| {
            // Slide numbers refer to the deck Claude saw, so they only apply to that same content.
            match seen.as_deref() {
                None => return (None, Err(format!("Nothing was saved. {NOT_READ}"))),
                Some(seen) if seen != current => {
                    return (None, Err(format!("Nothing was saved. {CHANGED_ON_DISK}")))
                }
                Some(_) => {}
            }
            let mut draft = DeckDraft::new(current);
            for (index, edit) in args.edits.iter().enumerate() {
                if let Err(error) = edit.apply(&mut draft) {
                    let message = format!(
                        "Nothing was saved. Edit {} ({}) failed: {error}",
                        index + 1,
                        edit.action()
                    );
                    return (None, Err(message));
                }
            }
            let markdown = draft.markdown();
            if let Err(message) = check_markdown(&markdown) {
                return (None, Err(format!("Nothing was saved. {message}")));
            }
            (Some(markdown.clone()), Ok((draft.outline(), markdown)))
        });
        match outcome {
            Ok((deck, Ok((outline, markdown)))) => {
                self.remember(&deck.id, &markdown);
                let count = u64::try_from(args.edits.len()).unwrap_or(u64::MAX);
                text(format!(
                    "Saved {}. The deck now has these slides:\n{outline}\n\nCheck them with render_slides.",
                    plural(count, "edit")
                ))
            }
            Ok((_, Err(message))) => problem(message),
            Err(LibraryError::DeckNotFound) => problem(DECK_NOT_FOUND),
            Err(error) => problem(format!("Nothing was saved. {error}")),
        }
    }

    async fn render_slides(self: Arc<Self>, args: RenderArgs) -> CallToolResult {
        let state = self.clone();
        let deck_id = args.deck_id.clone();
        let read = tokio::task::spawn_blocking(move || {
            state
                .library()?
                .open_deck(&deck_id)
                .map_err(|error| match error {
                    LibraryError::DeckNotFound => DECK_NOT_FOUND.to_string(),
                    error => error.to_string(),
                })
        })
        .await;
        let (deck, markdown) = match read {
            Ok(Ok(found)) => found,
            Ok(Err(message)) => return problem(message),
            Err(error) => return problem(format!("The tool stopped: {error}")),
        };
        let count = split_slides(&markdown).len();
        let numbers: Vec<u64> = match &args.slides {
            Some(slides) => slides.iter().map(|slide| slide.0).collect(),
            None => (1..=count.min(MAX_RENDERED_SLIDES) as u64).collect(),
        };
        let missing: Vec<String> = numbers
            .iter()
            .filter(|number| **number > count as u64)
            .map(u64::to_string)
            .collect();
        if !missing.is_empty() {
            return problem(format!(
                "The deck has {count} slides, so there is no slide {}.",
                missing.join(", ")
            ));
        }
        let clicks = match args.click {
            None | Some(Click::Name(ClickName::Last)) => Clicks::Last,
            Some(Click::Name(ClickName::First)) => Clicks::Step(0),
            Some(Click::Step(step)) => Clicks::Step(step.0),
        };
        let request = BridgeRequest {
            markdown,
            slides: numbers
                .iter()
                .map(|number| BridgeSlide {
                    number: *number,
                    clicks,
                })
                .collect(),
        };
        let rendered = match self.render_through_app(&request).await {
            Ok(rendered) => rendered,
            Err(None) => return problem(NO_APP),
            Err(Some(error)) => {
                return problem(format!(
                    "Slide images are unavailable right now ({error}). Try again in a minute."
                ))
            }
        };
        let mut content = Vec::new();
        for (number, slide) in numbers.iter().zip(&rendered.slides) {
            let mut details = vec![
                plural(slide.clicks, "click"),
                if slide.overflow {
                    "content overflows the slide: shorten it or split it".to_string()
                } else {
                    "fits the slide".to_string()
                },
            ];
            if let Some(error) = &slide.error {
                // The sentence below ends with its own period.
                details.push(format!("render error: {}", error.trim_end_matches('.')));
            }
            content.push(ContentBlock::text(format!(
                "Slide {number}: {}.",
                details.join(", ")
            )));
            if let Some(png) = &slide.png {
                content.push(ContentBlock::image(png.clone(), "image/png"));
            }
        }
        let more = if args.slides.is_none() && count > numbers.len() {
            format!("\n\nThe deck has {count} slides. Ask for the others by number.")
        } else {
            String::new()
        };
        content.push(ContentBlock::text(format!(
            "File: {}{more}",
            path_text(&deck.path)
        )));
        let mut result = CallToolResult::success(content);
        result.structured_content = Some(json!({
            "slides": numbers.iter().zip(&rendered.slides).map(|(number, slide)| json!({
                "number": number,
                "clicks": slide.clicks,
                "overflow": slide.overflow,
                "error": slide.error,
            })).collect::<Vec<_>>(),
        }));
        result
    }

    /// Draws slides in the running app. `Err(None)` means no app answered,
    /// even after starting it when this process knows how.
    async fn render_through_app(
        &self,
        request: &BridgeRequest,
    ) -> Result<bridge::BridgeResponse, Option<BridgeError>> {
        let path = self.data_dir.bridge_path();
        // A file whose app has quit is never contacted: its port may belong to another program now.
        let stale = bridge::read_bridge(&path);
        if let Some(info) = stale.as_ref().filter(|info| bridge::app_is_running(info)) {
            match bridge::render(info, request).await {
                Err(BridgeError::Unreachable(_)) => {}
                result => return result.map_err(Some),
            }
        }
        let Some(launch_app) = &self.launch_app else {
            return Err(None);
        };
        if let Err(error) = launch_app() {
            eprintln!("deyslide mcp: the app did not start: {error}");
            return Err(None);
        }
        let deadline = Instant::now() + self.app_start_timeout;
        let mut tried: Option<BridgeInfo> = stale;
        while Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let Some(info) = bridge::read_bridge(&path) else {
                continue;
            };
            if tried.as_ref() == Some(&info) || !bridge::app_is_running(&info) {
                continue;
            }
            match bridge::render(&info, request).await {
                Err(BridgeError::Unreachable(_)) => tried = Some(info),
                result => return result.map_err(Some),
            }
        }
        Err(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_come_from_arguments() {
        let options = ServeOptions::from_args([
            "--library".into(),
            "/decks".into(),
            "--data-dir=/data".into(),
        ])
        .unwrap();
        assert_eq!(options.library, Some(PathBuf::from("/decks")));
        assert_eq!(options.data_dir, Some(PathBuf::from("/data")));
        assert!(ServeOptions::from_args(["--nope".to_string()]).is_err());
        assert!(ServeOptions::from_args(["--library".to_string()]).is_err());
    }

    #[test]
    fn tools_are_the_cloud_tools_with_local_descriptions() {
        let tools = local_tools();
        let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_ref()).collect();
        assert_eq!(
            names,
            [
                "get_guide",
                "list_decks",
                "create_project",
                "create_deck",
                "read_deck",
                "write_deck",
                "edit_slides",
                "render_slides"
            ]
        );
        let hosted: Vec<Tool> = serde_json::from_str(TOOLS_JSON).unwrap();
        for (tool, hosted) in tools.iter().zip(&hosted) {
            let local = tool.description.as_deref().unwrap();
            let hosted = hosted.description.as_deref().unwrap();
            match tool.name.as_ref() {
                "list_decks" => {
                    assert_eq!(hosted, HOSTED_LIST_DECKS, "list_decks changed in the cloud: update LOCAL_LIST_DECKS and HOSTED_LIST_DECKS");
                    assert_eq!(local, LOCAL_LIST_DECKS);
                }
                "write_deck" => {
                    assert_eq!(hosted, HOSTED_WRITE_DECK, "write_deck changed in the cloud: update LOCAL_WRITE_DECK and HOSTED_WRITE_DECK");
                    assert_eq!(local, LOCAL_WRITE_DECK);
                }
                name if FILE_PATH_TOOLS.contains(&name) => {
                    assert_eq!(
                        hosted.matches(EDITOR_LINK).count(),
                        1,
                        "{name} no longer names the editor link once"
                    );
                    assert_eq!(local, hosted.replace(EDITOR_LINK, FILE_PATH));
                }
                _ => assert_eq!(local, hosted),
            }
        }
    }

    #[test]
    fn times_print_like_javascript() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_760_000_000_123), "2025-10-09T08:53:20.123Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn whole_numbers_follow_the_schema() {
        let read = |json: &str| serde_json::from_str::<SlideNumber>(json).map(|number| number.0);
        assert_eq!(read("3").unwrap(), 3);
        assert_eq!(read("3.0").unwrap(), 3);
        assert!(read("0").is_err());
        assert!(read("2.5").is_err());
        assert!(read("-1").is_err());
        assert!(read("9007199254740992").is_err());
    }

    fn server(dir: &std::path::Path) -> LocalServer {
        LocalServer::new(ServeOptions {
            library: Some(dir.join("library")),
            data_dir: Some(dir.join("data")),
            launch_app: None,
        })
        .unwrap()
    }

    fn args(value: Value) -> JsonObject {
        value.as_object().unwrap().clone()
    }

    fn first_text(result: &CallToolResult) -> String {
        match &result.content[0] {
            ContentBlock::Text(text) => text.text.clone(),
            other => panic!("expected text, got {other:?}"),
        }
    }

    /// Answers one HTTP request on `listener` with `body`, like the app's bridge.
    fn answer_once(listener: std::net::TcpListener, body: &'static str) {
        use std::io::{Read, Write};
        let (mut socket, _) = listener.accept().unwrap();
        let mut received = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = socket.read(&mut buffer).unwrap();
            received.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&received).to_ascii_lowercase();
            if let Some(head) = text.find("\r\n\r\n") {
                let length: usize = text
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0);
                if received.len() >= head + 4 + length {
                    break;
                }
            }
        }
        let reply = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(reply.as_bytes()).unwrap();
    }

    async fn deck_in(server: &LocalServer) -> String {
        let project = server
            .call("create_project", args(json!({ "name": "Talks" })))
            .await;
        let project_id = project.structured_content.unwrap()["project"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let deck = server
            .call(
                "create_deck",
                args(json!({ "projectId": project_id, "name": "Sorting", "markdown": "# One\n" })),
            )
            .await;
        deck.structured_content.unwrap()["deck"]["id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn server_with_app(
        dir: &std::path::Path,
        launch_app: LaunchApp,
        wait: Duration,
    ) -> LocalServer {
        let mut server = LocalServer::new(ServeOptions {
            library: Some(dir.join("library")),
            data_dir: Some(dir.join("data")),
            launch_app: Some(launch_app),
        })
        .unwrap();
        Arc::get_mut(&mut server.state).unwrap().app_start_timeout = wait;
        server
    }

    #[tokio::test]
    async fn rendering_starts_the_app_and_waits_for_its_bridge() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = tempfile::tempdir().unwrap();
        let bridge_file = dir.path().join("data/render-bridge.json");
        let launches = Arc::new(AtomicUsize::new(0));
        let counted = launches.clone();
        let launch: LaunchApp = Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            let bridge_file = bridge_file.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                let port = listener.local_addr().unwrap().port();
                let info = BridgeInfo {
                    port,
                    token: "t".into(),
                    pid: std::process::id(),
                };
                bridge::write_bridge(&bridge_file, &info).unwrap();
                answer_once(
                    listener,
                    r#"{"slides":[{"png":"iVBO","clicks":0,"overflow":false}]}"#,
                );
            });
            Ok(())
        });
        let server = server_with_app(dir.path(), launch, Duration::from_secs(10));
        let deck_id = deck_in(&server).await;
        let render = server
            .call("render_slides", args(json!({ "deckId": deck_id })))
            .await;
        assert_eq!(render.is_error, Some(false), "{}", first_text(&render));
        assert_eq!(first_text(&render), "Slide 1: 0 clicks, fits the slide.");
        assert_eq!(launches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn an_app_that_never_opens_its_bridge_gets_the_plain_answer() {
        let dir = tempfile::tempdir().unwrap();
        let launch: LaunchApp = Arc::new(|| Ok(()));
        let server = server_with_app(dir.path(), launch, Duration::from_millis(600));
        let deck_id = deck_in(&server).await;
        let render = server
            .call("render_slides", args(json!({ "deckId": deck_id })))
            .await;
        assert_eq!(first_text(&render), NO_APP);
    }

    #[tokio::test]
    async fn a_deck_round_trip_through_the_tools() {
        let dir = tempfile::tempdir().unwrap();
        let server = server(dir.path());
        let project = server
            .call("create_project", args(json!({ "name": "Talks" })))
            .await;
        let project_id = project.structured_content.unwrap()["project"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let deck = server
            .call(
                "create_deck",
                args(json!({ "projectId": project_id, "name": "Sorting" })),
            )
            .await;
        assert_eq!(deck.is_error, Some(false), "{}", first_text(&deck));
        let deck_id = deck.structured_content.unwrap()["deck"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let read = server
            .call("read_deck", args(json!({ "deckId": deck_id })))
            .await;
        assert!(first_text(&read).contains("<slide number=\"1\">\n---\ntitle: \"Sorting\"\nlayout: cover\n---\n\n# Sorting\n</slide>"));
        let edit = server
            .call("edit_slides", args(json!({ "deckId": deck_id, "edits": [{ "action": "insert", "position": 2, "text": "# Two" }] })))
            .await;
        assert_eq!(first_text(&edit), "Saved 1 edit. The deck now has these slides:\n1. Sorting\n2. Two\n\nCheck them with render_slides.");
        let write = server
            .call(
                "write_deck",
                args(json!({ "deckId": deck_id, "markdown": "# Only\n" })),
            )
            .await;
        assert_eq!(write.is_error, Some(false), "{}", first_text(&write));
        let render = server
            .call("render_slides", args(json!({ "deckId": deck_id })))
            .await;
        assert_eq!(first_text(&render), NO_APP);
        let unknown = server.call("nope", JsonObject::new()).await;
        assert_eq!(first_text(&unknown), "Tool nope not found");
    }
}
