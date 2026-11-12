// Remote control as one service: the sign-in, the link to the relay, the verified device chain, pairing, the Noise
// sessions and the request/reply calls over them. This machine answers calls with Hangar::handle_remote (the
// allowlist and the per-machine switch live there) and makes calls for its own UI.
//
// Trust comes from the pin alone. A machine becomes a member in exactly two ways: it roots an empty chain itself
// (the account's first machine), or it pairs with a member and gets the pin over the pairing channel. After that the
// relay's chain counts only as an extension of what was pinned; a reset, a rollback or a rewritten history leaves
// this machine refusing every chain until the person pairs it again.
//
// Call (plaintext inside Noise):   {"id": n, "at": ms, "m": method, "p": path, "b": body}
// Reply:                           {"id": n, "s": status, "b": body}
use super::chain::{self, check_pin, pin_of, Body, Entry, Pin, State};
use super::identity::Identity;
use super::link::{self, Cmd, Handler, LinkState};
use super::oauth::{Auth, AuthError};
use super::pairing::{self, Join, JoinStep, MemberStep, Offer};
use super::peer::Peers;
use super::secrets;
use crate::{Hangar, Reply};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

const CALL_TIMEOUT: Duration = Duration::from_secs(20);
/// How old (or how far ahead, for clocks that disagree) a call may be when it arrives.
const MAX_CALL_AGE_MS: i64 = 30_000;
/// Calls from one device handled at once; more are refused, not queued.
const MAX_CALLS_PER_DEVICE: usize = 4;

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case", tag = "state", content = "reason")]
pub enum Trust {
    /// No chain seen yet since starting.
    Unknown,
    /// The relay's chain extends this machine's pin, and this machine is in it with its own keys.
    Member,
    /// No pin: the account has machines and this one isn't paired with them.
    NotPaired,
    /// A pin exists but the relay's chain doesn't extend it, or this machine was removed: pair again.
    Refused(String),
}

