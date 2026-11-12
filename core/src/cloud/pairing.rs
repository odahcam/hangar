// Adding a machine to the account's device chain. A member shows a short code ("Add a machine"); the person types it
// on the new machine. The two run SPAKE2 over the relay with that code as the password and both device keys as the
// identities (the relay stamps who sent each frame), so the relay can't sit in the middle without guessing the code,
// and the member allows only a few wrong tries per code. Over the key that comes out, the new machine sends its Noise
// key, the member adds it to the chain, and answers with the pin of the chain that now includes it: the new machine
// trusts the relay's chain only if it matches that pin, never because the relay sent it.
//
// Frames (kind ‖ 8-byte pairing id ‖ body), all well under the relay's 4 KiB limit for non-members:
//   20  new → member   SPAKE2 message of side B
//   21  member → new   SPAKE2 message of side A
//   22  new → member   AEAD(k, nonce 0): {"dh": <X25519 key>}               proves the code, carries the Noise key
//   23  member → new   AEAD(k, nonce 1): {"pin": Pin}                       after the add is in the chain
//   24  either way     refused (wrong code, expired, too many tries); unauthenticated, so only ever a hint
use super::chain::Pin;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spake2::{Ed25519Group, Identity as SpakeId, Password, Spake2};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

pub const START: u8 = 20;
pub const ANSWER: u8 = 21;
pub const PROOF: u8 = 22;
pub const PIN: u8 = 23;
pub const REFUSED: u8 = 24;

/// Crockford's base32 without I, L, O, U: 6 characters = 30 bits.
const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
pub const CODE_LEN: usize = 6;
const CODE_TTL: Duration = Duration::from_secs(300);
/// Wrong tries a code survives; with 30 bits, guessing it online is out of reach.
const MAX_TRIES: u32 = 3;
/// A try's proof follows its SPAKE2 answer within this, or the try is dropped.
const PROOF_WITHIN: Duration = Duration::from_secs(15);
const AD: &[u8] = b"hangar-pair-v1";

pub fn is_frame(f: &[u8]) -> bool {
    f.len() >= 9 && (START..=REFUSED).contains(&f[0])
}

fn frame(kind: u8, id: &[u8; 8], body: &[u8]) -> Vec<u8> {
    [&[kind][..], id, body].concat()
}

/// The code as typed: case, spaces and dashes don't matter, and O/I/L read as 0/1/1.
pub fn normalize(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c.to_ascii_uppercase() {
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        })
        .collect()
}

fn new_code() -> Zeroizing<String> {
    let mut b = [0u8; CODE_LEN];
    getrandom::fill(&mut b).expect("OS random source");
    Zeroizing::new(b.iter().map(|x| ALPHABET[(*x & 31) as usize] as char).collect())
}

fn aead(key: &[u8]) -> ChaCha20Poly1305 {
    let hash = Sha256::new().chain_update(b"hangar-pair-key-v1").chain_update(key).finalize();
    let k = Zeroizing::new(<[u8; 32]>::try_from(hash.as_slice()).expect("SHA-256 is 32 bytes"));
    ChaCha20Poly1305::new(Key::from_slice(k.as_ref()))
}

fn nonce(n: u8) -> Nonce {
    let mut b = [0u8; 12];
    b[11] = n;
    *Nonce::from_slice(&b)
}

fn ids(member: &str, new: &str) -> (SpakeId, SpakeId) {
    (SpakeId::new(member.as_bytes()), SpakeId::new(new.as_bytes()))
}

/// The member's side: one code at a time.
pub struct Offer {
    code: Zeroizing<String>,
    shown: Instant,
    tries: u32,
    /// Pairings in flight, by (new device, id): the key once SPAKE2 is done, and since when.
    keys: HashMap<(String, [u8; 8]), (Zeroizing<Vec<u8>>, Instant)>,
    /// The device being added and its Noise key, once its proof checked out.
    pub accepted: Option<(String, String, [u8; 8])>,
}

/// What the member's side wants done after a frame.
pub enum MemberStep {
    Nothing,
    Send(String, Vec<u8>),
    /// The new device proved the code: add (device, dh) to the chain, then call `pin()`.
    Add { device: String, dh: String },
}

