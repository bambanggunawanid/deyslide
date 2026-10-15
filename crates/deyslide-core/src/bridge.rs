//! The render bridge: how `deyslide mcp` asks the running app to draw
//! slides. The app serves `POST /render` on `127.0.0.1` and writes where
//! and how to reach it to `render-bridge.json` in the data folder:
//! `{ "port", "token", "pid" }`, readable by its owner only.
//!
//! A request is `{ "markdown", "slides": [{ "number", "clicks": "last" | n }] }`
//! with `Authorization: Bearer <token>`. The answer is
//! `{ "slides": [{ "png"?, "clicks", "overflow", "error"? }] }`, the same
//! shape as the cloud renderer's `RenderedSlide`, with PNGs in base64.

use std::fmt;
use std::io;
use std::path::Path;
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::header::{AUTHORIZATION, CONTENT_TYPE, HOST};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::paths::write_private;

/// How long the app has to draw one slide before the request gives up.
pub const SLIDE_TIMEOUT: Duration = Duration::from_secs(25);

/// Extra time on top of the per slide budget, so the app's own timeout
/// answer arrives before this side stops waiting.
const RESPONSE_GRACE: Duration = Duration::from_secs(5);

/// Where the running app listens for render requests.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

/// The bridge file's content, or `None` when the app is not running or
/// left a file this side cannot read.
pub fn read_bridge(path: &Path) -> Option<BridgeInfo> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Whether the process that wrote a bridge file still runs. A file whose
/// app has quit may name a port another program took since, which must
/// never get the deck or the token.
pub fn app_is_running(info: &BridgeInfo) -> bool {
    process_exists(info.pid)
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    // 0 and negative numbers would name process groups instead.
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    // SAFETY: signal 0 sends nothing; it only checks that the process exists.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    // A process of another user exists too, though this one may not signal it.
    io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return false;
    }
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // An elevated process exists even though this one may not open it.
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let answered = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        !answered || code == STILL_ACTIVE as u32
    }
}

#[cfg(not(any(unix, windows)))]
fn process_exists(_pid: u32) -> bool {
    true
}

/// Writes the bridge file so only its owner can read the token.
pub fn write_bridge(path: &Path, info: &BridgeInfo) -> io::Result<()> {
    let json = serde_json::to_vec(info).map_err(io::Error::other)?;
    write_private(path, &json)
}

/// Removes the bridge file when the app quits. A missing file is fine.
pub fn remove_bridge(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// Which click step to draw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Clicks {
    /// Every click done, written `"last"`.
    Last,
    Step(u64),
}

impl Serialize for Clicks {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Last => serializer.serialize_str("last"),
            Self::Step(step) => serializer.serialize_u64(*step),
        }
    }
}

