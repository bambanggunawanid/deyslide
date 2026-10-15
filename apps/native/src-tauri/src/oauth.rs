//! The OAuth pieces of signing in to a Deyslide server, without any I/O:
//! the client registration, PKCE, the authorize link, reading the redirect
//! back and reading token answers. The server is Better Auth's OAuth
//! provider under `/api/auth`, and the app asks for the `<server>/api`
//! resource, which grants full access to the account.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

pub const SCOPE: &str = "openid profile email offline_access";

/// What a computer registers. The server accepts any port on a loopback
/// redirect, so one registration serves every sign in.
pub const DESKTOP_REDIRECT: &str = "http://127.0.0.1/callback";

/// What Android registers: the app identifier as a private URI scheme,
/// which the deep link plugin hands back to the app.
pub const ANDROID_REDIRECT: &str = "id.bambanggunawan.deyslide:/oauth/callback";

/// An access token with less time left than this is refreshed first.
pub const REFRESH_MARGIN_MS: u64 = 60_000;

/// When the server leaves out `expires_in`. Its access tokens last an hour.
const DEFAULT_EXPIRES_IN: u64 = 3600;

/// `<server>/api`, the resource the app's tokens are for.
pub fn api_resource(server: &str) -> String {
    format!("{server}/api")
}

/// `<server>/api/auth/oauth2/<name>`.
pub fn endpoint(server: &str, name: &str) -> String {
    format!("{server}/api/auth/oauth2/{name}")
}

/// The dynamic client registration body.
pub fn registration_body(server: &str, redirect_uri: &str) -> Value {
    json!({
        "client_name": "Deyslide app",
        "application_type": "native",
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "redirect_uris": [redirect_uri],
        "resources": [api_resource(server)],
    })
}

/// URL safe random text from `bytes` random bytes.
pub fn random_text(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).expect("the system has no random numbers");
    URL_SAFE_NO_PAD.encode(buffer)
}

/// A PKCE verifier and its S256 challenge.
#[derive(Clone, Debug)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl Pkce {
    /// A fresh verifier: 32 random bytes, 43 characters.
    pub fn new() -> Self {
        Self::from_verifier(random_text(32))
    }

    pub fn from_verifier(verifier: String) -> Self {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self {
            verifier,
            challenge,
        }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

/// The page the person signs in on, in their browser.
pub fn authorize_url(
    server: &str,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<String, String> {
    let mut url = Url::parse(&endpoint(server, "authorize"))
        .map_err(|error| format!("The server address {server} is not valid: {error}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", SCOPE)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("resource", &api_resource(server));
    Ok(url.into())
}

/// What the redirect back to the app says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Callback {
    Code(String),
    /// The person said no, or the server refused. The text says why.
    Refused(String),
}

/// Reads the query of a redirect back to the app. `None` means the redirect
/// is not for this sign in (its state differs), so it must be ignored.
pub fn read_callback(query: &str, expected_state: &str) -> Option<Callback> {
    let mut state = None;
    let mut code = None;
    let mut error = None;
    let mut description = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "state" => state = Some(value.into_owned()),
            "code" => code = Some(value.into_owned()),
            "error" => error = Some(value.into_owned()),
            "error_description" => description = Some(value.into_owned()),
            _ => {}
        }
    }
    if expected_state.is_empty() || state.as_deref() != Some(expected_state) {
        return None;
    }
    if let Some(error) = error {
        return Some(Callback::Refused(match error.as_str() {
            "access_denied" => "Sign in was canceled.".to_string(),
            _ => format!(
                "The server refused to sign in: {}",
                description.unwrap_or(error)
            ),
        }));
    }
    match code {
        Some(code) if !code.is_empty() => Some(Callback::Code(code)),
        _ => Some(Callback::Refused(
            "The server sent no sign in code.".to_string(),
        )),
    }
}

/// The query of a full redirect URL, when it is for `redirect_uri`
/// (compared without its query and port).
pub fn callback_query(url: &str, redirect_uri: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    let expected = Url::parse(redirect_uri).ok()?;
    let same = url.scheme() == expected.scheme()
        && url.host_str() == expected.host_str()
        && url.path() == expected.path();
    same.then(|| url.query().unwrap_or_default().to_string())
}