struct View {
    link: LinkState,
    sub: Option<String>,
    trust: Trust,
    /// The pinned epoch while a member.
    epoch: u64,
    /// The verified chain while a member; empty otherwise.
    state: State,
    /// The relay's chain as received, unverified: what a pin from pairing is checked against.
    seen: Vec<Entry>,
    seen_epoch: u64,
    online: Vec<String>,
    reset_at: Option<i64>,
    /// The root entry this machine sent for an empty chain, until the relay confirms it.
    rooting: Option<Entry>,
    /// The relay's challenge for the current socket: what a fresh sign-in binds to for a recovery reset.
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
    /// Pending calls by (device called, id): a reply only counts from the device it was asked of.
    calls: Mutex<HashMap<(String, u64), Sender<Reply>>>,
    next_id: AtomicU64,
    /// Calls being answered, per calling device.
    busy: Mutex<HashMap<String, usize>>,
    offer: Mutex<Option<Offer>>,
    join: Mutex<Option<Join>>,
    /// The pending sign-in is a recovery one (begin_recovery).
    recovery: Mutex<bool>,
    /// A chain.reset was sent and the relay hasn't answered it yet.
    asked: Mutex<bool>,
    /// The device the last code added, for the UI to show.
    joined: Mutex<Option<String>>,
    /// The last pairing this machine tried was refused.
    join_refused: AtomicBool,
    stop: Arc<AtomicBool>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn stored_pin() -> Option<Pin> {
    secrets::load().ok().flatten().and_then(|s| serde_json::from_str(&s.pin).ok())
}

fn save_pin(pin: &Pin) {
    let text = serde_json::to_string(pin).unwrap_or_default();
    if let Err(e) = secrets::update(|s| Ok((s.map(|mut s| (s.pin = text, s).1), ()))) {
        eprintln!("cloud: pin not stored: {e}");
    }
}

impl Cloud {
    /// Creates the device identity if needed and starts the link thread.
    pub fn start(hangar: Weak<Hangar>) -> Result<Arc<Cloud>, String> {
        let identity = Arc::new(Identity::load_or_create()?);
        let (out, rx) = mpsc::channel();
        let peers = Peers::new(identity.device(), identity.dh_private());
        let view = View {
            link: LinkState::Connecting,
            sub: None,
            trust: Trust::Unknown,
            epoch: 0,
            state: State::default(),
            seen: vec![],
            seen_epoch: 0,
            online: vec![],
            reset_at: None,
            rooting: None,
            nonce: String::new(),
        };
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
            busy: Mutex::default(),
            offer: Mutex::default(),
            join: Mutex::default(),
            recovery: Mutex::default(),
            asked: Mutex::default(),
            joined: Mutex::default(),
            join_refused: AtomicBool::new(false),
            stop: Arc::new(AtomicBool::new(false)),
        });
        let (auth, handler, stop) = (Arc::clone(&cloud.auth), Arc::clone(&cloud) as Arc<dyn Handler>, Arc::clone(&cloud.stop));
        std::thread::spawn(move || link::run(auth, identity, handler, rx, stop));
        Ok(cloud)
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }

    fn send(&self, frames: Vec<(String, Vec<u8>)>) {
        for (to, f) in frames {
            let _ = self.out.send(Cmd::Frame(to, f));
        }
    }

    /// Members while this machine is one; nobody otherwise.
    fn members(&self) -> chain::Members {
        let v = lock(&self.view);
        if v.trust == Trust::Member { v.state.members.clone() } else { chain::Members::new() }
    }

    /// GET /api/cloud
    pub fn status(&self) -> Value {
        let v = lock(&self.view);
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
        let offer = lock(&self.offer).as_ref().filter(|o| o.live()).map(|o| o.code().to_string());
        json!({ "link": link, "account": v.sub, "device": me, "trust": v.trust, "machines": machines, "reset": v.reset_at, "offer": offer,
            "joining": lock(&self.join).as_ref().is_some_and(|j| j.live()), "joinRefused": self.join_refused.load(Ordering::SeqCst), "joined": *lock(&self.joined) })
    }

    /// Calls `method path` on another machine of the account and waits for its reply.
    pub fn call(&self, device: &str, method: &str, path: &str, body: &str) -> Reply {
        let err = |status: u16, e: &str| Reply { status, body: json!({ "error": e }) };
        let members = self.members();
        if !members.contains_key(device) || device == self.identity.device() {
            return err(404, "unknown_machine");
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let key = (device.to_string(), id);
        let (tx, rx) = mpsc::channel();
        lock(&self.calls).insert(key.clone(), tx);
        let msg = json!({ "id": id, "at": chrono::Utc::now().timestamp_millis(), "m": method, "p": path, "b": body }).to_string();
        let sent = lock(&self.peers).send(&members, device, msg.as_bytes());
        let reply = match sent {
            Ok(frames) => {
                self.send(frames);
                rx.recv_timeout(CALL_TIMEOUT).unwrap_or_else(|_| err(504, "machine_timeout"))
            }
            Err(e) => err(502, &e),
        };
        lock(&self.calls).remove(&key);
        reply
    }

    /// Sets trust from a verified state: a member only with its own device and Noise keys in it.
    fn settle(&self, v: &mut View, sub: &str, epoch: u64, state: State) {
        let me = self.identity.device();
        match state.members.get(&me) {
            Some(dh) if *dh == self.identity.dh() => {
                if let Some(p) = pin_of(sub, epoch, &state) {
                    save_pin(&p);
                }
                // A member has nothing left to recover.
                Self::set_recover(String::new());
                v.trust = Trust::Member;
                v.epoch = epoch;
                v.state = state;
            }
            Some(_) => self.refuse(v, "dh"),
            None => self.refuse(v, "removed"),
        }
    }

    fn refuse(&self, v: &mut View, why: &str) {
        v.trust = Trust::Refused(why.into());
        v.state = State::default();
    }

    /// The relay's whole chain, on connect.
    fn on_chain(&self, sub: &str, epoch: u64, entries: Vec<Entry>) {
        let mut v = lock(&self.view);
        v.seen = entries.clone();
        v.seen_epoch = epoch;
        match stored_pin() {
            Some(pin) => match check_pin(&pin, sub, epoch, &entries) {
                Ok(state) => self.settle(&mut v, sub, epoch, state),
                Err(e) => self.refuse(&mut v, e),
            },
            None => {
                v.trust = Trust::NotPaired;
                v.state = State::default();
                // The account's first machine roots the chain with itself.
                if entries.is_empty() && epoch == 0 {
                    self.send_root(&mut v);
                }
            }
        }
        self.root_if_recovering(&mut v);
        let members = if v.trust == Trust::Member { v.state.members.clone() } else { chain::Members::new() };
        drop(v);
        lock(&self.peers).retain(&members);
    }

    fn send_root(&self, v: &mut View) {
        let body = Body { v: 1, seq: 0, prev: String::new(), op: "root".into(), device: self.identity.device(), dh: Some(self.identity.dh()), signer: self.identity.device() };
        let text = body.canonical();
        let entry = Entry { sig: self.identity.sign(text.as_bytes()), body: text };
        v.rooting = Some(entry.clone());
        let _ = self.out.send(Cmd::Text(json!({ "t": "chain.append", "entry": entry })));
    }

    /// Whether this machine's own recovery applies now: for this account, in the epoch right after the one it asked in.
    fn recovering(&self, v: &View) -> bool {
        let Some(s) = secrets::load().ok().flatten() else { return false };
        let Some((sub, epoch)) = s.recover.split_once('\n') else { return false };
        Some(sub) == v.sub.as_deref() && epoch.parse::<u64>().ok().map(|e| e + 1) == Some(v.seen_epoch)
    }

    fn set_recover(value: String) {
        let _ = secrets::update(|s| Ok((s.map(|mut s| (s.recover = value, s).1), ())));
    }

    /// After a recovery reset this machine asked for (on this machine, with a fresh sign-in), the relay's chain is
    /// empty in the next epoch: this machine roots the new chain (the relay lets only the device that asked). The
    /// old pin stays until that root comes back confirmed, so a refused root leaves the machine refusing, not unpaired.
    fn root_if_recovering(&self, v: &mut View) {
        if v.seen.is_empty() && v.rooting.is_none() && self.recovering(v) {
            self.send_root(v);
        }
    }

    /// POST /api/cloud/recover: a fresh sign-in (prompt=login) bound to this socket's challenge, for asking the relay
    /// to reset a chain whose machines are all lost. Returns the URL to open; the callback finishes it.
    pub fn begin_recovery(&self) -> Result<String, String> {
        let v = lock(&self.view);
        if v.trust == Trust::Member {
            return Err("member".into());
        }
        if v.nonce.is_empty() {
            return Err("offline".into());
        }
        let url = self.auth.begin(Some(&v.nonce));
        *lock(&self.recovery) = true;
        Ok(url)
    }

    /// New entries, live. They count only as an extension of the verified chain of a member, or as this machine's
    /// own root confirmed. Anything else is kept as seen (for a pairing pin to be checked against) and nothing more.
    fn on_entries(&self, epoch: u64, new: Vec<Entry>) {
        let mut v = lock(&self.view);
        let sub = v.sub.clone().unwrap_or_default();
        if epoch == v.seen_epoch {
            v.seen.extend(new.iter().cloned());
        }
        if v.trust == Trust::Member {
            if epoch != v.epoch {
                return self.refuse(&mut v, "epoch");
            }
            let mut state = v.state.clone();
            for e in &new {
                match chain::append(&state, e) {
                    Ok(s) => state = s,
                    Err(err) => return self.refuse(&mut v, err),
                }
            }
            self.settle(&mut v, &sub, epoch, state);
        } else if let Some(root) = v.rooting.clone() {
            // Our own root confirmed: the account's first machine (no pin, epoch 0), or our recovery's new epoch,
            // where the confirmed root replaces the old pin.
            let ours = (stored_pin().is_none() && epoch == 0) || self.recovering(&v);
            if ours && epoch == v.seen_epoch && new.first() == Some(&root) {
                v.rooting = None;
                match chain::verify(&new) {
                    Ok(state) => self.settle(&mut v, &sub, epoch, state),
                    Err(e) => self.refuse(&mut v, e),
                }
            }
        }
        let members = if v.trust == Trust::Member { v.state.members.clone() } else { chain::Members::new() };
        let added_for_offer = v.state.clone();
        drop(v);
        lock(&self.peers).retain(&members);
        // A device this machine is adding is now in the chain: hand it the pin over the pairing channel.
        let mut offer = lock(&self.offer);
        if let Some(o) = offer.as_mut() {
            if o.accepted.as_ref().is_some_and(|(d, _, _)| added_for_offer.members.contains_key(d)) {
                if let Some(pin) = pin_of(&sub, epoch, &added_for_offer) {
                    if let Some((to, f)) = o.pin(&pin) {
                        // Shown on this machine with a way to undo: a code read off the screen by someone else adds
                        // their device, not the one the person meant.
                        *lock(&self.joined) = Some(to.clone());
                        self.send(vec![(to, f)]);
                    }
                }
                *offer = None;
            }
        }
    }

    /// POST /api/cloud/remove {device}: takes a machine out of the chain (another one, or this one).
    pub fn remove(&self, device: &str) -> Result<(), String> {
        let v = lock(&self.view);
        if v.trust != Trust::Member {
            return Err("not_member".into());
        }
        if !v.state.members.contains_key(device) {
            return Err("unknown_machine".into());
        }
        let me = self.identity.device();
        let body = Body { v: 1, seq: v.state.len as u64, prev: v.state.digest.clone(), op: "remove".into(), device: device.into(), dh: None, signer: me };
        drop(v);
        let text = body.canonical();
        let entry = Entry { sig: self.identity.sign(text.as_bytes()), body: text };
        let _ = self.out.send(Cmd::Text(json!({ "t": "chain.append", "entry": entry })));
        Ok(())
    }

    /// POST /api/cloud/offer: shows a code on this machine (a member) for a new one to type.
    pub fn offer(&self) -> Result<String, String> {
        if lock(&self.view).trust != Trust::Member {
            return Err("not_member".into());
        }
        let o = Offer::new();
        let code = o.code().to_string();
        *lock(&self.offer) = Some(o);
        *lock(&self.joined) = None;
        Ok(code)
    }

    /// POST /api/cloud/join {code}: pairs this machine with whichever member online shows that code.
    pub fn join(&self, code: &str) -> Result<(), String> {
        let v = lock(&self.view);
        if v.trust == Trust::Member {
            return Err("already_member".into());
        }
        // Who to try: the devices the relay's chain lists (unverified; the pairing itself is what's authenticated).
        let listed = chain::verify(&v.seen).map(|s| s.members).unwrap_or_default();
        let targets: Vec<String> = listed.keys().filter(|d| v.online.contains(d)).cloned().collect();
        drop(v);
        if targets.is_empty() {
            return Err("no_member_online".into());
        }
        let (j, frames) = Join::new(&self.identity.device(), code, &targets);
        *lock(&self.join) = Some(j);
        self.join_refused.store(false, Ordering::SeqCst);
        self.send(frames);
        Ok(())
    }

    fn on_pairing(&self, from: &str, f: &[u8]) {
        let me = self.identity.device();
        let member = lock(&self.view).trust == Trust::Member;
        if member {
            let step = match lock(&self.offer).as_mut() {
                Some(o) => o.on_frame(&me, from, f),
                None => MemberStep::Send(from.into(), [&[pairing::REFUSED][..], &f[1..9]].concat()),
            };
            match step {
                MemberStep::Nothing => {}
                MemberStep::Send(to, frame) => self.send(vec![(to, frame)]),
                MemberStep::Add { device, dh } => {
                    let v = lock(&self.view);
                    let body = Body { v: 1, seq: v.state.len as u64, prev: v.state.digest.clone(), op: "add".into(), device, dh: Some(dh), signer: me.clone() };
                    drop(v);
                    let text = body.canonical();
                    let entry = Entry { sig: self.identity.sign(text.as_bytes()), body: text };
                    let _ = self.out.send(Cmd::Text(json!({ "t": "chain.append", "entry": entry })));
                }
            }
            return;
        }
        let step = match lock(&self.join).as_mut() {
            Some(j) if j.live() => j.on_frame(&self.identity.dh(), from, f),
            _ => return,
        };
        match step {
            JoinStep::Send(to, frame) => self.send(vec![(to, frame)]),
            JoinStep::Pinned(pin) => {
                *lock(&self.join) = None;
                let mut v = lock(&self.view);
                let sub = v.sub.clone().unwrap_or_default();
                let seen = v.seen.clone();
                match check_pin(&pin, &sub, v.seen_epoch, &seen) {
                    Ok(state) => {
                        let epoch = v.seen_epoch;
                        self.settle(&mut v, &sub, epoch, state);
                    }
                    Err(e) => self.refuse(&mut v, e),
                }
            }
            JoinStep::Refused => {
                *lock(&self.join) = None;
                self.join_refused.store(true, Ordering::SeqCst);
            }
            JoinStep::Nothing => {}
        }
    }

    fn answer(self: &Arc<Self>, from: String, sid: [u8; 8], msg: Value) {
        {
            let mut busy = lock(&self.busy);
            let n = busy.entry(from.clone()).or_default();
            if *n >= MAX_CALLS_PER_DEVICE {
                drop(busy);
                return self.reply(&from, &sid, &msg, Reply { status: 429, body: json!({ "error": "busy" }) });
            }
            *n += 1;
        }
        let me = Arc::clone(self);
        // A call can take a while (resume drives the terminal): never on the link thread.
        std::thread::spawn(move || {
            let r = match me.hangar.upgrade() {
                None => Reply { status: 503, body: json!({ "error": "stopping" }) },
                Some(h) => {
                    // Noise stops replays, not delays: a call the relay held back (a close of a session resumed
                    // since) is refused once it's older than this, or from too far ahead for clocks that disagree.
                    let age = chrono::Utc::now().timestamp_millis() - msg["at"].as_i64().unwrap_or(0);
                    if age.abs() > MAX_CALL_AGE_MS {
                        Reply { status: 408, body: json!({ "error": "stale_call" }) }
                    } else {
                        h.handle_remote(&from, msg["m"].as_str().unwrap_or(""), msg["p"].as_str().unwrap_or(""), msg["b"].as_str().unwrap_or(""))
                    }
                }
            };
            me.reply(&from, &sid, &msg, r);
            if let Some(n) = lock(&me.busy).get_mut(&from) {
                *n = n.saturating_sub(1);
            }
        });
    }

    fn reply(&self, to: &str, sid: &[u8; 8], call: &Value, r: Reply) {
        let text = json!({ "id": call["id"], "s": r.status, "b": r.body }).to_string();
        if let Ok(frames) = lock(&self.peers).reply(to, sid, text.as_bytes()) {
            self.send(frames);
        }
    }

    pub fn begin_login(&self) -> String {
        self.auth.begin(None)
    }

    pub fn complete_login(&self, callback: &str) -> Result<(), AuthError> {
        let signed = self.auth.complete(callback)?;
        // A recovery sign-in: its id_token (nonce = this socket's challenge) is the relay's proof for the reset.
        if std::mem::take(&mut *lock(&self.recovery)) {
            let id_token = signed.id_token.ok_or_else(|| AuthError::Invalid("id_token".into()))?;
            *lock(&self.asked) = true;
            let _ = self.out.send(Cmd::Text(json!({ "t": "chain.reset", "id_token": id_token })));
        }
        Ok(())
    }

    pub fn sign_out(&self) -> Result<(), AuthError> {
        Self::set_recover(String::new());
        self.auth.sign_out()
    }
}

