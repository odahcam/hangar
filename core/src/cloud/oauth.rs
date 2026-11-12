// Sign-in with auth.odahcam.com: Authorization Code + PKCE as a public client, the code coming back through the
// `hangar://auth/callback` deep link the app hands over. The core builds the authorize URL and redeems the callback;
// opening the browser and receiving the link are the app's.
//
// Refresh tokens rotate, and the identity service treats a retired one used after its 30 s grace as theft: it revokes
// the refresh tokens of every machine of the account. So refreshing is single-flight, the new refresh token is stored
// before the access token it came with is used, and an unavailable service (network, 5xx, 429) is a reason to retry,
// never to sign out.
use super::secrets;
use super::{b64, unb64};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::Duration;
use zeroize::Zeroizing;

pub const CLIENT_ID: &str = "hangar";
pub const REDIRECT_URI: &str = "hangar://auth/callback";
/// RFC 8707: tokens are issued for the relay, which accepts no other audience.
pub const RESOURCE: &str = "https://hangar.odahcam.com";
const SCOPE: &str = "openid profile email offline_access";
const ISSUER: &str = "https://auth.odahcam.com";

#[derive(Debug, PartialEq)]
pub enum AuthError {
    /// No usable refresh token: the person has to sign in.
    SignedOut,
    /// The service couldn't be reached or is overloaded: try again later.
    Unavailable(String),
    /// The callback or the service's answer is wrong; nothing was changed.
    Invalid(String),
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthError::SignedOut => f.write_str("signed_out"),
            AuthError::Unavailable(e) => write!(f, "auth_unavailable: {e}"),
            AuthError::Invalid(e) => write!(f, "auth_invalid: {e}"),
        }
    }
}

/// An access token for the relay and what it says about itself.
#[derive(Clone)]
pub struct Access {
    pub token: String,
    pub sub: String,
    /// Seconds since the epoch.
    pub exp: i64,
}

/// What a sign-in that just finished hands back: the access token, and the id_token when the flow asked for one.
pub struct SignedIn {
    pub access: Access,
    pub id_token: Option<String>,
}

// Tokens never reach a log or a panic message.
impl std::fmt::Debug for SignedIn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SignedIn {{ sub: {}, exp: {} }}", self.access.sub, self.access.exp)
    }
}

impl std::fmt::Debug for Access {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Access {{ sub: {}, exp: {} }}", self.sub, self.exp)
    }
}

struct Pending {
    state: Zeroizing<String>,
    verifier: Zeroizing<String>,
}

pub struct Auth {
    issuer: String,
    agent: ureq::Agent,
    /// One sign-in at a time: a callback that isn't for it is dropped without effect.
    pending: Mutex<Option<Pending>>,
    access: Mutex<Option<Access>>,
    /// Held for the whole refresh, so two callers never spend the same refresh token.
    refreshing: Mutex<()>,
    /// A rotated refresh token the credential store refused to take; used and stored from here until it does.
    unsaved: Mutex<Option<Zeroizing<String>>>,
}

/// How long the identity service still takes a rotated refresh token (30 s), minus a margin.
const REUSE_GRACE_MS: i64 = 25_000;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// A failed token request: the service answered (nothing rotated), or no answer came (it may have).
enum Answer {
    Answered(AuthError),
    Lost(AuthError),
}

impl From<Answer> for AuthError {
    fn from(a: Answer) -> AuthError {
        match a {
            Answer::Answered(e) | Answer::Lost(e) => e,
        }
    }
}

