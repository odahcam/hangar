// End-to-end sessions between the account's machines, carried over the relay as opaque frames. Noise KK: both sides
// already know each other's static X25519 key from the device chain, the handshake adds ephemeral keys (forward
// secrecy), and the prologue names both Ed25519 device keys, so a session is bound to the two devices the chain says
// own those keys. Transport messages use Noise's implicit counters: a frame the relay replays, drops or reorders fails
// to decrypt and ends the session, and the initiator starts a new one. Nothing is sent in handshake payloads, so no
// request is ever replayable.
//
// Frame:   kind (1 byte) ‖ session id (8 bytes) ‖ Noise message
// kinds:   1 handshake from the initiator, 2 handshake reply, 3 transport, 4 reset (unauthenticated: "I don't know this
//          session"; at worst the relay forces a new handshake)
// A transport message's plaintext starts with a byte saying whether more chunks of the same message follow: Noise
// messages stop at 64 KiB, a session list doesn't.
use super::chain::Members;
use super::unb64;
use snow::{HandshakeState, TransportState};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

const PATTERN: &str = "Noise_KK_25519_ChaChaPoly_BLAKE2s";
const MAX_NOISE: usize = 65535;
const CHUNK: usize = MAX_NOISE - 16 - 1;
/// A reassembled message can't grow past this.
pub const MAX_MESSAGE: usize = 8 * 1024 * 1024;
/// Sessions are replaced after this long, so no key lives for days.
const SESSION_TTL: Duration = Duration::from_secs(3600);

const HANDSHAKE: u8 = 1;
const REPLY: u8 = 2;
const DATA: u8 = 3;
const RESET: u8 = 4;

/// A frame for the relay: recipient device and payload.
pub type Out = (String, Vec<u8>);

enum State {
    /// We sent the first handshake message; plaintexts wait for the reply.
    Initiating(Box<HandshakeState>, Vec<Vec<u8>>),
    Ready(Box<TransportState>),
}

struct Session {
    state: State,
    started: Instant,
    /// Chunks of the message being received.
    partial: Vec<u8>,
}

pub struct Peers {
    me: String,
    dh_private: Zeroizing<[u8; 32]>,
    /// Keyed by (peer device, session id). Each side initiates its own session to the other.
    sessions: HashMap<(String, [u8; 8]), Session>,
    /// The session we initiated to each peer.
    mine: HashMap<String, [u8; 8]>,
}

fn prologue(initiator: &str, responder: &str) -> Vec<u8> {
    format!("hangar-noise-v1\n{initiator}\n{responder}").into_bytes()
}

fn builder<'a>(private: &'a [u8], remote: &'a [u8], prologue: &'a [u8]) -> Result<snow::Builder<'a>, snow::Error> {
    snow::Builder::new(PATTERN.parse()?).local_private_key(private)?.remote_public_key(remote)?.prologue(prologue)
}

fn frame(kind: u8, sid: &[u8; 8], body: &[u8]) -> Vec<u8> {
    let mut f = Vec::with_capacity(9 + body.len());
    f.push(kind);
    f.extend_from_slice(sid);
    f.extend_from_slice(body);
    f
}

impl Peers {
    pub fn new(me: String, dh_private: &[u8; 32]) -> Peers {
        Peers { me, dh_private: Zeroizing::new(*dh_private), sessions: HashMap::new(), mine: HashMap::new() }
    }

    /// Drops every session with a device that is no longer a member.
    pub fn retain(&mut self, members: &Members) {
        self.sessions.retain(|(peer, _), _| members.contains_key(peer));
        self.mine.retain(|peer, _| members.contains_key(peer));
    }