impl Offer {
    pub fn new() -> Offer {
        Offer { code: new_code(), shown: Instant::now(), tries: 0, keys: HashMap::new(), accepted: None }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn live(&self) -> bool {
        self.shown.elapsed() < CODE_TTL && self.tries < MAX_TRIES && self.accepted.is_none()
    }

    pub fn on_frame(&mut self, me: &str, from: &str, f: &[u8]) -> MemberStep {
        let (kind, id, body) = (f[0], <[u8; 8]>::try_from(&f[1..9]).expect("is_frame"), &f[9..]);
        let refuse = || MemberStep::Send(from.to_string(), frame(REFUSED, &id, &[]));
        if !self.live() {
            return if kind == START || kind == PROOF { refuse() } else { MemberStep::Nothing };
        }
        match kind {
            START => {
                // A try that didn't send its proof in time is dropped, and each device has one try in flight: a
                // guest can't fill the slots and keep the right machine out until the code expires.
                self.keys.retain(|(d, _), (_, at)| at.elapsed() < PROOF_WITHIN && d != from);
                if self.keys.len() >= 4 {
                    return refuse();
                }
                let (a, b) = ids(me, from);
                let (state, msg) = Spake2::<Ed25519Group>::start_a(&Password::new(self.code.as_bytes()), &a, &b);
                let Ok(key) = state.finish(body) else { return refuse() };
                self.keys.insert((from.to_string(), id), (Zeroizing::new(key), Instant::now()));
                MemberStep::Send(from.to_string(), frame(ANSWER, &id, &msg))
            }
            PROOF => {
                let Some((key, at)) = self.keys.remove(&(from.to_string(), id)) else { return refuse() };
                if at.elapsed() >= PROOF_WITHIN {
                    return refuse();
                }
                let opened = aead(&key).decrypt(&nonce(0), Payload { msg: body, aad: AD });
                let dh = opened.ok().and_then(|p| serde_json::from_slice::<Value>(&p).ok()).and_then(|v| v["dh"].as_str().map(String::from));
                match dh.filter(|d| super::chain::is_key(d)) {
                    Some(dh) => {
                        self.keys.insert((from.to_string(), id), (key, Instant::now()));
                        self.accepted = Some((from.to_string(), dh.clone(), id));
                        MemberStep::Add { device: from.to_string(), dh }
                    }
                    // A wrong code gives a different key: the proof doesn't open.
                    None => {
                        self.tries += 1;
                        refuse()
                    }
                }
            }
            _ => MemberStep::Nothing,
        }
    }

    /// After the add is in the chain: the pin for the new device, sealed with the pairing key.
    pub fn pin(&mut self, pin: &Pin) -> Option<(String, Vec<u8>)> {
        let (device, _, id) = self.accepted.clone()?;
        let (key, _) = self.keys.remove(&(device.clone(), id))?;
        let sealed = aead(&key).encrypt(&nonce(1), Payload { msg: json!({ "pin": pin }).to_string().as_bytes(), aad: AD }).ok()?;
        Some((device, frame(PIN, &id, &sealed)))
    }
}

impl Default for Offer {
    fn default() -> Self {
        Offer::new()
    }
}

/// The new machine's side: the code typed, tried with each member online.
pub struct Join {
    code: Zeroizing<String>,
    started: Instant,
    /// SPAKE2 state per member tried, by pairing id.
    tries: HashMap<[u8; 8], (String, Spake2<Ed25519Group>)>,
    keys: HashMap<[u8; 8], (String, Zeroizing<Vec<u8>>)>,
}

pub enum JoinStep {
    Nothing,
    Send(String, Vec<u8>),
    /// The pin the member sent over the authenticated channel: check the relay's chain against it.
    Pinned(Pin),
    Refused,
}

impl Join {
    /// Starts with every member currently online; returns the frames to send.
    pub fn new(me: &str, code: &str, members: &[String]) -> (Join, Vec<(String, Vec<u8>)>) {
        let code = Zeroizing::new(normalize(code));
        let mut j = Join { code, started: Instant::now(), tries: HashMap::new(), keys: HashMap::new() };
        let mut out = vec![];
        for m in members {
            let mut id = [0u8; 8];
            getrandom::fill(&mut id).expect("OS random source");
            let (a, b) = ids(m, me);
            let (state, msg) = Spake2::<Ed25519Group>::start_b(&Password::new(j.code.as_bytes()), &a, &b);
            j.tries.insert(id, (m.clone(), state));
            out.push((m.clone(), frame(START, &id, &msg)));
        }
        (j, out)
    }

    pub fn live(&self) -> bool {
        self.started.elapsed() < CODE_TTL
    }

    pub fn on_frame(&mut self, my_dh: &str, from: &str, f: &[u8]) -> JoinStep {
        let (kind, id, body) = (f[0], <[u8; 8]>::try_from(&f[1..9]).expect("is_frame"), &f[9..]);
        match kind {
            ANSWER => {
                let Some((member, state)) = self.tries.remove(&id) else { return JoinStep::Nothing };
                // The answer must come from the member this try went to.
                if member != from {
                    return JoinStep::Nothing;
                }
                let Ok(key) = state.finish(body) else { return JoinStep::Nothing };
                let Ok(sealed) = aead(&key).encrypt(&nonce(0), Payload { msg: json!({ "dh": my_dh }).to_string().as_bytes(), aad: AD }) else { return JoinStep::Nothing };
                self.keys.insert(id, (member, Zeroizing::new(key)));
                JoinStep::Send(from.to_string(), frame(PROOF, &id, &sealed))
            }
            PIN => {
                let Some((member, key)) = self.keys.get(&id) else { return JoinStep::Nothing };
                if member != from {
                    return JoinStep::Nothing;
                }
                let opened = aead(key).decrypt(&nonce(1), Payload { msg: body, aad: AD });
                match opened.ok().and_then(|p| serde_json::from_slice::<Value>(&p).ok()).and_then(|v| serde_json::from_value::<Pin>(v["pin"].clone()).ok()) {
                    Some(pin) => JoinStep::Pinned(pin),
                    None => JoinStep::Nothing,
                }
            }
            // Unauthenticated: it only counts once no member is left to try.
            REFUSED => {
                self.tries.remove(&id);
                self.keys.remove(&id);
                if self.tries.is_empty() && self.keys.is_empty() { JoinStep::Refused } else { JoinStep::Nothing }
            }
            _ => JoinStep::Nothing,
        }
    }
}
