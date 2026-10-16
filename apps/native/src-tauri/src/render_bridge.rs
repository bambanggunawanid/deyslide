//! The app's side of the render bridge: an HTTP server on `127.0.0.1` that
//! `deyslide mcp` calls to draw slides (see `deyslide_core::bridge` for the
//! contract). Each request goes to the web page as a `render-request`
//! event; the page draws the slides in its preview frame and answers with
//! the `render_respond` command.
//!
//! Tauri drops an event that no page listens to, so requests wait until
//! the main window's page says it listens (`render_ready`). The bridge is
//! open to every program on the computer, so it gives each caller little
//! time and few connections before the token is checked.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use deyslide_core::bridge::{
    BridgeInfo, BridgeRequest, BridgeResponse, BridgeSlide, RenderedSlide, SLIDE_TIMEOUT,
};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::{Bytes, Incoming};
use hyper::header::{AUTHORIZATION, CONTENT_TYPE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch, Semaphore};
use tokio::time::{timeout_at, Instant};

/// The size the page draws each slide at.
pub const RENDER_WIDTH: u32 = 1280;
pub const RENDER_HEIGHT: u32 = 720;

/// What the page gets told when it does not answer in time.
pub const WINDOW_CLOSED: &str = "The Deyslide window must stay open to draw slides.";

/// The biggest request body: a deck is at most 100,000 characters.
const MAX_BODY: usize = 2 * 1024 * 1024;

/// Connections served at once. `deyslide mcp` opens one for each render.
const MAX_CONNECTIONS: usize = 8;

/// How long a caller has to send its whole request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// The `render-request` event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RenderRequestEvent {
    pub id: String,
    pub markdown: String,
    pub slides: Vec<BridgeSlide>,
    pub width: u32,
    pub height: u32,
}

/// The `render_respond` command's payload.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct RenderAnswer {
    pub id: String,
    pub slides: Vec<RenderedSlide>,
}

/// Something that draws slides.
pub trait Renderer: Send + Sync + 'static {
    fn render(&self, request: BridgeRequest) -> impl Future<Output = BridgeResponse> + Send;
}

/// Matches the page's answers to the requests waiting for them, and holds
/// requests until the page listens for them.
pub struct RenderHub {
    waiting: Mutex<HashMap<String, oneshot::Sender<Vec<RenderedSlide>>>>,
    /// Whether the main window's page listens for `render-request`.
    listening: watch::Sender<bool>,
}

impl Default for RenderHub {
    fn default() -> Self {
        Self {
            waiting: Mutex::default(),
            listening: watch::Sender::new(false),
        }
    }
}

impl RenderHub {
    /// The main window's page started or stopped listening for requests,
    /// or went away (a reload, a closed window).
    pub fn set_listening(&self, listening: bool) {
        self.listening.send_replace(listening);
    }

    /// Sends `request` to the page with `send` and waits for its answer,
    /// [`SLIDE_TIMEOUT`] per slide, or for `per_slide` in tests. The time
    /// counts from the request, also while the page is still loading.
    pub async fn render(
        &self,
        request: BridgeRequest,
        per_slide: Duration,
        send: impl Fn(RenderRequestEvent) -> Result<(), String>,
    ) -> BridgeResponse {
        let count = request.slides.len();
        let id = crate::oauth::random_text(12);
        let (sender, mut receiver) = oneshot::channel();
        self.waiting.lock().unwrap().insert(id.clone(), sender);
        let event = RenderRequestEvent {
            id: id.clone(),
            markdown: request.markdown,
            slides: request.slides,
            width: RENDER_WIDTH,
            height: RENDER_HEIGHT,
        };
        let budget = per_slide.saturating_mul(u32::try_from(count.max(1)).unwrap_or(u32::MAX));
        let deadline = Instant::now() + budget;
        let slides = match self.deliver(&event, deadline, &send, &mut receiver).await {
            Ok(slides) if slides.len() == count => slides,
            Ok(slides) => failed(
                count,
                &format!(
                    "The Deyslide window answered for {} of {count} slides.",
                    slides.len()
                ),
            ),
            Err(message) => failed(count, &message),
        };
        self.waiting.lock().unwrap().remove(&id);
        BridgeResponse { slides }
    }

