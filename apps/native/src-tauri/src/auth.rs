//! The account the app is signed in to: `auth.json` in the data folder,
//! readable by its owner only, behind one lock.
//!
//! The server rotates refresh tokens and treats a second use of an old one
//! as theft, revoking the whole family. So refreshing happens under the
//! lock, at most once at a time, and the new refresh token is on disk
//! before anyone else can ask for a token.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use deyslide_core::paths::write_private;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::oauth::{TokenError, TokenResponse, REFRESH_MARGIN_MS};

pub const AUTH_FILE: &str = "auth.json";

/// The app's registration with a server, kept across sign ins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRecord {
    pub server: String,
    pub client_id: String,
    pub redirect_uri: String,
    /// Whether the last sign in with it finished. Only then is it used
    /// again: a server that lost the registration shows an error in the
    /// browser, which never comes back to the app, so the next try
    /// registers afresh.
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub server: String,
    /// The registration the tokens were given to, which refreshes them.
    pub client_id: String,
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Milliseconds since 1970.
    pub expires_at: u64,
}

/// A sign in waiting for the browser to come back (Android), saved first
/// because the system may stop the app while the browser is open.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingSignIn {
    pub client_id: String,
    pub verifier: String,
    pub state: String,
    pub redirect_uri: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<ClientRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Tokens>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<PendingSignIn>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AuthError {
    SignedOut,
    Failed(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignedOut => formatter.write_str("Sign in to your Deyslide account first."),
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

/// Whether a token that stops working at `expires_at` must be refreshed now.
pub fn refresh_due(expires_at: u64, now_ms: u64) -> bool {
    expires_at.saturating_sub(now_ms) < REFRESH_MARGIN_MS
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| u64::try_from(time.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

/// The server's token endpoint, for refreshing.
pub trait TokenEndpoint: Send + Sync {
    fn refresh(
        &self,
        server: &str,
        client_id: &str,
        refresh_token: &str,
    ) -> impl Future<Output = Result<TokenResponse, TokenError>> + Send;
}

type SignedOutHook = Box<dyn Fn() + Send + Sync>;

/// Drops the registration with id `client_id`, if it is the one kept.
fn forget(file: &mut AuthFile, client_id: &str) {
    if file
        .client
        .as_ref()
        .is_some_and(|client| client.client_id == client_id)
    {
        file.client = None;
    }
}

pub struct TokenStore<E> {
    path: PathBuf,
    endpoint: E,
    file: Mutex<AuthFile>,
    /// Runs when the server ends the sign in, to tell the pages.
    signed_out: SignedOutHook,
}

impl<E: TokenEndpoint> TokenStore<E> {
    /// Reads `path`. A missing or broken file means signed out.
    pub fn load(path: PathBuf, endpoint: E, signed_out: impl Fn() + Send + Sync + 'static) -> Self {
        let file = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            endpoint,
            file: Mutex::new(file),
            signed_out: Box::new(signed_out),
        }
    }

    pub fn endpoint(&self) -> &E {
        &self.endpoint
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A working access token for `server`, refreshed first when it has
    /// less than a minute left.
    pub async fn access_token(&self, server: &str) -> Result<String, AuthError> {
        self.access_token_at(server, now_ms).await
    }

    pub async fn access_token_at(
        &self,
        server: &str,
        now: impl Fn() -> u64,
    ) -> Result<String, AuthError> {
        let mut file = self.file.lock().await;
        let tokens = file
            .tokens
            .clone()
            .filter(|tokens| tokens.server == server)
            .ok_or(AuthError::SignedOut)?;
        if !refresh_due(tokens.expires_at, now()) {
            return Ok(tokens.access_token);
        }
        let Some(refresh_token) = tokens.refresh_token.clone() else {
            return self.end(&mut file);
        };
        match self
            .endpoint
            .refresh(server, &tokens.client_id, &refresh_token)
            .await
        {
            Ok(answer) => {
                let next = Tokens {
                    server: server.to_string(),
                    client_id: tokens.client_id.clone(),
                    access_token: answer.access_token.clone(),
                    refresh_token: answer.refresh_token.clone().or(Some(refresh_token)),
                    expires_at: answer.expires_at(now()),
                };
                file.tokens = Some(next);
                self.save(&file)?;
                Ok(answer.access_token)
            }
            Err(TokenError::InvalidGrant) => self.end(&mut file),
            Err(TokenError::InvalidClient) => {
                forget(&mut file, &tokens.client_id);
                self.end(&mut file)
            }
            // Offline: the old token still works for a moment.
            Err(TokenError::Failed(_)) if tokens.expires_at > now() => Ok(tokens.access_token),
            Err(TokenError::Failed(message)) => Err(AuthError::Failed(message)),
        }
    }

    /// Clears the tokens after the server ended the sign in.
    fn end(&self, file: &mut AuthFile) -> Result<String, AuthError> {
        file.tokens = None;
        file.pending = None;
        self.save(file)?;
        (self.signed_out)();
        Err(AuthError::SignedOut)
    }

    fn save(&self, file: &AuthFile) -> Result<(), AuthError> {
        let mut json = serde_json::to_vec_pretty(file)
            .map_err(|error| AuthError::Failed(error.to_string()))?;
        json.push(b'\n');
        write_private(&self.path, &json).map_err(|error| {
            AuthError::Failed(format!(
                "The sign in could not be saved to {}: {error}",
                self.path.display()
            ))
        })
    }

    pub async fn signed_in(&self, server: &str) -> bool {
        let file = self.file.lock().await;
        file.tokens
            .as_ref()
            .is_some_and(|tokens| tokens.server == server)
    }

    /// The registration to sign in with on `server` for `redirect_uri`,
    /// when the last sign in with it finished. It counts as unconfirmed
    /// until this sign in finishes too.
    pub async fn client_for_sign_in(
        &self,
        server: &str,
        redirect_uri: &str,
    ) -> Result<Option<String>, AuthError> {
        let mut file = self.file.lock().await;
        let Some(client) = file.client.as_mut().filter(|client| {
            client.server == server && client.redirect_uri == redirect_uri && client.confirmed
        }) else {
            return Ok(None);
        };
        client.confirmed = false;
        let client_id = client.client_id.clone();
        self.save(&file)?;
        Ok(Some(client_id))
    }

    pub async fn remember_client(&self, client: ClientRecord) -> Result<(), AuthError> {
        let mut file = self.file.lock().await;
        file.client = Some(client);
        self.save(&file)
    }

    /// Forgets a registration the server no longer knows.
    pub async fn forget_client(&self, client_id: &str) -> Result<(), AuthError> {
        let mut file = self.file.lock().await;
        forget(&mut file, client_id);
        self.save(&file)
    }

    /// Saves the tokens a sign in with `client` received, and keeps
    /// `client` as confirmed for the next sign in.
    pub async fn signed_in_with(
        &self,
        client: &ClientRecord,
        answer: &TokenResponse,
    ) -> Result<(), AuthError> {
        let mut file = self.file.lock().await;
        file.tokens = Some(Tokens {
            server: client.server.clone(),
            client_id: client.client_id.clone(),
            access_token: answer.access_token.clone(),
            refresh_token: answer.refresh_token.clone(),
            expires_at: answer.expires_at(now_ms()),
        });
        file.client = Some(ClientRecord {
            confirmed: true,
            ..client.clone()
        });
        file.pending = None;
        self.save(&file)
    }

    /// Forgets the tokens and returns them, so the refresh token can be revoked.
    pub async fn sign_out(&self) -> Result<Option<Tokens>, AuthError> {
        let mut file = self.file.lock().await;
        let tokens = file.tokens.take();
        file.pending = None;
        self.save(&file)?;
        Ok(tokens)
    }

    /// Saves a sign in that the browser will finish later.
    pub async fn begin(&self, pending: PendingSignIn) -> Result<(), AuthError> {
        let mut file = self.file.lock().await;
        file.pending = Some(pending);
        self.save(&file)
    }

    /// The saved sign in whose state is `state`, removed from the file.
    pub async fn take_pending(&self, state: &str) -> Result<Option<PendingSignIn>, AuthError> {
        let mut file = self.file.lock().await;
        if file
            .pending
            .as_ref()
            .is_none_or(|pending| pending.state != state)
        {
            return Ok(None);
        }
        let pending = file.pending.take();
        self.save(&file)?;
        Ok(pending)
    }

    pub async fn pending(&self) -> Option<PendingSignIn> {
        self.file.lock().await.pending.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    const SERVER: &str = "https://deyslide.example";

    /// A token endpoint that rotates tokens, like the real one.
    struct FakeEndpoint {
        calls: AtomicUsize,
        answer: Result<(), TokenError>,
        seen: std::sync::Mutex<Vec<String>>,
    }

    impl FakeEndpoint {
        fn answering(answer: Result<(), TokenError>) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                answer,
                seen: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    impl TokenEndpoint for FakeEndpoint {
        async fn refresh(
            &self,
            _server: &str,
            client_id: &str,
            refresh_token: &str,
        ) -> Result<TokenResponse, TokenError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            assert_eq!(client_id, "client-1");
            self.seen.lock().unwrap().push(refresh_token.to_string());
            tokio::time::sleep(Duration::from_millis(50)).await;
            self.answer.clone().map(|()| TokenResponse {
                access_token: format!("access-{call}"),
                refresh_token: Some(format!("refresh-{call}")),
                expires_in: Some(3600),
            })
        }
    }

    fn client(client_id: &str, confirmed: bool) -> ClientRecord {
        ClientRecord {
            server: SERVER.into(),
            client_id: client_id.into(),
            redirect_uri: crate::oauth::DESKTOP_REDIRECT.into(),
            confirmed,
        }
    }

    fn file_with(expires_at: u64) -> AuthFile {
        AuthFile {
            client: Some(client("client-1", true)),
            tokens: Some(Tokens {
                server: SERVER.into(),
                client_id: "client-1".into(),
                access_token: "access-0".into(),
                refresh_token: Some("refresh-0".into()),
                expires_at,
            }),
            pending: None,
        }
    }

    fn store(
        dir: &tempfile::TempDir,
        file: &AuthFile,
        endpoint: FakeEndpoint,
    ) -> (Arc<TokenStore<FakeEndpoint>>, Arc<AtomicUsize>) {
        let path = dir.path().join(AUTH_FILE);
        std::fs::write(&path, serde_json::to_vec(file).unwrap()).unwrap();
        let ended = Arc::new(AtomicUsize::new(0));
        let counter = ended.clone();
        let store = TokenStore::load(path, endpoint, move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        (Arc::new(store), ended)
    }

    fn saved(dir: &tempfile::TempDir) -> AuthFile {
        serde_json::from_slice(&std::fs::read(dir.path().join(AUTH_FILE)).unwrap()).unwrap()
    }

    #[test]
    fn tokens_are_refreshed_in_their_last_minute() {
        assert!(!refresh_due(1_000_000, 1_000_000 - 61_000));
        assert!(refresh_due(1_000_000, 1_000_000 - 59_000));
        assert!(refresh_due(1_000_000, 2_000_000));
    }

    #[tokio::test]
    async fn a_fresh_token_is_returned_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _) = store(
            &dir,
            &file_with(10_000_000),
            FakeEndpoint::answering(Ok(())),
        );
        assert_eq!(
            store.access_token_at(SERVER, || 1_000).await,
            Ok("access-0".into())
        );
        assert_eq!(store.endpoint().calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn callers_at_the_same_time_share_one_refresh() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _) = store(&dir, &file_with(1_000), FakeEndpoint::answering(Ok(())));
        let calls: Vec<_> = (0..4)
            .map(|_| {
                let store = store.clone();
                tokio::spawn(async move { store.access_token_at(SERVER, || 10_000).await })
            })
            .collect();
        for call in calls {
            assert_eq!(call.await.unwrap(), Ok("access-1".into()));
        }
        assert_eq!(store.endpoint().calls.load(Ordering::SeqCst), 1);
        assert_eq!(*store.endpoint().seen.lock().unwrap(), ["refresh-0"]);
        // The rotated refresh token is on disk.
        let tokens = saved(&dir).tokens.unwrap();
        assert_eq!(tokens.refresh_token.as_deref(), Some("refresh-1"));
        assert_eq!(tokens.expires_at, 10_000 + 3_600_000);
    }

    #[tokio::test]
    async fn an_ended_sign_in_clears_the_file_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let (store, ended) = store(
            &dir,
            &file_with(1_000),
            FakeEndpoint::answering(Err(TokenError::InvalidGrant)),
        );
        assert_eq!(
            store.access_token_at(SERVER, || 10_000).await,
            Err(AuthError::SignedOut)
        );
        assert_eq!(ended.load(Ordering::SeqCst), 1);
        let file = saved(&dir);
        assert_eq!(file.tokens, None);
        assert!(
            file.client.is_some(),
            "the registration is kept for the next sign in"
        );
        assert_eq!(
            store.access_token_at(SERVER, || 10_000).await,
            Err(AuthError::SignedOut)
        );
        assert_eq!(store.endpoint().calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_registration_the_server_lost_is_forgotten_with_the_sign_in() {
        let dir = tempfile::tempdir().unwrap();
        let (store, ended) = store(
            &dir,
            &file_with(1_000),
            FakeEndpoint::answering(Err(TokenError::InvalidClient)),
        );
        assert_eq!(
            store.access_token_at(SERVER, || 10_000).await,
            Err(AuthError::SignedOut)
        );
        assert_eq!(ended.load(Ordering::SeqCst), 1);
        let file = saved(&dir);
        assert_eq!(file.tokens, None);
        assert_eq!(file.client, None, "the next sign in registers again");
        assert_eq!(
            store
                .client_for_sign_in(SERVER, crate::oauth::DESKTOP_REDIRECT)
                .await,
            Ok(None)
        );
    }

    #[tokio::test]
    async fn a_registration_is_used_again_only_after_a_finished_sign_in() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _) = store(
            &dir,
            &file_with(10_000_000),
            FakeEndpoint::answering(Ok(())),
        );
        let redirect = crate::oauth::DESKTOP_REDIRECT;
        assert_eq!(
            store.client_for_sign_in(SERVER, redirect).await,
            Ok(Some("client-1".into()))
        );
        assert_eq!(saved(&dir).client, Some(client("client-1", false)));
        // That sign in never came back (the browser showed an error, say).
        assert_eq!(store.client_for_sign_in(SERVER, redirect).await, Ok(None));
        let answer = TokenResponse {
            access_token: "a".into(),
            refresh_token: Some("r".into()),
            expires_in: Some(3600),
        };
        store
            .signed_in_with(&client("client-2", false), &answer)
            .await
            .unwrap();
        assert_eq!(saved(&dir).client, Some(client("client-2", true)));
        assert_eq!(
            store.client_for_sign_in(SERVER, redirect).await,
            Ok(Some("client-2".into()))
        );
        assert_eq!(
            store
                .client_for_sign_in("https://other.example", redirect)
                .await,
            Ok(None)
        );
    }

    #[tokio::test]
    async fn tokens_refresh_with_the_registration_they_came_with() {
        let dir = tempfile::tempdir().unwrap();
        let mut file = file_with(1_000);
        // A newer sign in registered again, then never finished.
        file.client = Some(client("client-9", false));
        let (store, _) = store(&dir, &file, FakeEndpoint::answering(Ok(())));
        assert_eq!(
            store.access_token_at(SERVER, || 10_000).await,
            Ok("access-1".into())
        );
        assert_eq!(saved(&dir).tokens.unwrap().client_id, "client-1");
    }

    #[tokio::test]
    async fn offline_the_old_token_serves_until_it_expires() {
        let dir = tempfile::tempdir().unwrap();
        let (store, ended) = store(
            &dir,
            &file_with(50_000),
            FakeEndpoint::answering(Err(TokenError::Failed("offline".into()))),
        );
        assert_eq!(
            store.access_token_at(SERVER, || 10_000).await,
            Ok("access-0".into())
        );
        assert_eq!(
            store.access_token_at(SERVER, || 60_000).await,
            Err(AuthError::Failed("offline".into()))
        );
        assert_eq!(ended.load(Ordering::SeqCst), 0);
        assert!(saved(&dir).tokens.is_some());
    }

    #[tokio::test]
    async fn tokens_for_another_server_do_not_count() {
        let dir = tempfile::tempdir().unwrap();
        let (store, _) = store(
            &dir,
            &file_with(10_000_000),
            FakeEndpoint::answering(Ok(())),
        );
        assert_eq!(
            store
                .access_token_at("https://other.example", || 1_000)
                .await,
            Err(AuthError::SignedOut)
        );
        assert!(!store.signed_in("https://other.example").await);
        assert!(store.signed_in(SERVER).await);
    }

    #[tokio::test]
    async fn a_missing_file_is_signed_out() {
        let dir = tempfile::tempdir().unwrap();
        let store = TokenStore::load(
            dir.path().join(AUTH_FILE),
            FakeEndpoint::answering(Ok(())),
            || {},
        );
        assert_eq!(store.access_token(SERVER).await, Err(AuthError::SignedOut));
    }

    #[tokio::test]
    async fn a_pending_sign_in_is_kept_until_its_state_comes_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(AUTH_FILE);
        let store = TokenStore::load(path.clone(), FakeEndpoint::answering(Ok(())), || {});
        let pending = PendingSignIn {
            client_id: "client-1".into(),
            verifier: "v".into(),
            state: "s1".into(),
            redirect_uri: crate::oauth::ANDROID_REDIRECT.into(),
        };
        store.begin(pending.clone()).await.unwrap();
        // The system may stop the app: a new process reads it back.
        let again = TokenStore::load(path, FakeEndpoint::answering(Ok(())), || {});
        assert_eq!(again.pending().await, Some(pending.clone()));
        assert_eq!(again.take_pending("other").await, Ok(None));
        assert_eq!(again.take_pending("s1").await, Ok(Some(pending)));
        assert_eq!(again.take_pending("s1").await, Ok(None));
        assert_eq!(saved(&dir).pending, None);
    }

    #[tokio::test]
    async fn signing_out_keeps_only_the_registration() {
        let dir = tempfile::tempdir().unwrap();
        let (store, ended) = store(
            &dir,
            &file_with(10_000_000),
            FakeEndpoint::answering(Ok(())),
        );
        let tokens = store.sign_out().await.unwrap().unwrap();
        assert_eq!(tokens.refresh_token.as_deref(), Some("refresh-0"));
        assert_eq!(tokens.client_id, "client-1");
        assert_eq!(saved(&dir).tokens, None);
        assert_eq!(saved(&dir).client, Some(client("client-1", true)));
        assert_eq!(
            ended.load(Ordering::SeqCst),
            0,
            "the app says so itself after a sign out"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_file_is_for_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = TokenStore::load(
            dir.path().join(AUTH_FILE),
            FakeEndpoint::answering(Ok(())),
            || {},
        );
        store
            .signed_in_with(
                &client("client-1", false),
                &TokenResponse {
                    access_token: "a".into(),
                    refresh_token: Some("r".into()),
                    expires_in: Some(10),
                },
            )
            .await
            .unwrap();
        let mode = std::fs::metadata(dir.path().join(AUTH_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