impl Handler for Cloud {
    fn state(&self, s: LinkState) {
        lock(&self.view).link = s;
    }

    fn ready(&self, sub: &str, nonce: &str, epoch: u64, chain: Vec<Entry>, online: Vec<String>, reset: Option<i64>) {
        {
            let mut v = lock(&self.view);
            v.sub = Some(sub.into());
            v.online = online;
            v.reset_at = reset;
            v.nonce = nonce.into();
        }
        self.on_chain(sub, epoch, chain);
        // A member online while a recovery reset is pending vetoes it: there is a machine left to recover with.
        if reset.is_some() && lock(&self.view).trust == Trust::Member {
            let _ = self.out.send(Cmd::Text(json!({ "t": "chain.veto" })));
        }
    }

    fn control(&self, m: Value) {
        match m["t"].as_str() {
            Some("presence") => lock(&self.view).online = serde_json::from_value(m["online"].clone()).unwrap_or_default(),
            Some("chain") => {
                let entries = serde_json::from_value::<Vec<Entry>>(m["entries"].clone()).unwrap_or_default();
                self.on_entries(m["epoch"].as_u64().unwrap_or(u64::MAX), entries);
            }
            Some(kind @ ("reset.pending" | "reset.claimed")) => {
                let mine = m["by"].as_str() == Some(self.identity.device().as_str());
                let mut v = lock(&self.view);
                v.reset_at = m["at"].as_i64().or(v.reset_at);
                if v.trust == Trust::Member {
                    drop(v);
                    let _ = self.out.send(Cmd::Text(json!({ "t": "chain.veto" })));
                } else if mine && std::mem::take(&mut *lock(&self.asked)) {
                    // Our own request was taken. A pending reset runs into the next epoch; a claimed one is for the
                    // empty chain of the current epoch, recorded as "the epoch before" so both read the same way.
                    let before = if kind == "reset.pending" { v.seen_epoch } else { v.seen_epoch.saturating_sub(1) };
                    Self::set_recover(format!("{}\n{before}", v.sub.clone().unwrap_or_default()));
                    self.root_if_recovering(&mut v);
                }
            }
            Some("error") if *lock(&self.asked) && matches!(m["code"].as_str(), Some("login_required" | "member" | "empty" | "reset_pending" | "reset_soon")) => {
                *lock(&self.asked) = false;
            }
            Some("error") if m["code"] == "root" => {
                // The relay refused our root: the recovery isn't ours (any more).
                Self::set_recover(String::new());
                lock(&self.view).rooting = None;
            }
            Some("reset.vetoed") => {
                lock(&self.view).reset_at = None;
                Self::set_recover(String::new());
            }
            Some("reset") => {
                let mut v = lock(&self.view);
                v.reset_at = None;
                v.seen.clear();
                v.seen_epoch = m["epoch"].as_u64().unwrap_or(u64::MAX);
                // The pinned chain is gone at the relay: refused until paired again, whatever comes next.
                if stored_pin().is_some() {
                    self.refuse(&mut v, "epoch");
                } else {
                    v.trust = Trust::NotPaired;
                }
                self.root_if_recovering(&mut v);
                drop(v);
                lock(&self.peers).retain(&chain::Members::new());
            }
            _ => {}
        }
    }

    fn frame(&self, from: String, payload: Vec<u8>) {
        if pairing::is_frame(&payload) {
            return self.on_pairing(&from, &payload);
        }
        let members = self.members();
        let (out, done) = lock(&self.peers).receive(&members, &from, &payload);
        self.send(out);
        for i in done {
            let Ok(msg) = serde_json::from_slice::<Value>(&i.message) else { continue };
            if i.mine {
                // On the session we started: only a reply, from the device we called, to a call still waiting.
                if let Some(tx) = msg["id"].as_u64().and_then(|id| lock(&self.calls).remove(&(from.clone(), id))) {
                    let _ = tx.send(Reply { status: msg["s"].as_u64().unwrap_or(502) as u16, body: msg["b"].clone() });
                }
            } else if let Some(me) = self.me.upgrade() {
                // On the peer's session: only a call, answered as that device.
                me.answer(from.clone(), i.sid, msg);
            }
        }
    }
}
