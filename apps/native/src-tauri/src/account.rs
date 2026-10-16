//! Signing in to a Deyslide account from the app. A computer opens the
//! browser and listens on `127.0.0.1` for it to come back. Android saves
//! the sign in first, opens the browser, and finishes when the browser
//! hands `id.bambanggunawan.deyslide:/oauth/callback` back to the app,
//! even if the system stopped the app meanwhile.

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::auth::{ClientRecord, PendingSignIn};
use crate::oauth::{
    authorize_url, callback_query, random_text, read_callback, Callback, Pkce, TokenError,
    TokenResponse, ANDROID_REDIRECT,
};
use crate::state::AppState;
use crate::ACCOUNT_CHANGED;

/// The app's registration on `server` for `redirect_uri`: the one kept
/// when its last sign in finished, else a new one.
pub async fn client_for_sign_in(
    state: &AppState,
    server: &str,
    redirect_uri: &str,
) -> Result<ClientRecord, String> {
    let record = |client_id: String| ClientRecord {
        server: server.to_string(),
        client_id,
        redirect_uri: redirect_uri.to_string(),
        confirmed: false,
    };
    let kept = state
        .auth
        .client_for_sign_in(server, redirect_uri)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(client_id) = kept {
        return Ok(record(client_id));
    }
    let client = record(state.auth.endpoint().register(server, redirect_uri).await?);
    state
        .auth
        .remember_client(client.clone())
        .await
        .map_err(|error| error.to_string())?;
    Ok(client)
}

/// Saves the tokens of a finished exchange. When the server no longer
/// knows the registration, forgets it so the next sign in registers again.
async fn finish_exchange(
    state: &AppState,
    client: &ClientRecord,
    exchanged: Result<TokenResponse, TokenError>,
) -> Result<(), String> {
    match exchanged {
        Ok(tokens) => state
            .auth
            .signed_in_with(client, &tokens)
            .await
            .map_err(|error| error.to_string()),
        Err(error) => {
            if error == TokenError::InvalidClient {
                let _ = state.auth.forget_client(&client.client_id).await;
            }
            Err(error.to_string())
        }
    }
}

fn open_browser<R: Runtime>(app: &AppHandle<R>, link: String) -> Result<(), String> {
    app.opener()
        .open_url(link, None::<&str>)
        .map_err(|error| format!("Deyslide could not open the browser to sign in: {error}"))
}

/// Signs in through the browser and the loopback listener. Returns once
/// the tokens are saved.
pub async fn sign_in_on_computer<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    server: &str,
) -> Result<(), String> {
    use crate::oauth::DESKTOP_REDIRECT;
    use crate::sign_in::{wait_for_callback, SIGN_IN_TIMEOUT};

    let client = client_for_sign_in(state, server, DESKTOP_REDIRECT).await?;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Deyslide could not listen for the browser: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let pkce = Pkce::new();
    let expected_state = random_text(16);
    open_browser(
        app,
        authorize_url(
            server,
            &client.client_id,
            &redirect_uri,
            &expected_state,
            &pkce.challenge,
        )?,
    )?;
    let code = tokio::time::timeout(
        SIGN_IN_TIMEOUT,
        wait_for_callback(listener, &expected_state),
    )
    .await
    .map_err(|_| "Signing in took too long. Try again.".to_string())??;
    let exchanged = state
        .auth
        .endpoint()
        .exchange(
            server,
            &client.client_id,
            &code,
            &redirect_uri,
            &pkce.verifier,
        )
        .await;
    finish_exchange(state, &client, exchanged).await?;
    let _ = app.emit(ACCOUNT_CHANGED, ());
    // Back from the browser.
    crate::window::show_main(app);
    Ok(())
}

/// Saves the sign in, then opens the browser. The browser's link back
/// finishes it in [`finish_from_link`].
pub async fn begin_sign_in_on_phone<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    server: &str,
) -> Result<(), String> {
    let client = client_for_sign_in(state, server, ANDROID_REDIRECT).await?;
    let pkce = Pkce::new();
    let pending = PendingSignIn {
        client_id: client.client_id.clone(),
        verifier: pkce.verifier.clone(),
        state: random_text(16),
        redirect_uri: ANDROID_REDIRECT.to_string(),
    };
    let link = authorize_url(
        server,
        &client.client_id,
        ANDROID_REDIRECT,
        &pending.state,
        &pkce.challenge,
    )?;
    state
        .auth
        .begin(pending)
        .await
        .map_err(|error| error.to_string())?;
    open_browser(app, link)
}

/// Finishes a saved sign in when `url` is the browser's link back with its
/// state. Other links are ignored.
pub async fn finish_from_link<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    server: &str,
    url: &str,
) -> Result<(), String> {
    let Some(pending) = state.auth.pending().await else {
        return Ok(());
    };
    let Some(query) = callback_query(url, &pending.redirect_uri) else {
        return Ok(());
    };
    let Some(callback) = read_callback(&query, &pending.state) else {
        return Ok(());
    };
    let Some(pending) = state
        .auth
        .take_pending(&pending.state)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    let result = match callback {
        Callback::Code(code) => {
            let exchanged = state
                .auth
                .endpoint()
                .exchange(
                    server,
                    &pending.client_id,
                    &code,
                    &pending.redirect_uri,
                    &pending.verifier,
                )
                .await;
            let client = ClientRecord {
                server: server.to_string(),
                client_id: pending.client_id,
                redirect_uri: pending.redirect_uri,
                confirmed: false,
            };
            finish_exchange(state, &client, exchanged).await
        }
        Callback::Refused(message) => Err(message),
    };
    // The pages ask again either way, and stop waiting for the browser.
    let _ = app.emit(ACCOUNT_CHANGED, ());
    result
}
