// The connection to the relay at hangar.odahcam.com: one WebSocket, kept open by a thread of its own. It proves the
// device key on every connect, renews the access token in-band before it expires, pings so idle sockets stay open
// (the relay answers pings without waking up), and reconnects with backoff. What arrives goes to a Handler; what
// leaves comes in through a channel, so any thread can send.
use super::chain::Entry;
use super::identity::Identity;
use super::oauth::{AuthError, Auth};
use super::{b64, unb64};
use serde_json::{json, Value};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

const RELAY: &str = "wss://hangar.odahcam.com/v1/connect";
const PING_EVERY: Duration = Duration::from_secs(30);
/// Renew the token this long before it expires.
const RENEW_BEFORE_S: i64 = 120;
const TICK: Duration = Duration::from_millis(200);

/// What leaves: a control message, or a frame for another device.
pub enum Cmd {
    Text(Value),
    Frame(String, Vec<u8>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum LinkState {
    SignedOut,
    Connecting,
    Online,
    /// Waiting before the next attempt, with the reason.
    Retrying(String),
}

pub trait Handler: Send + Sync {
    fn state(&self, s: LinkState);
    /// The relay accepted the socket: the account, its chain and who is online.
    fn ready(&self, sub: &str, nonce: &str, epoch: u64, chain: Vec<Entry>, online: Vec<String>, reset: Option<i64>);
    /// Any other control message (chain, reset, presence, offline, error, ...).
    fn control(&self, m: Value);
    fn frame(&self, from: String, payload: Vec<u8>);
}

fn relay_url() -> String {
    let test = if cfg!(debug_assertions) { std::env::var("HANGAR_RELAY_URL").ok().filter(|u| u.starts_with("ws://127.0.0.1:")) } else { None };
    test.unwrap_or_else(|| RELAY.into())
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

fn set_timeout(ws: &mut Socket, t: Option<Duration>) {
    let _ = match ws.get_mut() {
        MaybeTlsStream::Plain(s) => s.set_read_timeout(t),
        MaybeTlsStream::Rustls(s) => s.sock.set_read_timeout(t),
        _ => Ok(()),
    };
}

fn would_block(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if matches!(io.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut))
}

/// Runs the connection until `stop` is set.
pub fn run(auth: Arc<Auth>, identity: Arc<Identity>, handler: Arc<dyn Handler>, rx: Receiver<Cmd>, stop: Arc<AtomicBool>) {
    let mut backoff = Duration::from_secs(1);
    while !stop.load(Ordering::SeqCst) {
        let started = Instant::now();
        let reason = match session(&auth, &identity, &*handler, &rx, &stop) {
            Ok(()) => return,
            Err(Stop::SignedOut) => {
                handler.state(LinkState::SignedOut);
                // Nothing to do until someone signs in; check back now and then.
                wait(&rx, &stop, Duration::from_secs(5));
                continue;
            }
            Err(Stop::Failed(e)) => e,
        };
        // A connection that lasted a while starts the backoff over.
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1);
        }
        handler.state(LinkState::Retrying(reason));
        wait(&rx, &stop, backoff);
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

/// Sleeps up to `d`, dropping what is queued meanwhile: frames for a socket that isn't there would be stale.
fn wait(rx: &Receiver<Cmd>, stop: &AtomicBool, d: Duration) {
    let until = Instant::now() + d;
    while !stop.load(Ordering::SeqCst) && Instant::now() < until {
        match rx.recv_timeout(TICK) {
            Ok(_) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

enum Stop {
    SignedOut,
    Failed(String),
}

fn fail<E: std::fmt::Display>(e: E) -> Stop {
    Stop::Failed(e.to_string())
}

fn session(auth: &Auth, identity: &Identity, handler: &dyn Handler, rx: &Receiver<Cmd>, stop: &AtomicBool) -> Result<(), Stop> {
    let access = match auth.access() {
        Ok(a) => a,
        Err(AuthError::SignedOut) => return Err(Stop::SignedOut),
        Err(e) => return Err(fail(e)),
    };
    handler.state(LinkState::Connecting);
    let mut req = relay_url().into_client_request().map_err(fail)?;
    // In the header, never the URL: request URLs end up in logs.
    req.headers_mut().insert("authorization", format!("Bearer {}", access.token).parse().map_err(fail)?);
    let (mut ws, _) = tungstenite::connect(req).map_err(fail)?;
    set_timeout(&mut ws, Some(Duration::from_secs(10)));

    let read_json = |ws: &mut Socket| -> Result<Value, Stop> {
        loop {
            match ws.read().map_err(fail)? {
                Message::Text(t) => return serde_json::from_str(t.as_str()).map_err(fail),
                Message::Close(c) => return Err(fail(format!("closed {:?}", c.map(|c| u16::from(c.code))))),
                _ => {}
            }
        }
    };
    let challenge = read_json(&mut ws)?;
    let nonce = challenge["nonce"].as_str().filter(|_| challenge["t"] == "challenge").ok_or_else(|| fail("no challenge"))?.to_string();
    let prove = json!({ "t": "prove", "device": identity.device(), "sig": identity.prove(&access.sub, &nonce) });
    ws.send(Message::Text(prove.to_string().into())).map_err(fail)?;
    let ready = loop {
        let m = read_json(&mut ws)?;
        if m["t"] == "ready" {
            break m;
        }
    };
    let chain: Vec<Entry> = serde_json::from_value(ready["chain"].clone()).map_err(fail)?;
    let online: Vec<String> = serde_json::from_value(ready["online"].clone()).unwrap_or_default();
    handler.state(LinkState::Online);
    handler.ready(&access.sub, &nonce, ready["epoch"].as_u64().unwrap_or(0), chain, online, ready["reset"].as_i64());

    set_timeout(&mut ws, Some(TICK));
    let (mut exp, mut last_ping, mut renewing) = (access.exp, Instant::now(), false);
    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = ws.close(None);
            return Ok(());
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                let Ok(m) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                match m["t"].as_str() {
                    Some("pong") => {}
                    Some("auth.ok") => {
                        exp = m["exp"].as_i64().unwrap_or(exp);
                        renewing = false;
                    }
                    _ => handler.control(m),
                }
            }
            Ok(Message::Binary(b)) if b.len() > 32 => handler.frame(b64(&b[..32]), b[32..].to_vec()),
            Ok(Message::Close(c)) => return Err(fail(format!("closed {:?}", c.map(|c| u16::from(c.code))))),
            Ok(_) => {}
            Err(e) if would_block(&e) => {}
            Err(e) => return Err(fail(e)),
        }
        // Everything queued goes out between reads.
        while let Ok(cmd) = rx.try_recv() {
            let msg = match cmd {
                Cmd::Text(v) => Message::Text(v.to_string().into()),
                Cmd::Frame(to, payload) => {
                    let Some(key) = unb64(&to).filter(|k| k.len() == 32) else { continue };
                    Message::Binary([key, payload].concat().into())
                }
            };
            ws.send(msg).map_err(fail)?;
        }
        if last_ping.elapsed() >= PING_EVERY {
            ws.send(Message::Text(r#"{"t":"ping"}"#.into())).map_err(fail)?;
            last_ping = Instant::now();
        }
        if !renewing && exp - chrono::Utc::now().timestamp() < RENEW_BEFORE_S {
            match auth.access() {
                Ok(a) if a.exp > exp => {
                    ws.send(Message::Text(json!({ "t": "auth", "token": a.token }).to_string().into())).map_err(fail)?;
                    renewing = true;
                }
                // Not renewable now: the relay closes the socket at expiry and the reconnect sorts it out.
                _ => {}
            }
        }
    }
}
