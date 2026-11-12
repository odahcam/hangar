// Sign-in and refresh against a stand-in auth.odahcam.com on 127.0.0.1. One test function: the issuer and the
// secrets folder are process-wide environment variables, so the scenarios run in order.
use super::b64;
use super::identity::Identity;
use super::oauth::{Auth, AuthError, REDIRECT_URI};
use super::secrets;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

struct Issuer {
    url: String,
    /// Form fields of each token request, in order.
    requests: Arc<Mutex<Vec<HashMap<String, String>>>>,
    /// Status and body for the next token requests; empty = a fresh token pair.
    script: Arc<Mutex<Vec<(u16, String)>>>,
    /// What /api/oauth2/refresh-status answers, and the tokens it was asked about.
    status: Arc<Mutex<(u16, String)>>,
    status_asked: Arc<Mutex<Vec<String>>>,
}

fn jwt(sub: &str, exp: i64) -> String {
    format!("{}.{}.sig", b64(br#"{"alg":"EdDSA"}"#), b64(format!(r#"{{"sub":"{sub}","exp":{exp}}}"#).as_bytes()))
}

fn issuer() -> Issuer {
    let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
    let url = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let script: Arc<Mutex<Vec<(u16, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let status = Arc::new(Mutex::new((404, String::new())));
    let status_asked = Arc::new(Mutex::new(Vec::new()));
    let (r, s, st, sa) = (Arc::clone(&requests), Arc::clone(&script), Arc::clone(&status), Arc::clone(&status_asked));
    std::thread::spawn(move || {
        let mut n = 0;
        for mut req in server.incoming_requests() {
            let mut body = String::new();
            req.as_reader().read_to_string(&mut body).unwrap();
            let form: HashMap<String, String> = body.split('&').filter_map(|p| p.split_once('=')).map(|(k, v)| (k.to_string(), urlish(v))).collect();
            if req.url() == "/api/oauth2/refresh-status" {
                sa.lock().unwrap().push(form["refresh_token"].clone());
                let (code, body) = st.lock().unwrap().clone();
                let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(code));
                continue;
            }
            r.lock().unwrap().push(form);
            // Slow enough that concurrent refreshes would overlap if they weren't single-flight.
            std::thread::sleep(std::time::Duration::from_millis(100));
            n += 1;
            let next = { let mut q = s.lock().unwrap(); (!q.is_empty()).then(|| q.remove(0)) };
            // Status 0: a 200 whose body can't be read, as if the answer were lost after the server rotated.
            let next = next.map(|(s, b)| if s == 0 { (200, "not json".to_string()) } else { (s, b) });
            let (status, body) = next.unwrap_or_else(|| (200, format!(r#"{{"access_token":"{}","refresh_token":"refresh-{n}","id_token":"id-{n}"}}"#, jwt("user-1", chrono::Utc::now().timestamp() + 3600))));
            let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
        }
    });
    Issuer { url, requests, script, status, status_asked }
}

fn urlish(v: &str) -> String {
    let mut out = Vec::new();
    let b = v.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap(), 16).unwrap());
            i += 3;
        } else {
            out.push(if b[i] == b'+' { b' ' } else { b[i] });
            i += 1;
        }
    }
    String::from_utf8(out).unwrap()
}

fn param(url: &str, k: &str) -> String {
    url.split(['?', '&']).find_map(|p| p.strip_prefix(&format!("{k}="))).map(urlish).unwrap_or_default()
}

#[test]
fn sign_in_and_refresh() {
    let iss = issuer();
    let dir = std::env::temp_dir().join(format!("hangar-oauth-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // SAFETY: set before any other thread of this test reads them; no other test reads these variables.
    unsafe {
        std::env::set_var("HANGAR_AUTH_ISSUER", &iss.url);
        std::env::set_var("HANGAR_SECRETS_DIR", &dir);
    }
    Identity::load_or_create().unwrap();
    let auth = Auth::new();

    // The authorize URL: PKCE S256, our redirect, the relay as resource, a state.
    let url = auth.begin(None);
    assert!(url.starts_with(&format!("{}/api/auth/oauth2/authorize?", iss.url)));
    assert_eq!(param(&url, "code_challenge_method"), "S256");
    assert_eq!(param(&url, "resource"), "https://hangar.odahcam.com");
    assert_eq!(param(&url, "redirect_uri"), REDIRECT_URI);
    assert!(!url.contains("prompt="));
    let state = param(&url, "state");
    let challenge = param(&url, "code_challenge");

    // Callbacks that aren't the pending sign-in's are refused without spending it.
    let cb = |state: &str, iss_: &str| format!("{REDIRECT_URI}?code=c0de&state={state}&iss={}", iss_.replace(':', "%3A").replace('/', "%2F"));
    assert_eq!(auth.complete(&cb("wrong", &iss.url)).unwrap_err(), AuthError::Invalid("state".into()));
    assert_eq!(auth.complete(&cb(&state, "https://evil.example")).unwrap_err(), AuthError::Invalid("iss".into()));
    assert_eq!(auth.complete(&format!("{}&state=x", cb(&state, &iss.url))).unwrap_err(), AuthError::Invalid("query".into()));
    assert_eq!(auth.complete(&cb(&state, &iss.url).replace("hangar://", "evil://")).unwrap_err(), AuthError::Invalid("callback".into()));
    assert!(iss.requests.lock().unwrap().is_empty());

    let signed = auth.complete(&cb(&state, &iss.url)).unwrap();
    assert_eq!(signed.access.sub, "user-1");
    let req = iss.requests.lock().unwrap()[0].clone();
    assert_eq!(req["grant_type"], "authorization_code");
    assert_eq!(req["client_id"], "hangar");
    assert_eq!(req["resource"], "https://hangar.odahcam.com");
    assert_eq!(b64(&Sha256::digest(req["code_verifier"].as_bytes())), challenge);
    assert_eq!(secrets::load().unwrap().unwrap().refresh, "refresh-1");
    // The same callback again: no pending sign-in any more.
    assert_eq!(auth.complete(&cb(&state, &iss.url)).unwrap_err(), AuthError::Invalid("state".into()));

    // A fresh sign-in for a recovery reset asks for an interactive login bound to the relay's nonce.
    let url = auth.begin(Some("relay-nonce"));
    assert_eq!(param(&url, "prompt"), "login");
    assert_eq!(param(&url, "nonce"), "relay-nonce");

    // Refresh: single-flight across threads, rotated token stored.
    let auth = Arc::new(Auth::new());
    let threads: Vec<_> = (0..4).map(|_| { let a = Arc::clone(&auth); std::thread::spawn(move || a.access().unwrap().sub) }).collect();
    for t in threads {
        assert_eq!(t.join().unwrap(), "user-1");
    }
    let reqs = iss.requests.lock().unwrap().clone();
    assert_eq!(reqs.len(), 2, "one refresh for four callers");
    assert_eq!(reqs[1]["grant_type"], "refresh_token");
    assert_eq!(reqs[1]["refresh_token"], "refresh-1");
    assert_eq!(reqs[1]["resource"], "https://hangar.odahcam.com");
    assert_eq!(secrets::load().unwrap().unwrap().refresh, "refresh-2");

    // An unavailable service keeps the refresh token; a rejected one signs this machine out.
    let auth = Auth::new();
    iss.script.lock().unwrap().push((503, "{}".into()));
    assert!(matches!(auth.access(), Err(AuthError::Unavailable(_))));
    assert_eq!(secrets::load().unwrap().unwrap().refresh, "refresh-2");
    iss.script.lock().unwrap().push((400, r#"{"error":"invalid_grant"}"#.into()));
    assert_eq!(auth.access().unwrap_err(), AuthError::SignedOut);
    assert_eq!(secrets::load().unwrap().unwrap().refresh, "");
    // The device identity survives signing out.
    assert!(!secrets::load().unwrap().unwrap().ed25519.is_empty());

    // A refresh whose answer is lost: retried with the same token inside the reuse grace, never after it.
    let set_refresh = |r: &str, sent_at: i64| secrets::update(|s| { let mut s = s.unwrap(); s.refresh = r.into(); s.refresh_sent_at = sent_at; Ok((Some(s), ())) }).unwrap();
    set_refresh("refresh-x", 0);
    let auth = Auth::new();
    iss.script.lock().unwrap().push((0, String::new()));
    assert!(auth.access().is_err());
    let s = secrets::load().unwrap().unwrap();
    assert_eq!(s.refresh, "refresh-x");
    assert_ne!(s.refresh_sent_at, 0, "the request is marked as sent");
    let before = iss.requests.lock().unwrap().len();
    assert!(auth.access().is_ok(), "retried inside the grace");
    assert_eq!(iss.requests.lock().unwrap()[before]["refresh_token"], "refresh-x");
    assert_eq!(secrets::load().unwrap().unwrap().refresh_sent_at, 0);
    // Past the grace the service is asked what became of the token, and the token is sent again only if it's current.
    let long_ago = || chrono::Utc::now().timestamp_millis() - 30_000;
    let sent = || iss.requests.lock().unwrap().len();
    set_refresh("refresh-y", long_ago());
    let before = sent();
    // Can't ask (no endpoint, 404): neither sent nor signed out.
    assert_eq!(Auth::new().access().unwrap_err(), AuthError::Unavailable("refresh_status".into()));
    assert_eq!((sent(), secrets::load().unwrap().unwrap().refresh.as_str()), (before, "refresh-y"));
    *iss.status.lock().unwrap() = (200, r#"{"status":"current"}"#.into());
    assert!(Auth::new().access().is_ok());
    assert_eq!(iss.requests.lock().unwrap()[before]["refresh_token"], "refresh-y");
    assert_eq!(iss.status_asked.lock().unwrap().last().unwrap(), "refresh-y");
    set_refresh("refresh-z", long_ago());
    *iss.status.lock().unwrap() = (200, r#"{"status":"rotated"}"#.into());
    let before = sent();
    assert_eq!(Auth::new().access().unwrap_err(), AuthError::SignedOut);
    assert_eq!(sent(), before, "a rotated token is never sent again");
    assert_eq!(secrets::load().unwrap().unwrap().refresh, "");

    // A 5xx after a pending mark keeps the mark: the rotation may have happened before the error.
    set_refresh("refresh-w", long_ago() + 20_000);
    iss.script.lock().unwrap().push((503, "{}".into()));
    let marked = secrets::load().unwrap().unwrap().refresh_sent_at;
    assert!(Auth::new().access().is_err());
    assert!(secrets::load().unwrap().unwrap().refresh_sent_at >= marked);

    // A request that never left this machine (nothing listening) leaves no mark behind.
    set_refresh("refresh-v", 0);
    let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_url = format!("http://127.0.0.1:{}", dead.local_addr().unwrap().port());
    drop(dead);
    // SAFETY: as above; restored right after.
    unsafe { std::env::set_var("HANGAR_AUTH_ISSUER", &dead_url) };
    let offline = Auth::new();
    unsafe { std::env::set_var("HANGAR_AUTH_ISSUER", &iss.url) };
    assert!(matches!(offline.access(), Err(AuthError::Unavailable(_))));
    let s = secrets::load().unwrap().unwrap();
    assert_eq!((s.refresh.as_str(), s.refresh_sent_at), ("refresh-v", 0));
    let _ = std::fs::remove_dir_all(&dir);
}