/// The method and target of an HTTP request head, such as the browser's
/// `GET /callback?code=...` to the loopback listener.
pub fn request_target(head: &str) -> Option<(&str, &str, &str)> {
    let line = head.lines().next()?;
    let mut parts = line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    parts.next()?.starts_with("HTTP/").then_some(())?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    Some((method, path, query))
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
}

impl TokenResponse {
    /// When the access token stops working, in milliseconds since 1970.
    pub fn expires_at(&self, now_ms: u64) -> u64 {
        now_ms.saturating_add(
            self.expires_in
                .unwrap_or(DEFAULT_EXPIRES_IN)
                .saturating_mul(1000),
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TokenError {
    /// The refresh token or code is no longer valid: the person must sign in again.
    InvalidGrant,
    /// The server no longer knows the app's registration, after a reset
    /// say: the app must register again, and the person sign in again.
    InvalidClient,
    /// Anything else, such as no network. The message says what happened.
    Failed(String),
}

impl std::fmt::Display for TokenError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidGrant => formatter.write_str("The sign in has expired. Sign in again."),
            Self::InvalidClient => {
                formatter.write_str("The server no longer knows this app. Sign in again.")
            }
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

/// Reads the token endpoint's answer.
pub fn read_token_response(status: u16, body: &[u8]) -> Result<TokenResponse, TokenError> {
    if (200..300).contains(&status) {
        return serde_json::from_slice(body).map_err(|_| {
            TokenError::Failed("The server sent an unreadable token answer.".to_string())
        });
    }
    let error: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let code = error
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if code == "invalid_grant" {
        return Err(TokenError::InvalidGrant);
    }
    // 401 is how the token endpoint refuses the client itself.
    if code == "invalid_client" || status == 401 {
        return Err(TokenError::InvalidClient);
    }
    let text = error
        .get("error_description")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or(code);
    Err(TokenError::Failed(if text.is_empty() {
        format!("The server answered {status} when asked for a token.")
    } else {
        format!("The server refused the token request: {text}")
    }))
}

/// Reads the client id from a registration answer.
pub fn read_registration(status: u16, body: &[u8]) -> Result<String, String> {
    let answer: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        if let Some(id) = answer.get("client_id").and_then(Value::as_str) {
            return Ok(id.to_string());
        }
    }
    let text = answer
        .get("error_description")
        .or_else(|| answer.get("error"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("it answered {status}"));
    Err(format!("The server did not register the app: {text}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://deyslide.example";

    #[test]
    fn registration_asks_for_the_api_resource_as_a_native_client() {
        assert_eq!(
            registration_body(SERVER, DESKTOP_REDIRECT),
            json!({
                "client_name": "Deyslide app",
                "application_type": "native",
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "redirect_uris": ["http://127.0.0.1/callback"],
                "resources": ["https://deyslide.example/api"],
            })
        );
        assert_eq!(
            registration_body(SERVER, ANDROID_REDIRECT)["redirect_uris"],
            json!(["id.bambanggunawan.deyslide:/oauth/callback"])
        );
    }

    #[test]
    fn pkce_uses_s256() {
        // RFC 7636 appendix B.
        let pkce = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".into());
        assert_eq!(
            pkce.challenge,
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let fresh = Pkce::new();
        assert_eq!(fresh.verifier.len(), 43);
        assert_ne!(fresh.verifier, Pkce::new().verifier);
    }

    #[test]
    fn the_authorize_link_carries_pkce_resource_and_scope() {
        let link = authorize_url(
            SERVER,
            "client-1",
            "http://127.0.0.1:4567/callback",
            "st",
            "ch",
        )
        .unwrap();
        let url = Url::parse(&link).unwrap();
        assert_eq!(url.path(), "/api/auth/oauth2/authorize");
        let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        assert_eq!(
            query,
            [
                ("response_type", "code"),
                ("client_id", "client-1"),
                ("redirect_uri", "http://127.0.0.1:4567/callback"),
                ("scope", "openid profile email offline_access"),
                ("state", "st"),
                ("code_challenge", "ch"),
                ("code_challenge_method", "S256"),
                ("resource", "https://deyslide.example/api"),
            ]
            .map(|(key, value)| (key.to_string(), value.to_string()))
        );
        assert!(authorize_url("not a url", "c", "r", "s", "c").is_err());
    }

    #[test]
    fn a_callback_with_the_state_gives_the_code() {
        assert_eq!(
            read_callback("code=abc%2B1&state=s1", "s1"),
            Some(Callback::Code("abc+1".into()))
        );
    }

    #[test]
    fn a_callback_for_another_sign_in_is_ignored() {
        assert_eq!(read_callback("code=abc&state=other", "s1"), None);
        assert_eq!(read_callback("code=abc", "s1"), None);
        assert_eq!(read_callback("code=abc&state=", ""), None);
    }

    #[test]
    fn a_refusal_says_why() {
        assert_eq!(
            read_callback("error=access_denied&state=s1", "s1"),
            Some(Callback::Refused("Sign in was canceled.".into()))
        );
        assert_eq!(
            read_callback(
                "error=invalid_target&error_description=not+linked&state=s1",
                "s1"
            ),
            Some(Callback::Refused(
                "The server refused to sign in: not linked".into()
            ))
        );
        assert_eq!(
            read_callback("state=s1", "s1"),
            Some(Callback::Refused("The server sent no sign in code.".into()))
        );
    }

    #[test]
    fn deep_links_match_the_android_redirect() {
        assert_eq!(
            callback_query(
                "id.bambanggunawan.deyslide:/oauth/callback?code=c&state=s",
                ANDROID_REDIRECT
            ),
            Some("code=c&state=s".into())
        );
        assert_eq!(
            callback_query("id.bambanggunawan.deyslide:/other?code=c", ANDROID_REDIRECT),
            None
        );
        assert_eq!(
            callback_query(
                "https://evil.example/oauth/callback?code=c",
                ANDROID_REDIRECT
            ),
            None
        );
        assert_eq!(callback_query("not a url", ANDROID_REDIRECT), None);
    }

    #[test]
    fn request_heads_give_the_target() {
        assert_eq!(
            request_target("GET /callback?code=a&state=b HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"),
            Some(("GET", "/callback", "code=a&state=b"))
        );
        assert_eq!(
            request_target("GET /favicon.ico HTTP/1.1\r\n"),
            Some(("GET", "/favicon.ico", ""))
        );
        assert_eq!(request_target("garbage"), None);
    }

    #[test]
    fn token_answers_are_read() {
        let answer = read_token_response(
            200,
            br#"{"access_token":"a","refresh_token":"r","expires_in":3600,"token_type":"Bearer"}"#,
        )
        .unwrap();
        assert_eq!(answer.access_token, "a");
        assert_eq!(answer.refresh_token.as_deref(), Some("r"));
        assert_eq!(answer.expires_at(1_000), 3_601_000);
        assert_eq!(
            read_token_response(
                400,
                br#"{"error":"invalid_grant","error_description":"invalid refresh token"}"#
            ),
            Err(TokenError::InvalidGrant)
        );
        assert_eq!(
            read_token_response(
                400,
                br#"{"error":"invalid_request","error_description":"missing code"}"#
            ),
            Err(TokenError::Failed(
                "The server refused the token request: missing code".into()
            ))
        );
        assert_eq!(
            read_token_response(
                401,
                br#"{"error":"invalid_client","error_description":"client not found"}"#
            ),
            Err(TokenError::InvalidClient)
        );
        assert_eq!(
            read_token_response(400, br#"{"error":"invalid_client"}"#),
            Err(TokenError::InvalidClient)
        );
        assert_eq!(
            read_token_response(401, b""),
            Err(TokenError::InvalidClient)
        );
        assert_eq!(
            read_token_response(502, b"<html>Bad gateway</html>"),
            Err(TokenError::Failed(
                "The server answered 502 when asked for a token.".into()
            ))
        );
    }

    #[test]
    fn registration_answers_are_read() {
        assert_eq!(
            read_registration(201, br#"{"client_id":"abc"}"#),
            Ok("abc".into())
        );
        assert_eq!(
            read_registration(400, br#"{"error":"invalid_client_metadata","error_description":"resources not allowed"}"#),
            Err("The server did not register the app: resources not allowed".into())
        );
    }
}
