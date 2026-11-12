// Remote control as one service: the sign-in, the link to the relay, the verified device chain, the Noise sessions
// and the request/reply calls over them. This machine answers calls with Hangar::handle_remote (the allowlist and the
// per-machine switch live there) and makes calls for its own UI.
//
// Call (plaintext inside Noise):   {"id": n, "m": method, "p": path, "b": body}
// Reply:                           {"id": n, "s": status, "b": body}
use super::chain::{self, check_pin, pin_of, Entry, Members, Pin, State};
use super::identity::Identity;
use super::link::{self, Cmd, Handler, LinkState};
use super::oauth::{Auth, AuthError};
use super::peer::Peers;
use super::secrets;
use crate::{Hangar, Reply};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// How old (or how far ahead, for clocks that disagree) a call may be when it arrives.
const MAX_CALL_AGE_MS: i64 = 30_000;

/// Where this machine stands with the account's device chain.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Trust {
    /// Not connected yet, or no chain seen since starting.
    Unknown,
    /// The chain extends what this machine pinned, and this machine is in it.
    Member,
    /// The account has devices but this machine isn't one of them: it needs pairing.
    NotPaired,
    /// The relay's chain doesn't extend the pinned one (reset, rollback, rewritten history, another account).
    Refused(String),
}

struct View {
    link: LinkState,
    sub: Option<String>,
    trust: Trust,
    epoch: u64,
    state: State,
    online: Vec<String>,
    reset_at: Option<i64>,
    /// The relay's challenge for the current socket: the nonce a fresh sign-in binds to for a recovery reset.
    nonce: String,
}

pub struct Cloud {
    me: Weak<Cloud>,
    hangar: Weak<Hangar>,
    pub auth: Arc<Auth>,
    identity: Arc<Identity>,
    view: Mutex<View>,
    peers: Mutex<Peers>,
    out: Sender<Cmd>,
    calls: Mutex<HashMap<u64, Sender<Reply>>>,
    next_id: AtomicU64,
    stop: Arc<AtomicBool>,
}