impl<'de> Deserialize<'de> for Clicks {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match serde_json::Value::deserialize(deserializer)? {
            serde_json::Value::String(text) if text == "last" => Ok(Self::Last),
            serde_json::Value::Number(number) => number
                .as_u64()
                .map(Self::Step)
                .ok_or_else(|| D::Error::custom("clicks must be \"last\" or a whole number")),
            _ => Err(D::Error::custom(
                "clicks must be \"last\" or a whole number",
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeSlide {
    /// Slide number, starting at 1.
    pub number: u64,
    pub clicks: Clicks,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeRequest {
    /// The whole deck, as the file holds it.
    pub markdown: String,
    pub slides: Vec<BridgeSlide>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderedSlide {
    /// PNG, base64. Missing when the slide failed to draw.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub png: Option<String>,
    /// How many click steps the slide has.
    pub clicks: u64,
    /// True when content runs past the slide's edges.
    pub overflow: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeResponse {
    pub slides: Vec<RenderedSlide>,
}

#[derive(Debug)]
pub enum BridgeError {
    /// Nothing listens on the port: the app quit and left its file behind.
    Unreachable(io::Error),
    TimedOut,
    Failed(String),
}

impl fmt::Display for BridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable(error) => {
                write!(formatter, "the Deyslide app is not answering: {error}")
            }
            Self::TimedOut => formatter.write_str("the Deyslide app took too long"),
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for BridgeError {}

/// Asks the app to draw slides, waiting [`SLIDE_TIMEOUT`] per slide.
pub async fn render(
    info: &BridgeInfo,
    request: &BridgeRequest,
) -> Result<BridgeResponse, BridgeError> {
    let slides = u32::try_from(request.slides.len().max(1)).unwrap_or(u32::MAX);
    let budget = SLIDE_TIMEOUT.saturating_mul(slides) + RESPONSE_GRACE;
    match tokio::time::timeout(budget, send(info, request)).await {
        Ok(result) => result,
        Err(_) => Err(BridgeError::TimedOut),
    }
}

async fn send(info: &BridgeInfo, request: &BridgeRequest) -> Result<BridgeResponse, BridgeError> {
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", info.port))
        .await
        .map_err(BridgeError::Unreachable)?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|error| {
            BridgeError::Failed(format!("the Deyslide app did not answer: {error}"))
        })?;
    tokio::spawn(connection);
    let body =
        serde_json::to_vec(request).map_err(|error| BridgeError::Failed(error.to_string()))?;
    let call = Request::post("/render")
        .header(HOST, format!("127.0.0.1:{}", info.port))
        .header(AUTHORIZATION, format!("Bearer {}", info.token))
        .header(CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(body)))
        .map_err(|error| BridgeError::Failed(error.to_string()))?;
    let response = sender.send_request(call).await.map_err(|error| {
        BridgeError::Failed(format!("the Deyslide app did not answer: {error}"))
    })?;
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .map_err(|error| {
            BridgeError::Failed(format!("the Deyslide app's answer broke off: {error}"))
        })?
        .to_bytes();
    if status != StatusCode::OK {
        let text = String::from_utf8_lossy(&bytes);
        let text: String = text.chars().take(200).collect();
        return Err(BridgeError::Failed(format!(
            "the Deyslide app answered {status}: {text}"
        )));
    }
    let answer: BridgeResponse = serde_json::from_slice(&bytes).map_err(|_| {
        BridgeError::Failed("the Deyslide app sent an unreadable answer".to_string())
    })?;
    if answer.slides.len() != request.slides.len() {
        return Err(BridgeError::Failed(format!(
            "the Deyslide app drew {} slides instead of {}",
            answer.slides.len(),
            request.slides.len()
        )));
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_and_answers_use_the_shared_json_shape() {
        let request = BridgeRequest {
            markdown: "# A".into(),
            slides: vec![
                BridgeSlide {
                    number: 1,
                    clicks: Clicks::Last,
                },
                BridgeSlide {
                    number: 2,
                    clicks: Clicks::Step(0),
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({ "markdown": "# A", "slides": [{ "number": 1, "clicks": "last" }, { "number": 2, "clicks": 0 }] })
        );
        let answer: BridgeResponse = serde_json::from_str(
            r#"{ "slides": [{ "png": "iVBO", "clicks": 2, "overflow": false }, { "clicks": 0, "overflow": true, "error": "Boom" }] }"#,
        )
        .unwrap();
        assert_eq!(answer.slides[0].png.as_deref(), Some("iVBO"));
        assert_eq!(answer.slides[1].error.as_deref(), Some("Boom"));
    }

    #[test]
    fn the_bridge_file_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("render-bridge.json");
        assert_eq!(read_bridge(&path), None);
        let info = BridgeInfo {
            port: 4321,
            token: "secret".into(),
            pid: 7,
        };
        write_bridge(&path, &info).unwrap();
        assert_eq!(read_bridge(&path), Some(info));
        remove_bridge(&path).unwrap();
        remove_bridge(&path).unwrap();
        assert_eq!(read_bridge(&path), None);
    }

    #[tokio::test]
    async fn talks_http_to_the_app() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                received.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&received);
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let length: usize = text
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|value| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    if received.len() >= head_end + 4 + length {
                        break;
                    }
                }
            }
            let body = r#"{"slides":[{"png":"iVBO","clicks":3,"overflow":false}]}"#;
            let reply = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8(received).unwrap()
        });
        let info = BridgeInfo {
            port,
            token: "secret".into(),
            pid: 1,
        };
        let request = BridgeRequest {
            markdown: "# A".into(),
            slides: vec![BridgeSlide {
                number: 1,
                clicks: Clicks::Last,
            }],
        };
        let answer = render(&info, &request).await.unwrap();
        assert_eq!(answer.slides[0].clicks, 3);
        let received = server.await.unwrap();
        assert!(received.starts_with("POST /render HTTP/1.1\r\n"));
        assert!(received
            .to_ascii_lowercase()
            .contains("authorization: bearer secret"));
        assert!(
            received.ends_with(r##"{"markdown":"# A","slides":[{"number":1,"clicks":"last"}]}"##)
        );
    }

    #[test]
    fn a_bridge_file_from_a_process_that_ended_is_not_trusted() {
        let info = |pid| BridgeInfo {
            port: 1,
            token: "t".into(),
            pid,
        };
        assert!(app_is_running(&info(std::process::id())));
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("--list")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let ended = child.id();
        child.wait().unwrap();
        assert!(!app_is_running(&info(ended)));
        assert!(!app_is_running(&info(0)));
        assert!(!app_is_running(&info(u32::MAX)));
    }

    #[tokio::test]
    async fn a_closed_port_is_unreachable() {
        // A socket bound without listening keeps the port closed, and keeps
        // other programs and this connection's own source port off it.
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let port = socket.local_addr().unwrap().port();
        let info = BridgeInfo {
            port,
            token: "x".into(),
            pid: 1,
        };
        let request = BridgeRequest {
            markdown: String::new(),
            slides: vec![],
        };
        assert!(matches!(
            render(&info, &request).await,
            Err(BridgeError::Unreachable(_))
        ));
        drop(socket);
    }
}