    /// Sends `event` once the page listens, again whenever the page goes
    /// away before answering, and waits for the answer until `deadline`.
    async fn deliver(
        &self,
        event: &RenderRequestEvent,
        deadline: Instant,
        send: &impl Fn(RenderRequestEvent) -> Result<(), String>,
        receiver: &mut oneshot::Receiver<Vec<RenderedSlide>>,
    ) -> Result<Vec<RenderedSlide>, String> {
        let mut listening = self.listening.subscribe();
        loop {
            let ready = timeout_at(deadline, listening.wait_for(|listening| *listening))
                .await
                .is_ok_and(|ready| ready.is_ok());
            if !ready {
                return Err(WINDOW_CLOSED.to_string());
            }
            send(event.clone())?;
            tokio::select! {
                answer = timeout_at(deadline, &mut *receiver) => {
                    return match answer {
                        Ok(Ok(slides)) => Ok(slides),
                        Ok(Err(_)) | Err(_) => Err(WINDOW_CLOSED.to_string()),
                    };
                }
                // The page went away with the request: send it again once
                // a page listens.
                _ = listening.wait_for(|listening| !*listening) => {}
            }
        }
    }

    /// Hands the page's answer to the request waiting for it. Returns
    /// whether one was waiting.
    pub fn respond(&self, answer: RenderAnswer) -> bool {
        let sender = self.waiting.lock().unwrap().remove(&answer.id);
        sender.is_some_and(|sender| sender.send(answer.slides).is_ok())
    }
}

fn failed(count: usize, message: &str) -> Vec<RenderedSlide> {
    (0..count)
        .map(|_| RenderedSlide {
            png: None,
            clicks: 0,
            overflow: false,
            error: Some(message.to_string()),
        })
        .collect()
}