fn random_b64() -> Zeroizing<String> {
    let mut b = Zeroizing::new([0u8; 32]);
    getrandom::fill(b.as_mut()).expect("OS random source");
    Zeroizing::new(b64(b.as_ref()))
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn percent_decode(s: &str) -> Option<String> {
    let mut out = Vec::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(c) = bytes.next() {
        match c {
            b'%' => {
                let hex = [bytes.next()?, bytes.next()?];
                out.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
            }
            b'+' => out.push(b' '),
            c => out.push(c),
        }
    }
    String::from_utf8(out).ok()
}

fn encode(s: &str) -> String {
    s.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-._~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") }).collect()
}

/// The claims of a token the issuer just sent over TLS. Not a signature check: the relay does that.
fn claims(jwt: &str) -> Option<Value> {
    serde_json::from_slice(&unb64(jwt.split('.').nth(1)?)?).ok()
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
}

impl Auth {
    /// HANGAR_AUTH_ISSUER points tests at a local stand-in on a loopback address; release builds ignore it.
    pub fn new() -> Auth {
        let test_issuer = if cfg!(debug_assertions) { std::env::var("HANGAR_AUTH_ISSUER").ok().filter(|i| i.starts_with("http://127.0.0.1:")) } else { None };
        let issuer = test_issuer.unwrap_or_else(|| ISSUER.into());
        let agent = ureq::Agent::config_builder().http_status_as_error(false).https_only(issuer.starts_with("https://")).timeout_global(Some(Duration::from_secs(20))).build().into();
        Auth { issuer, agent, pending: Mutex::default(), access: Mutex::default(), refreshing: Mutex::default(), unsaved: Mutex::default() }
    }

    /// Starts a sign-in and returns the URL to open in the browser. `fresh` asks for an interactive login even with a
    /// browser session (prompt=login) and binds the id_token to `nonce`: the relay's proof for a recovery reset.
    pub fn begin(&self, fresh: Option<&str>) -> String {
        let (state, verifier) = (random_b64(), random_b64());
        let challenge = b64(&Sha256::digest(verifier.as_bytes()));
        let mut url = format!(
            "{}/api/auth/oauth2/authorize?response_type=code&client_id={CLIENT_ID}&redirect_uri={}&scope={}&state={}&code_challenge={challenge}&code_challenge_method=S256&resource={}",
            self.issuer,
            encode(REDIRECT_URI),
            encode(SCOPE),
            state.as_str(),
            encode(RESOURCE)
        );
        if let Some(nonce) = fresh {
            url += &format!("&prompt=login&max_age=0&nonce={}", encode(nonce));
        }
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(Pending { state, verifier });
        url
    }

    /// Redeems the deep link. Anything but the callback of the pending sign-in, with its state and our issuer, is
    /// refused and leaves the pending sign-in as it was.
    pub fn complete(&self, callback: &str) -> Result<SignedIn, AuthError> {
        let bad = |m: &str| AuthError::Invalid(m.into());
        let query = callback.strip_prefix(REDIRECT_URI).and_then(|q| q.strip_prefix('?')).ok_or_else(|| bad("callback"))?;
        let mut params = std::collections::HashMap::new();
        for pair in query.split('&') {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let (k, v) = (percent_decode(k).ok_or_else(|| bad("query"))?, percent_decode(v).ok_or_else(|| bad("query"))?);
            // A repeated parameter is ambiguous; refuse rather than pick one.
            if params.insert(k, v).is_some() {
                return Err(bad("query"));
            }
        }
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        let state = params.get("state").ok_or_else(|| bad("state"))?;
        if !pending.as_ref().is_some_and(|p| ct_eq(&p.state, state)) {
            return Err(bad("state"));
        }
        if params.get("iss").map(String::as_str) != Some(self.issuer.as_str()) {
            return Err(bad("iss"));
        }
        if let Some(e) = params.get("error") {
            *pending = None;
            return Err(AuthError::Invalid(e.clone()));
        }
        let code = params.get("code").ok_or_else(|| bad("code"))?.clone();
        let verifier = pending.take().expect("checked above").verifier;
        drop(pending);
        let reply = self.token(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", REDIRECT_URI), ("code_verifier", &verifier)]).map_err(AuthError::from)?;
        let access = self.accept(reply.access_token, reply.refresh_token)?;
        Ok(SignedIn { access, id_token: reply.id_token })
    }

    /// A valid access token, refreshing it when it has less than a minute left.
    pub fn access(&self) -> Result<Access, AuthError> {
        let fresh = |a: &Option<Access>| a.as_ref().filter(|a| a.exp - chrono::Utc::now().timestamp() > 60).cloned();
        if let Some(a) = fresh(&self.access.lock().unwrap_or_else(|e| e.into_inner())) {
            return Ok(a);
        }
        let _flight = self.refreshing.lock().unwrap_or_else(|e| e.into_inner());
        // Whoever held the lock before us may have refreshed already.
        if let Some(a) = fresh(&self.access.lock().unwrap_or_else(|e| e.into_inner())) {
            return Ok(a);
        }
        // Bound first: a guard in the match scrutinee would live through forget(), which takes the same lock.
        let unsaved = self.unsaved.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let refresh = match unsaved {
            // A rotated token we couldn't store yet: it is the live one, the stored one is retired.
            Some(r) => r,
            None => {
                let stored = secrets::load().map_err(AuthError::Unavailable)?.ok_or(AuthError::SignedOut)?;
                if stored.refresh.is_empty() {
                    return Err(AuthError::SignedOut);
                }
                // A refresh went out and its answer never came back: the server may have rotated the token. Past the
                // reuse grace, sending the old one again would revoke every machine of the account, so only this one
                // signs out.
                if stored.refresh_sent_at != 0 && now_ms() - stored.refresh_sent_at > REUSE_GRACE_MS {
                    self.forget()?;
                    return Err(AuthError::SignedOut);
                }
                Zeroizing::new(stored.refresh.clone())
            }
        };
        secrets::update(|s| {
            let mut s = s.ok_or("no device identity")?;
            if s.refresh_sent_at == 0 {
                s.refresh_sent_at = now_ms();
            }
            Ok((Some(s), ()))
        })
        .map_err(AuthError::Unavailable)?;
        match self.token(&[("grant_type", "refresh_token"), ("refresh_token", &refresh)]) {
            Ok(reply) => self.accept(reply.access_token, reply.refresh_token),
            // The service answered, so nothing rotated (or, for invalid_grant, the token is dead for this machine).
            Err(Answer::Answered(e)) => {
                if e == AuthError::Invalid("invalid_grant".into()) {
                    self.forget()?;
                    return Err(AuthError::SignedOut);
                }
                let _ = secrets::update(|s| Ok((s.map(|mut s| (s.refresh_sent_at = 0, s).1), ())));
                Err(e)
            }
            // No answer: the request may or may not have reached the server; the mark stays for the next attempt.
            Err(Answer::Lost(e)) => Err(e),
        }
    }

    /// Stores the rotated refresh token, then caches and returns the access token. If the store fails the new token
    /// stays in memory and is stored (and used) from there: falling back to the retired one would revoke everything.
    fn accept(&self, token: String, refresh: Option<String>) -> Result<Access, AuthError> {
        let c = claims(&token).ok_or_else(|| AuthError::Invalid("access_token".into()))?;
        let (Some(sub), Some(exp)) = (c["sub"].as_str(), c["exp"].as_i64()) else { return Err(AuthError::Invalid("access_token".into())) };
        let refresh = Zeroizing::new(refresh.ok_or_else(|| AuthError::Invalid("refresh_token".into()))?);
        let stored = secrets::update(|s| {
            let mut s = s.ok_or("no device identity")?;
            s.refresh = refresh.to_string();
            s.refresh_sent_at = 0;
            Ok((Some(s), ()))
        });
        *self.unsaved.lock().unwrap_or_else(|e| e.into_inner()) = stored.is_err().then(|| refresh.clone());
        if let Err(e) = stored {
            eprintln!("cloud: refresh token kept in memory, store failed: {e}");
        }
        let a = Access { token, sub: sub.into(), exp };
        *self.access.lock().unwrap_or_else(|e| e.into_inner()) = Some(a.clone());
        Ok(a)
    }

    /// Signs this machine out: the refresh token is dropped here and revoked at the service when it can be reached.
    pub fn sign_out(&self) -> Result<(), AuthError> {
        let _flight = self.refreshing.lock().unwrap_or_else(|e| e.into_inner());
        let unsaved = self.unsaved.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let stored = secrets::load().map_err(AuthError::Unavailable)?.map(|s| Zeroizing::new(s.refresh.clone()));
        if let Some(token) = unsaved.or(stored).filter(|t| !t.is_empty()) {
            let url = format!("{}/api/auth/oauth2/revoke", self.issuer);
            let _ = self.agent.post(&url).send_form([("token", token.as_str()), ("token_type_hint", "refresh_token"), ("client_id", CLIENT_ID)]);
        }
        self.forget()
    }

    fn forget(&self) -> Result<(), AuthError> {
        *self.access.lock().unwrap_or_else(|e| e.into_inner()) = None;
        *self.unsaved.lock().unwrap_or_else(|e| e.into_inner()) = None;
        secrets::update(|s| {
            Ok((
                s.map(|mut s| {
                    s.refresh.clear();
                    s.refresh_sent_at = 0;
                    s
                }),
                (),
            ))
        })
        .map_err(AuthError::Unavailable)
    }

    fn token(&self, grant: &[(&str, &str)]) -> Result<TokenReply, Answer> {
        let url = format!("{}/api/auth/oauth2/token", self.issuer);
        let mut form: Vec<(&str, &str)> = grant.to_vec();
        form.extend([("client_id", CLIENT_ID), ("resource", RESOURCE)]);
        let lost = |e: String| Answer::Lost(AuthError::Unavailable(e));
        let mut res = self.agent.post(&url).send_form(form).map_err(|e| lost(e.to_string()))?;
        let status = res.status().as_u16();
        let body = res.body_mut().read_to_string().map_err(|e| lost(e.to_string()))?;
        match status {
            // A 200 we can't read is as good as lost: the server rotated, and we don't have the new token.
            200 => serde_json::from_str(&body).map_err(|_| Answer::Lost(AuthError::Invalid("token reply".into()))),
            429 | 500..=599 => Err(Answer::Answered(AuthError::Unavailable(format!("HTTP {status}")))),
            _ => {
                let code = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["error"].as_str().map(String::from));
                Err(Answer::Answered(AuthError::Invalid(code.unwrap_or_else(|| format!("HTTP {status}")))))
            }
        }
    }
}

impl Default for Auth {
    fn default() -> Self {
        Auth::new()
    }
}
