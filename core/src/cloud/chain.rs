// The account's device chain, as every Hangar verifies it: the same rules and the same canonical text as the relay
// (cloud/src/chain.ts), plus the local pin. The relay checks the chain too, but a Hangar trusts only what it verifies
// itself against the root and length it pinned when it was paired.
use super::{b64, unb64};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MAX_MEMBERS: usize = 32;
pub const MAX_ENTRIES: usize = 256;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub body: String,
    pub sig: String,
}

/// Field order is the canonical order; serde_json writes struct fields in declaration order.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Body {
    pub v: u8,
    pub seq: u64,
    pub prev: String,
    pub op: String,
    pub device: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dh: Option<String>,
    pub signer: String,
}

impl Body {
    pub fn canonical(&self) -> String {
        serde_json::to_string(self).expect("plain struct")
    }
}

/// Device key → Noise key, after some entries.
pub type Members = BTreeMap<String, String>;

pub fn digest(body: &str) -> String {
    b64(&Sha256::digest(body.as_bytes()))
}

pub fn is_key(s: &str) -> bool {
    s.len() == 43 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') && unb64(s).is_some_and(|k| k.len() == 32)
}

pub fn verify_sig(public: &str, sig: &str, data: &[u8]) -> bool {
    let (Some(k), Some(s)) = (unb64(public), unb64(sig)) else { return false };
    let (Ok(k), Ok(s)) = (<[u8; 32]>::try_from(k.as_slice()), <[u8; 64]>::try_from(s.as_slice())) else { return false };
    let Ok(key) = VerifyingKey::from_bytes(&k) else { return false };
    key.verify_strict(data, &Signature::from_bytes(&s)).is_ok()
}

fn parse(body: &str) -> Option<Body> {
    if body.len() > 1024 {
        return None;
    }
    let b: Body = serde_json::from_str(body).ok()?;
    let shape = b.v == 1 && is_key(&b.device) && is_key(&b.signer) && matches!(b.op.as_str(), "root" | "add" | "remove") && (b.op == "remove") == b.dh.is_none() && b.dh.as_deref().is_none_or(is_key);
    // Only the canonical text: the relay (JavaScript's JSON.parse) and this parser must never disagree on what was signed.
    (shape && b.canonical() == body).then_some(b)
}

/// The chain after verifying every entry from the start: members, length and the last body's digest.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct State {
    pub members: Members,
    pub len: usize,
    pub digest: String,
    /// The root device, once there is one.
    pub root: Option<String>,
}

pub fn append(state: &State, e: &Entry) -> Result<State, &'static str> {
    let b = parse(&e.body).ok_or("malformed")?;
    if b.seq != state.len as u64 {
        return Err("seq");
    }
    if b.op == "add" && state.len >= MAX_ENTRIES {
        return Err("full");
    }
    if b.prev != state.digest {
        return Err("prev");
    }
    if b.op == "root" {
        if state.len != 0 || b.signer != b.device || !b.prev.is_empty() {
            return Err("root");
        }
    } else if state.len == 0 {
        return Err("root");
    } else if !state.members.contains_key(&b.signer) {
        return Err("signer");
    }
    if b.op == "add" && state.members.contains_key(&b.device) {
        return Err("member");
    }
    if b.op == "add" && state.members.len() >= MAX_MEMBERS {
        return Err("full");
    }
    if b.op == "remove" && !state.members.contains_key(&b.device) {
        return Err("not_member");
    }
    if !verify_sig(&b.signer, &e.sig, e.body.as_bytes()) {
        return Err("sig");
    }
    let mut next = state.clone();
    match b.dh {
        None => {
            next.members.remove(&b.device);
        }
        Some(dh) => {
            next.members.insert(b.device.clone(), dh);
        }
    }
    if b.op == "root" {
        next.root = Some(b.device);
    }
    next.len += 1;
    next.digest = digest(&e.body);
    Ok(next)
}

pub fn verify(entries: &[Entry]) -> Result<State, &'static str> {
    entries.iter().try_fold(State::default(), |s, e| append(&s, e))
}

/// What a Hangar pinned of the chain the last time it accepted it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Pin {
    /// The account the chain belongs to: signing in with another one is a change of account, not tampering.
    pub sub: String,
    pub epoch: u64,
    pub root: String,
    pub len: usize,
    pub digest: String,
}

/// Accepts the relay's chain only if it extends the pinned one: same epoch, same root, no shorter, and the entry at
/// the pinned length still hashes to the pinned digest. Anything else (a reset, a rewritten history, a rollback that
/// would resurrect a removed device) is refused until the person pairs this machine again.
pub fn check_pin(pin: &Pin, sub: &str, epoch: u64, entries: &[Entry]) -> Result<State, &'static str> {
    if sub != pin.sub {
        return Err("account");
    }
    if epoch != pin.epoch {
        return Err("epoch");
    }
    if entries.len() < pin.len {
        return Err("rollback");
    }
    let prefix = verify(&entries[..pin.len])?;
    if prefix.digest != pin.digest || prefix.root.as_deref() != Some(pin.root.as_str()) {
        return Err("history");
    }
    entries[pin.len..].iter().try_fold(prefix, |s, e| append(&s, e))
}

pub fn pin_of(sub: &str, epoch: u64, state: &State) -> Option<Pin> {
    Some(Pin { sub: sub.into(), epoch, root: state.root.clone()?, len: state.len, digest: state.digest.clone() })
}