/// A random 32 byte token, as hex.
pub fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the system has no random numbers");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Serves `POST /render` on `127.0.0.1` at a free port until the process
/// ends. Returns what goes into `render-bridge.json`.
pub async fn serve<R: Renderer>(renderer: Arc<R>) -> std::io::Result<BridgeInfo> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let info = BridgeInfo {
        port: listener.local_addr()?.port(),
        token: new_token(),
        pid: std::process::id(),
    };
    let token: Arc<str> = info.token.clone().into();
    let connections = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    tokio::spawn(async move {
        loop {
            let Ok(permit) = connections.clone().acquire_owned().await else {
                return;
            };
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(_) => {
                    // Such as no file handles left: wait rather than spin.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            let renderer = renderer.clone();
            let token = token.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let service = service_fn(move |request| {
                    let renderer = renderer.clone();
                    let token = token.clone();
                    async move { Ok::<_, Infallible>(handle(request, &token, renderer.as_ref()).await) }
                });
                let _ = http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(REQUEST_TIMEOUT)
                    .keep_alive(false)
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    Ok(info)
}

async fn handle<R: Renderer>(
    request: Request<Incoming>,
    token: &str,
    renderer: &R,
) -> Response<Full<Bytes>> {
    if request.method() != Method::POST || request.uri().path() != "/render" {
        return plain(StatusCode::NOT_FOUND, "Not found");
    }
    let authorized = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|given| same_secret(given, token));
    if !authorized {
        return plain(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let body = tokio::time::timeout(
        REQUEST_TIMEOUT,
        Limited::new(request.into_body(), MAX_BODY).collect(),
    )
    .await;
    let body = match body {
        Ok(Ok(body)) => body,
        Ok(Err(_)) => {
            return plain(
                StatusCode::PAYLOAD_TOO_LARGE,
                "The deck is too big to draw.",
            )
        }
        Err(_) => {
            return plain(
                StatusCode::REQUEST_TIMEOUT,
                "The request took too long to arrive.",
            )
        }
    };
    let Ok(render) = serde_json::from_slice::<BridgeRequest>(&body.to_bytes()) else {
        return plain(StatusCode::BAD_REQUEST, "This is not a render request.");
    };
    let answer = renderer.render(render).await;
    let json = serde_json::to_vec(&answer).unwrap_or_default();
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "application/json")
        .body(Full::new(Bytes::from(json)))
        .unwrap_or_default()
}

fn plain(status: StatusCode, text: &'static str) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from_static(text.as_bytes())));
    *response.status_mut() = status;
    response
}

/// Compares secrets in time that does not depend on where they differ.
fn same_secret(given: &str, expected: &str) -> bool {
    given.len() == expected.len()
        && given
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0
}

/// The app's renderer: the page in the main window, through the hub.
pub struct PageRenderer<F> {
    pub hub: Arc<RenderHub>,
    /// Shows the window and sends the event to the page.
    pub send: F,
}

impl<F> Renderer for PageRenderer<F>
where
    F: Fn(RenderRequestEvent) -> Result<(), String> + Send + Sync + 'static,
{
    async fn render(&self, request: BridgeRequest) -> BridgeResponse {
        self.hub.render(request, SLIDE_TIMEOUT, &self.send).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deyslide_core::bridge::{render, BridgeError, Clicks};

    fn request(slides: u64) -> BridgeRequest {
        BridgeRequest {
            markdown: "# One\n\n---\n\n# Two\n".into(),
            slides: (1..=slides)
                .map(|number| BridgeSlide {
                    number,
                    clicks: Clicks::Last,
                })
                .collect(),
        }
    }

    fn drawn(clicks: u64) -> RenderedSlide {
        RenderedSlide {
            png: Some("iVBO".into()),
            clicks,
            overflow: false,
            error: None,
        }
    }

    /// Answers every request at once, like a page with an open window.
    struct AnsweringPage {
        hub: Arc<RenderHub>,
        seen: Mutex<Vec<RenderRequestEvent>>,
    }

    fn answering_page() -> Arc<AnsweringPage> {
        let hub = Arc::new(RenderHub::default());
        hub.set_listening(true);
        Arc::new(AnsweringPage {
            hub,
            seen: Mutex::default(),
        })
    }

    fn listening_hub() -> Arc<RenderHub> {
        let hub = Arc::new(RenderHub::default());
        hub.set_listening(true);
        hub
    }

    impl Renderer for Arc<AnsweringPage> {
        async fn render(&self, request: BridgeRequest) -> BridgeResponse {
            let page = self.clone();
            self.hub
                .render(request, SLIDE_TIMEOUT, move |event| {
                    page.seen.lock().unwrap().push(event.clone());
                    let hub = page.hub.clone();
                    tokio::spawn(async move {
                        let slides = event
                            .slides
                            .iter()
                            .map(|slide| drawn(slide.number))
                            .collect();
                        assert!(hub.respond(RenderAnswer {
                            id: event.id,
                            slides
                        }));
                    });
                    Ok(())
                })
                .await
        }
    }

    #[tokio::test]
    async fn deyslide_mcp_gets_the_slides_the_page_drew() {
        let page = answering_page();
        let info = serve(Arc::new(page.clone())).await.unwrap();
        assert_eq!(info.token.len(), 64);
        assert_eq!(info.pid, std::process::id());
        let answer = render(&info, &request(2)).await.unwrap();
        assert_eq!(answer.slides, [drawn(1), drawn(2)]);
        let seen = page.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].markdown, "# One\n\n---\n\n# Two\n");
        assert_eq!((seen[0].width, seen[0].height), (1280, 720));
        assert_eq!(
            serde_json::to_value(&seen[0]).unwrap()["slides"],
            serde_json::json!([{ "number": 1, "clicks": "last" }, { "number": 2, "clicks": "last" }])
        );
    }

    #[tokio::test]
    async fn a_wrong_token_is_refused() {
        let page = answering_page();
        let mut info = serve(Arc::new(page.clone())).await.unwrap();
        info.token = new_token();
        match render(&info, &request(1)).await {
            Err(BridgeError::Failed(message)) => assert!(message.contains("401"), "{message}"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(page.seen.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_page_that_never_answers_gets_an_error_per_slide() {
        let hub = listening_hub();
        let answer = hub.render(request(2), SLIDE_TIMEOUT, |_| Ok(())).await;
        assert_eq!(
            answer.slides,
            vec![
                RenderedSlide {
                    png: None,
                    clicks: 0,
                    overflow: false,
                    error: Some("The Deyslide window must stay open to draw slides.".into()),
                };
                2
            ]
        );
        assert!(hub.waiting.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn the_page_has_25_seconds_per_slide() {
        let hub = listening_hub();
        let id = Arc::new(Mutex::new(String::new()));
        let answering = {
            let hub = hub.clone();
            let id = id.clone();
            tokio::spawn(async move {
                // Slow, but inside the 50 seconds two slides get.
                tokio::time::sleep(Duration::from_secs(40)).await;
                let id = id.lock().unwrap().clone();
                hub.respond(RenderAnswer {
                    id,
                    slides: vec![drawn(0), drawn(0)],
                })
            })
        };
        let answer = hub
            .render(request(2), SLIDE_TIMEOUT, |event| {
                *id.lock().unwrap() = event.id;
                Ok(())
            })
            .await;
        assert!(answering.await.unwrap());
        assert_eq!(answer.slides, [drawn(0), drawn(0)]);
    }

    #[tokio::test]
    async fn a_short_answer_is_an_error() {
        let hub = listening_hub();
        let answer = hub
            .render(request(2), SLIDE_TIMEOUT, |event| {
                let hub = hub.clone();
                tokio::spawn(async move {
                    hub.respond(RenderAnswer {
                        id: event.id,
                        slides: vec![drawn(0)],
                    })
                });
                Ok(())
            })
            .await;
        assert_eq!(answer.slides.len(), 2);
        assert_eq!(
            answer.slides[0].error.as_deref(),
            Some("The Deyslide window answered for 1 of 2 slides.")
        );
    }

    #[tokio::test]
    async fn an_answer_nobody_waits_for_is_dropped() {
        let hub = RenderHub::default();
        assert!(!hub.respond(RenderAnswer {
            id: "old".into(),
            slides: vec![]
        }));
    }

    /// A page that answers each request it gets, after `delay`.
    fn page_answering_after(
        hub: &Arc<RenderHub>,
        sent: &Arc<Mutex<Vec<RenderRequestEvent>>>,
        delay: Duration,
    ) -> impl Fn(RenderRequestEvent) -> Result<(), String> {
        let hub = hub.clone();
        let sent = sent.clone();
        move |event| {
            sent.lock().unwrap().push(event.clone());
            let hub = hub.clone();
            tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                let slides = event
                    .slides
                    .iter()
                    .map(|slide| drawn(slide.number))
                    .collect();
                hub.respond(RenderAnswer {
                    id: event.id,
                    slides,
                })
            });
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_request_waits_for_the_page_to_listen() {
        // The app was just started for this request: its page is loading.
        let hub = Arc::new(RenderHub::default());
        let sent = Arc::new(Mutex::new(Vec::new()));
        let loading = {
            let hub = hub.clone();
            let sent = sent.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                assert!(
                    sent.lock().unwrap().is_empty(),
                    "sent before the page listened"
                );
                hub.set_listening(true);
            })
        };
        let answer = hub
            .render(
                request(1),
                SLIDE_TIMEOUT,
                page_answering_after(&hub, &sent, Duration::from_secs(1)),
            )
            .await;
        loading.await.unwrap();
        assert_eq!(answer.slides, [drawn(1)]);
        assert_eq!(sent.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn a_page_that_reloads_gets_the_request_again() {
        let hub = listening_hub();
        let sent = Arc::new(Mutex::new(Vec::new()));
        let reloading = {
            let hub = hub.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                hub.set_listening(false);
                tokio::time::sleep(Duration::from_secs(2)).await;
                hub.set_listening(true);
            })
        };
        // The first page goes away before it answers.
        let answer = hub
            .render(
                request(2),
                SLIDE_TIMEOUT,
                page_answering_after(&hub, &sent, Duration::from_secs(5)),
            )
            .await;
        reloading.await.unwrap();
        assert_eq!(answer.slides, [drawn(1), drawn(2)]);
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0], sent[1]);
    }

    #[tokio::test(start_paused = true)]
    async fn with_no_page_listening_nothing_is_sent() {
        let hub = Arc::new(RenderHub::default());
        let sent = Arc::new(Mutex::new(Vec::new()));
        let started = Instant::now();
        let answer = hub
            .render(
                request(1),
                SLIDE_TIMEOUT,
                page_answering_after(&hub, &sent, Duration::ZERO),
            )
            .await;
        assert_eq!(started.elapsed(), SLIDE_TIMEOUT);
        assert_eq!(answer.slides[0].error.as_deref(), Some(WINDOW_CLOSED));
        assert!(sent.lock().unwrap().is_empty());
        assert!(hub.waiting.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn a_caller_that_sends_nothing_is_cut_off() {
        let page = answering_page();
        let info = serve(Arc::new(page.clone())).await.unwrap();
        let mut idle = tokio::net::TcpStream::connect(("127.0.0.1", info.port))
            .await
            .unwrap();
        let started = Instant::now();
        let mut buffer = [0u8; 64];
        let read = tokio::io::AsyncReadExt::read(&mut idle, &mut buffer).await;
        assert!(matches!(read, Ok(0) | Err(_)), "{read:?}");
        assert!(started.elapsed() <= REQUEST_TIMEOUT + Duration::from_secs(1));
    }

    #[test]
    fn secrets_compare_whole() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abd", "abc"));
        assert!(!same_secret("ab", "abc"));
    }
}