impl Cloud {
    /// Creates the device identity if needed and starts the link thread.
    pub fn start(hangar: Weak<Hangar>) -> Result<Arc<Cloud>, String> {
        let identity = Arc::new(Identity::load_or_create()?);
        let (out, rx) = mpsc::channel();
        let peers = Peers::new(identity.device(), identity.dh_private());
        let view = View { link: LinkState::Connecting, sub: None, trust: Trust::Unknown, epoch: 0, state: State::default(), online: vec![], reset_at: None, nonce: String::new() };
        let cloud = Arc::new_cyclic(|me| Cloud {
            me: me.clone(),
            hangar,
            auth: Arc::new(Auth::new()),
            identity: Arc::clone(&identity),
            view: Mutex::new(view),
            peers: Mutex::new(peers),
            out,
            calls: Mutex::default(),
            next_id: AtomicU64::new(1),
            stop: Arc::new(AtomicBool::new(false)),
        });
        let (auth, handler, stop) = (Arc::clone(&cloud.auth), Arc::clone(&cloud) as Arc<dyn Handler>, Arc::clone(&cloud.stop));
        std::thread::spawn(move || link::run(auth, identity, handler, rx, stop));
        Ok(cloud)
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    fn view(&self) -> std::sync::MutexGuard<'_, View> {
        self.view.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn members(&self) -> Members {
        let v = self.view();
        if v.trust == Trust::Member { v.state.members.clone() } else { Members::new() }
    }

    /// GET /api/cloud
    pub fn status(&self) -> Value {
        let v = self.view();
        let me = self.identity.device();
        let link = match &v.link {
            LinkState::SignedOut => json!({ "state": "signed_out" }),
            LinkState::Connecting => json!({ "state": "connecting" }),
            LinkState::Online => json!({ "state": "online" }),
            LinkState::Retrying(e) => json!({ "state": "retrying", "reason": e }),
        };
        let machines: Vec<Value> = if v.trust == Trust::Member {
            v.state.members.keys().map(|d| json!({ "device": d, "me": *d == me, "online": *d == me || v.online.contains(d) })).collect()
        } else {
            vec![]
        };
        json!({ "link": link, "account": v.sub, "device": me, "trust": v.trust, "machines": machines, "reset": v.reset_at })
    }

    /// Calls `method path` on another machine of the account and waits for its reply.
    pub fn call(&self, device: &str, method: &str, path: &str, body: &str) -> Reply {
        let err = |status: u16, e: &str| Reply { status, body: json!({ "error": e }) };
        let members = self.members();
        if !members.contains_key(device) || device == self.identity.device() {
            return err(404, "unknown_machine");
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.calls.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        let msg = json!({ "id": id, "at": chrono::Utc::now().timestamp_millis(), "m": method, "p": path, "b": body }).to_string();
        let sent = self.peers.lock().unwrap_or_else(|e| e.into_inner()).send(&members, device, msg.as_bytes());
        let reply = match sent {
            Ok(frames) => {
                for (to, f) in frames {
                    let _ = self.out.send(Cmd::Frame(to, f));
                }
                rx.recv_timeout(CALL_TIMEOUT).unwrap_or_else(|_| err(504, "machine_timeout"))
            }
            Err(e) => err(502, &e),
        };
        self.calls.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
        reply
    }

    /// Accepts the relay's chain against the pin, or pins it if this machine has none and the chain is its own.
    fn accept_chain(&self, sub: &str, epoch: u64, entries: &[Entry]) {
        let me = self.identity.device();
        let pin: Option<Pin> = secrets::load().ok().flatten().and_then(|s| serde_json::from_str(&s.pin).ok());
        let verdict = match &pin {
            Some(p) => check_pin(p, sub, epoch, entries).map_err(String::from),
            // No pin yet: an empty chain means this is the account's first machine, which roots it (see ready()).
            None if entries.is_empty() => Ok(State::default()),
            None => chain::verify(entries).map_err(String::from).and_then(|s| if s.members.contains_key(&me) { Err("unpinned".into()) } else { Ok(s) }),
        };
        let mut v = self.view();
        v.epoch = epoch;
        match verdict {
            Ok(state) => {
                let member = state.members.contains_key(&me);
                v.trust = match (&pin, member) {
                    (_, true) => Trust::Member,
                    (Some(_), false) => Trust::Refused("removed".into()),
                    (None, false) => Trust::NotPaired,
                };
                if member {
                    if let Some(p) = pin_of(sub, epoch, &state) {
                        let text = serde_json::to_string(&p).unwrap_or_default();
                        let _ = secrets::update(|s| Ok((s.map(|mut s| (s.pin = text, s).1), ())));
                    }
                }
                v.state = state;
            }
            Err(e) => {
                v.trust = Trust::Refused(e);
                v.state = State::default();
            }
        }
        let members = v.state.members.clone();
        drop(v);
        self.peers.lock().unwrap_or_else(|e| e.into_inner()).retain(&members);
    }

    /// The first machine of an account roots the chain with itself.
    fn root(&self) {
        let body = chain::Body { v: 1, seq: 0, prev: String::new(), op: "root".into(), device: self.identity.device(), dh: Some(self.identity.dh()), signer: self.identity.device() };
        let text = body.canonical();
        let entry = Entry { sig: self.identity.sign(text.as_bytes()), body: text };
        let _ = self.out.send(Cmd::Text(json!({ "t": "chain.append", "entry": entry })));
    }

    fn answer(self: &Arc<Self>, from: String, sid: [u8; 8], msg: Value) {
        let me = Arc::clone(self);
        // A call can take a while (resume drives the terminal): never on the link thread.
        std::thread::spawn(move || {
            let Some(h) = me.hangar.upgrade() else { return };
            let (m, p, b) = (msg["m"].as_str().unwrap_or(""), msg["p"].as_str().unwrap_or(""), msg["b"].as_str().unwrap_or(""));
            // Noise stops replays, not delays: the relay could hold a call back and deliver it later (a close of a
            // session the person has since resumed). A call older than this, or from too far in the future, is refused.
            let age = chrono::Utc::now().timestamp_millis() - msg["at"].as_i64().unwrap_or(0);
            let r = if age.abs() > MAX_CALL_AGE_MS { Reply { status: 408, body: json!({ "error": "stale_call" }) } } else { h.handle_remote(&from, m, p, b) };
            let reply = json!({ "id": msg["id"], "s": r.status, "b": r.body }).to_string();
            if let Ok(frames) = me.peers.lock().unwrap_or_else(|e| e.into_inner()).reply(&from, &sid, reply.as_bytes()) {
                for (to, f) in frames {
                    let _ = me.out.send(Cmd::Frame(to, f));
                }
            }
        });
    }
}

impl Handler for Cloud {
    fn state(&self, s: LinkState) {
        self.view().link = s;
    }

    fn ready(&self, sub: &str, nonce: &str, epoch: u64, chain: Vec<Entry>, online: Vec<String>, reset: Option<i64>) {
        {
            let mut v = self.view();
            v.sub = Some(sub.into());
            v.online = online;
            v.reset_at = reset;
            v.nonce = nonce.into();
        }
        let has_pin = secrets::load().ok().flatten().is_some_and(|s| !s.pin.is_empty());
        self.accept_chain(sub, epoch, &chain);
        if chain.is_empty() && epoch == 0 && !has_pin {
            self.root();
        }
        // A member online when a recovery reset is pending vetoes it: there is something left to recover with.
        if reset.is_some() && self.view().trust == Trust::Member {
            let _ = self.out.send(Cmd::Text(json!({ "t": "chain.veto" })));
        }
    }

    fn control(&self, m: Value) {
        match m["t"].as_str() {
            Some("presence") => self.view().online = serde_json::from_value(m["online"].clone()).unwrap_or_default(),
            Some("chain") => {
                // Only the new entries come; they must extend the chain already verified.
                let (sub, epoch) = {
                    let v = self.view();
                    (v.sub.clone().unwrap_or_default(), v.epoch)
                };
                let entries = serde_json::from_value::<Vec<Entry>>(m["entries"].clone()).unwrap_or_default();
                self.extend_chain(&sub, m["epoch"].as_u64().unwrap_or(epoch), entries);
            }
            Some("reset.pending") => {
                self.view().reset_at = m["at"].as_i64();
                if self.view().trust == Trust::Member {
                    let _ = self.out.send(Cmd::Text(json!({ "t": "chain.veto" })));
                }
            }
            Some("reset.vetoed") => self.view().reset_at = None,
            Some("reset") => {
                let mut v = self.view();
                v.reset_at = None;
                v.epoch = m["epoch"].as_u64().unwrap_or(v.epoch);
                // The pinned chain is gone at the relay; this machine refuses the new one until paired again.
                v.trust = Trust::Refused("epoch".into());
                v.state = State::default();
                drop(v);
                self.peers.lock().unwrap_or_else(|e| e.into_inner()).retain(&Members::new());
            }
            _ => {}
        }
    }

    fn frame(&self, from: String, payload: Vec<u8>) {
        let members = self.members();
        let (out, done) = self.peers.lock().unwrap_or_else(|e| e.into_inner()).receive(&members, &from, &payload);
        for (to, f) in out {
            let _ = self.out.send(Cmd::Frame(to, f));
        }
        for i in done {
            let Ok(msg) = serde_json::from_slice::<Value>(&i.message) else { continue };
            if i.mine {
                // On the session we started: only a reply to a call still waiting.
                if let Some(tx) = msg["id"].as_u64().and_then(|id| self.calls.lock().unwrap_or_else(|e| e.into_inner()).remove(&id)) {
                    let _ = tx.send(Reply { status: msg["s"].as_u64().unwrap_or(502) as u16, body: msg["b"].clone() });
                }
            } else if let Some(me) = self.me.upgrade() {
                // On the peer's session: only a call, answered as that device.
                me.answer(from.clone(), i.sid, msg);
            }
        }
    }
}

impl Cloud {
    /// New entries from the relay: accepted only as an extension of the verified chain.
    fn extend_chain(&self, sub: &str, epoch: u64, new: Vec<Entry>) {
        let mut v = self.view();
        if epoch != v.epoch {
            return;
        }
        let mut state = v.state.clone();
        for e in &new {
            match chain::append(&state, e) {
                Ok(s) => state = s,
                Err(err) => {
                    v.trust = Trust::Refused(err.into());
                    return;
                }
            }
        }
        let me = self.identity.device();
        let member = state.members.contains_key(&me);
        let had_pin = secrets::load().ok().flatten().is_some_and(|s| !s.pin.is_empty());
        v.trust = if member { Trust::Member } else if had_pin { Trust::Refused("removed".into()) } else { Trust::NotPaired };
        if member {
            if let Some(p) = pin_of(sub, epoch, &state) {
                let text = serde_json::to_string(&p).unwrap_or_default();
                let _ = secrets::update(|s| Ok((s.map(|mut s| (s.pin = text, s).1), ())));
            }
        }
        v.state = state;
        let members = v.state.members.clone();
        drop(v);
        self.peers.lock().unwrap_or_else(|e| e.into_inner()).retain(&members);
    }

    pub fn begin_login(&self) -> String {
        self.auth.begin(None)
    }

    pub fn complete_login(&self, callback: &str) -> Result<(), AuthError> {
        self.auth.complete(callback).map(|_| ())
    }

    pub fn sign_out(&self) -> Result<(), AuthError> {
        self.auth.sign_out()
    }
}
