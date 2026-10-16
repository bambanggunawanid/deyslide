//! Signing in through the system browser: the calls to the server's OAuth
//! endpoints and, on a computer, the loopback listener the browser comes
//! back to.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri_plugin_http::reqwest;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::auth::TokenEndpoint;
use crate::oauth::{
    endpoint, read_callback, read_registration, read_token_response, registration_body,
    request_target, Callback, TokenError, TokenResponse,
};

/// How long the browser has to come back on a computer.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// What `/api/me` says about the person.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub name: String,
    pub email: String,
}

/// The server's OAuth endpoints over HTTPS.
pub struct HttpOAuth {
    client: reqwest::Client,
}

impl Default for HttpOAuth {
    fn default() -> Self {
        Self::new()
    }
}

impl HttpOAuth {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self { client }
    }

    /// Registers the app with the server and returns its client id.
    pub async fn register(&self, server: &str, redirect_uri: &str) -> Result<String, String> {
        let response = self
            .client
            .post(endpoint(server, "register"))
            .header("content-type", "application/json")
            .body(registration_body(server, redirect_uri).to_string())
            .send()
            .await
            .map_err(|error| unreachable(server, &error))?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(|error| unreachable(server, &error))?;
        read_registration(status, &body)
    }

    /// Trades the code the browser brought back for tokens.
    pub async fn exchange(
        &self,
        server: &str,
        client_id: &str,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> Result<TokenResponse, TokenError> {
        self.token(
            server,
            &[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("client_id", client_id),
                ("code_verifier", verifier),
            ],
        )
        .await
    }

    /// Asks the server to forget a refresh token. Failing is fine: the
    /// app forgets it either way.
    pub async fn revoke(&self, server: &str, client_id: &str, token: &str) {
        let _ = self
            .client
            .post(endpoint(server, "revoke"))
            .timeout(Duration::from_secs(5))
            .form(&[
                ("token", token),
                ("token_type_hint", "refresh_token"),
                ("client_id", client_id),
            ])
            .send()
            .await;
    }

    /// `GET /api/me`, or `None` when the server does not know the token.
    pub async fn account(
        &self,
        server: &str,
        access_token: &str,
    ) -> Result<Option<Account>, String> {
        let response = self
            .client
            .get(format!("{server}/api/me"))
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| unreachable(server, &error))?;
        match response.status().as_u16() {
            200 => {
                let body = response
                    .bytes()
                    .await
                    .map_err(|error| unreachable(server, &error))?;
                serde_json::from_slice(&body)
                    .map(Some)
                    .map_err(|_| "The server sent an unreadable account.".to_string())
            }
            401 | 403 | 404 => Ok(None),
            status => Err(format!(
                "The server answered {status} when asked for the account."
            )),
        }
    }

    async fn token(
        &self,
        server: &str,
        form: &[(&str, &str)],
    ) -> Result<TokenResponse, TokenError> {
        let response = self
            .client
            .post(endpoint(server, "token"))
            .form(form)
            .send()
            .await
            .map_err(|error| TokenError::Failed(unreachable(server, &error)))?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(|error| TokenError::Failed(unreachable(server, &error)))?;
        read_token_response(status, &body)
    }
}

impl TokenEndpoint for HttpOAuth {
    async fn refresh(
        &self,
        server: &str,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<TokenResponse, TokenError> {
        self.token(
            server,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh_token),
                ("client_id", client_id),
            ],
        )
        .await
    }
}

fn unreachable(server: &str, error: &reqwest::Error) -> String {
    format!("Deyslide could not reach {server}: {error}")
}

/// Waits for the browser's `GET /callback?code=...&state=...` on the
/// loopback listener and returns the code. Other requests, such as the
/// browser asking for an icon, get a 404 and the wait goes on.
pub async fn wait_for_callback(listener: TcpListener, state: &str) -> Result<String, String> {
    loop {
        let (mut socket, _) = listener
            .accept()
            .await
            .map_err(|error| format!("The sign in listener stopped: {error}"))?;
        let head = read_head(&mut socket).await;
        let Some((_, path, query)) = head.as_deref().and_then(request_target) else {
            respond(&mut socket, 400, "Bad request").await;
            continue;
        };
        if path != "/callback" {
            respond(&mut socket, 404, "Not found").await;
            continue;
        }
        match read_callback(query, state) {
            None => {
                respond(
                    &mut socket,
                    400,
                    &page("This sign in link is not the latest one. Go back to Deyslide and sign in again."),
                )
                .await
            }
            Some(Callback::Code(code)) => {
                respond(
                    &mut socket,
                    200,
                    &page("You are signed in to Deyslide. You can close this tab."),
                )
                .await;
                return Ok(code);
            }
            Some(Callback::Refused(message)) => {
                respond(&mut socket, 200, &page(&format!("{message} You can close this tab."))).await;
                return Err(message);
            }
        }
    }
}

/// The request line and headers, up to 16 KiB, read within 5 seconds.
async fn read_head(socket: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    let mut buffer = [0u8; 2048];
    let read = async {
        while !head.windows(4).any(|window| window == b"\r\n\r\n") && head.len() < 16 * 1024 {
            let count = socket.read(&mut buffer).await.ok()?;
            if count == 0 {
                break;
            }
            head.extend_from_slice(&buffer[..count]);
        }
        Some(())
    };
    tokio::time::timeout(Duration::from_secs(5), read)
        .await
        .ok()??;
    String::from_utf8(head).ok()
}

async fn respond(socket: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let reply = format!(
        "HTTP/1.1 {status} {reason}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\ncache-control: no-store\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(reply.as_bytes()).await;
    let _ = socket.shutdown().await;
}

fn page(message: &str) -> String {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Deyslide</title></head>\
         <body style=\"font-family: system-ui, sans-serif; background: #0b1020; color: #e2e8f0; padding: 3rem\">\
         <p>{escaped}</p></body></html>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn get(port: u16, target: &str) -> String {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        socket
            .write_all(
                format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").as_bytes(),
            )
            .await
            .unwrap();
        let mut reply = String::new();
        socket.read_to_string(&mut reply).await.unwrap();
        reply
    }

    #[tokio::test]
    async fn the_browser_brings_back_the_code() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(async move { wait_for_callback(listener, "s1").await });
        assert!(get(port, "/favicon.ico").await.starts_with("HTTP/1.1 404"));
        let stale = get(port, "/callback?code=old&state=s0").await;
        assert!(stale.starts_with("HTTP/1.1 400"), "{stale}");
        let reply = get(port, "/callback?code=abc&state=s1").await;
        assert!(reply.starts_with("HTTP/1.1 200"));
        assert!(reply.contains("You are signed in to Deyslide."));
        assert_eq!(waiting.await.unwrap(), Ok("abc".into()));
    }

    #[tokio::test]
    async fn a_canceled_sign_in_ends_the_wait() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiting = tokio::spawn(async move { wait_for_callback(listener, "s1").await });
        let reply = get(port, "/callback?error=access_denied&state=s1").await;
        assert!(reply.contains("Sign in was canceled. You can close this tab."));
        assert_eq!(waiting.await.unwrap(), Err("Sign in was canceled.".into()));
    }

    #[test]
    fn pages_escape_their_text() {
        assert!(page("<b>&").contains("&lt;b&gt;&amp;"));
    }
}
