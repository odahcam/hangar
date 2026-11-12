use super::chain::{self, check_pin, pin_of, verify, Entry};
use super::identity::Identity;
use super::secrets::Secrets;
use super::b64;
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Deserialize)]
struct Case {
    entries: Vec<Entry>,
    error: Option<String>,
    members: Option<Vec<String>>,
}

/// The cases the relay judges too (cloud/test/chain.test.ts): both sides must agree on every one.
#[test]
fn shared_chain_cases() {
    let cases: BTreeMap<String, Case> = serde_json::from_str(include_str!("../../../cloud/test/fixtures/chain.json")).unwrap();
    for (name, c) in cases {
        match (verify(&c.entries), c.error) {
            (Ok(state), None) => {
                if let Some(m) = c.members {
                    assert_eq!(state.members.keys().cloned().collect::<Vec<_>>(), m, "{name}");
                }
            }
            (Err(got), Some(want)) => assert_eq!(got, want, "{name}"),
            (got, want) => panic!("{name}: got {got:?}, want {want:?}"),
        }
    }
}

fn identity() -> Identity {
    Identity::from_secrets(&Secrets { ed25519: b64(&rand32()), x25519: b64(&rand32()), refresh: String::new() }).unwrap()
}

fn rand32() -> [u8; 32] {
    let mut k = [0u8; 32];
    getrandom::fill(&mut k).unwrap();
    k
}

fn entry(signer: &Identity, body: chain::Body) -> Entry {
    let text = body.canonical();
    Entry { sig: signer.sign(text.as_bytes()), body: text }
}

fn body(seq: u64, prev: &str, op: &str, device: &Identity, signer: &Identity) -> chain::Body {
    chain::Body { v: 1, seq, prev: prev.into(), op: op.into(), device: device.device(), dh: (op != "remove").then(|| device.dh()), signer: signer.device() }
}

#[test]
fn identity_signs_what_the_chain_verifies() {
    let a = identity();
    let root = entry(&a, body(0, "", "root", &a, &a));
    let s = verify(std::slice::from_ref(&root)).unwrap();
    assert_eq!(s.root.as_deref(), Some(a.device().as_str()));
    assert_eq!(s.members.get(&a.device()), Some(&a.dh()));
    assert!(chain::verify_sig(&a.device(), &a.prove("sub", "nonce"), b"hangar-relay-v1\nsub\nnonce"));
}

#[test]
fn the_pin_refuses_rollback_rewritten_history_and_a_new_epoch() {
    let (a, b, c) = (identity(), identity(), identity());
    let root = entry(&a, body(0, "", "root", &a, &a));
    let add_b = entry(&a, body(1, &chain::digest(&root.body), "add", &b, &a));
    let remove_b = entry(&a, body(2, &chain::digest(&add_b.body), "remove", &b, &a));
    let full = vec![root.clone(), add_b.clone(), remove_b.clone()];
    let pin = pin_of(0, &verify(&full).unwrap()).unwrap();

    // Extending is fine; dropping the remove would bring b back.
    let add_c = entry(&a, body(3, &chain::digest(&remove_b.body), "add", &c, &a));
    assert!(check_pin(&pin, 0, &[full.clone(), vec![add_c]].concat()).is_ok());
    assert_eq!(check_pin(&pin, 0, &full[..2]).unwrap_err(), "rollback");
    assert_eq!(check_pin(&pin, 1, &full).unwrap_err(), "epoch");

    // Same length, different history: another root.
    let root2 = entry(&c, body(0, "", "root", &c, &c));
    let add_a = entry(&c, body(1, &chain::digest(&root2.body), "add", &a, &c));
    let add_b2 = entry(&c, body(2, &chain::digest(&add_a.body), "add", &b, &c));
    assert_eq!(check_pin(&pin, 0, &[root2, add_a, add_b2]).unwrap_err(), "history");
}