    /// Encrypts `plaintext` for `peer`, starting a session first when there is none (or it expired).
    pub fn send(&mut self, members: &Members, peer: &str, plaintext: &[u8]) -> Result<Vec<Out>, String> {
        if plaintext.len() > MAX_MESSAGE {
            return Err("too_big".into());
        }
        let remote = members.get(peer).and_then(|dh| unb64(dh)).ok_or("not_member")?;
        let sid = self.mine.get(peer).copied().filter(|sid| self.sessions.get(&(peer.to_string(), *sid)).is_some_and(|s| s.started.elapsed() < SESSION_TTL));
        let Some(sid) = sid else {
            let mut sid = [0u8; 8];
            getrandom::fill(&mut sid).map_err(|e| e.to_string())?;
            let p = prologue(&self.me, peer);
            let mut hs = builder(self.dh_private.as_ref(), &remote, &p).and_then(|b| b.build_initiator()).map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; MAX_NOISE];
            let n = hs.write_message(&[], &mut buf).map_err(|e| e.to_string())?;
            self.sessions.insert((peer.to_string(), sid), Session { state: State::Initiating(Box::new(hs), vec![plaintext.to_vec()]), started: Instant::now(), partial: vec![] });
            self.mine.insert(peer.to_string(), sid);
            return Ok(vec![(peer.to_string(), frame(HANDSHAKE, &sid, &buf[..n]))]);
        };
        let s = self.sessions.get_mut(&(peer.to_string(), sid)).expect("checked");
        match &mut s.state {
            State::Initiating(_, queue) => {
                queue.push(plaintext.to_vec());
                Ok(vec![])
            }
            State::Ready(ts) => encrypt(ts, peer, &sid, plaintext),
        }
    }

    /// Replies on the session a message came in on (the peer's, or ours).
    pub fn reply(&mut self, peer: &str, sid: &[u8; 8], plaintext: &[u8]) -> Result<Vec<Out>, String> {
        let s = self.sessions.get_mut(&(peer.to_string(), *sid)).ok_or("no_session")?;
        match &mut s.state {
            State::Ready(ts) => encrypt(ts, peer, sid, plaintext),
            State::Initiating(..) => Err("no_session".into()),
        }
    }

    /// Takes a frame from `from` (stamped by the relay). Returns frames to send back and complete plaintexts with the
    /// session they came on. Frames from devices outside the chain are dropped before any crypto.
    pub fn receive(&mut self, members: &Members, from: &str, f: &[u8]) -> (Vec<Out>, Vec<([u8; 8], Vec<u8>)>) {
        let (mut out, mut done) = (vec![], vec![]);
        let Some(remote) = members.get(from).and_then(|dh| unb64(dh)) else { return (out, done) };
        if f.len() < 9 {
            return (out, done);
        }
        let (kind, sid, body) = (f[0], <[u8; 8]>::try_from(&f[1..9]).expect("9 bytes"), &f[9..]);
        let key = (from.to_string(), sid);
        let mut buf = vec![0u8; MAX_NOISE];
        match kind {
            HANDSHAKE => {
                // A new session from the peer (a repeat of an old first message just makes an orphan reply).
                let p = prologue(from, &self.me);
                let Ok(mut hs) = builder(self.dh_private.as_ref(), &remote, &p).and_then(|b| b.build_responder()) else { return (out, done) };
                if hs.read_message(body, &mut buf).is_err() {
                    return (out, done);
                }
                let Ok(n) = hs.write_message(&[], &mut buf) else { return (out, done) };
                let Ok(ts) = hs.into_transport_mode() else { return (out, done) };
                // At most one live session the peer started: the newest.
                self.sessions.retain(|(p, s), _| !(p == from && Some(s) != self.mine.get(from)));
                self.sessions.insert(key, Session { state: State::Ready(Box::new(ts)), started: Instant::now(), partial: vec![] });
                out.push((from.to_string(), frame(REPLY, &sid, &buf[..n])));
            }
            REPLY => {
                let Some(s) = self.sessions.remove(&key) else { return (out, done) };
                let State::Initiating(mut hs, queue) = s.state else {
                    self.sessions.insert(key, s);
                    return (out, done);
                };
                if hs.read_message(body, &mut buf).is_err() {
                    return (out, done);
                }
                let Ok(mut ts) = hs.into_transport_mode() else { return (out, done) };
                for q in queue {
                    out.extend(encrypt(&mut ts, from, &sid, &q).unwrap_or_default());
                }
                self.sessions.insert(key, Session { state: State::Ready(Box::new(ts)), started: s.started, partial: vec![] });
            }
            DATA => {
                let Some(s) = self.sessions.get_mut(&key) else {
                    out.push((from.to_string(), frame(RESET, &sid, &[])));
                    return (out, done);
                };
                let State::Ready(ts) = &mut s.state else { return (out, done) };
                let ok = ts.read_message(body, &mut buf).ok().filter(|&n| n >= 1).map(|n| (buf[0], buf[1..n].to_vec()));
                match ok {
                    Some((more, chunk)) if s.partial.len() + chunk.len() <= MAX_MESSAGE => {
                        s.partial.extend_from_slice(&chunk);
                        if more == 0 {
                            done.push((sid, std::mem::take(&mut s.partial)));
                        }
                    }
                    // Undecryptable (replayed, reordered, forged) or oversized: the session is over.
                    _ => {
                        self.sessions.remove(&key);
                        if self.mine.get(from) == Some(&sid) {
                            self.mine.remove(from);
                        }
                        out.push((from.to_string(), frame(RESET, &sid, &[])));
                    }
                }
            }
            RESET => {
                // Only for a session we started: the next send handshakes again.
                if self.mine.get(from) == Some(&sid) {
                    self.mine.remove(from);
                    self.sessions.remove(&key);
                }
            }
            _ => {}
        }
        (out, done)
    }
}

fn encrypt(ts: &mut TransportState, peer: &str, sid: &[u8; 8], plaintext: &[u8]) -> Result<Vec<Out>, String> {
    let mut out = vec![];
    let mut buf = vec![0u8; MAX_NOISE];
    let chunks: Vec<&[u8]> = if plaintext.is_empty() { vec![&[][..]] } else { plaintext.chunks(CHUNK).collect() };
    let last = chunks.len() - 1;
    for (i, c) in chunks.into_iter().enumerate() {
        let mut p = Vec::with_capacity(c.len() + 1);
        p.push(u8::from(i != last));
        p.extend_from_slice(c);
        let n = ts.write_message(&p, &mut buf).map_err(|e| e.to_string())?;
        out.push((peer.to_string(), frame(DATA, sid, &buf[..n])));
    }
    Ok(out)
}
