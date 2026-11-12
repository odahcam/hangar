use super::chain::Members;
use super::identity::Identity;
use super::peer::{Out, Peers};
use super::secrets::Secrets;
use super::b64;

fn identity() -> Identity {
    let mut k = [[0u8; 32]; 2];
    for x in &mut k {
        getrandom::fill(x).unwrap();
    }
    Identity::from_secrets(&Secrets { ed25519: b64(&k[0]), x25519: b64(&k[1]), refresh: String::new(), pin: String::new(), refresh_sent_at: 0 }).unwrap()
}

struct Node {
    id: Identity,
    peers: Peers,
}

fn node() -> Node {
    let id = identity();
    let peers = Peers::new(id.device(), id.dh_private());
    Node { id, peers }
}

fn members(nodes: &[&Node]) -> Members {
    nodes.iter().map(|n| (n.id.device(), n.id.dh())).collect()
}

/// Delivers frames as the relay would (stamping the sender) until nothing is left; returns what each side received.
fn pump(a: &mut Node, b: &mut Node, m: &Members, frames: Vec<(String, Out)>) -> Vec<(String, [u8; 8], Vec<u8>)> {
    let mut got = vec![];
    // In order, as the relay delivers them.
    let mut frames: std::collections::VecDeque<_> = frames.into();
    while let Some((from, (to, f))) = frames.pop_front() {
        let n = if to == a.id.device() { &mut *a } else { &mut *b };
        let (out, done) = n.peers.receive(m, &from, &f);
        let me = n.id.device();
        got.extend(done.into_iter().map(|(sid, p)| (me.clone(), sid, p)));
        frames.extend(out.into_iter().map(|o| (me.clone(), o)));
    }
    got
}

#[test]
fn a_request_and_its_reply_cross_end_to_end() {
    let (mut a, mut b) = (node(), node());
    let m = members(&[&a, &b]);
    let (da, db_) = (a.id.device(), b.id.device());
    let out = a.peers.send(&m, &db_, b"GET /api/sessions").unwrap();
    let got = pump(&mut a, &mut b, &m, out.into_iter().map(|o| (da.clone(), o)).collect());
    assert_eq!(got.len(), 1);
    let (who, sid, req) = &got[0];
    assert_eq!((who, req.as_slice()), (&db_, &b"GET /api/sessions"[..]));
    // A reply bigger than one Noise message comes back whole, on the same session.
    let big: Vec<u8> = (0..300_000u32).map(|i| i as u8).collect();
    let out = b.peers.reply(&da, sid, &big).unwrap();
    assert!(out.len() > 4);
    let got = pump(&mut a, &mut b, &m, out.into_iter().map(|o| (db_.clone(), o)).collect());
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].2, big);
}

#[test]
fn a_replayed_frame_ends_the_session_and_the_next_send_handshakes_again() {
    let (mut a, mut b) = (node(), node());
    let m = members(&[&a, &b]);
    let (da, db_) = (a.id.device(), b.id.device());
    let out = a.peers.send(&m, &db_, b"one").unwrap();
    pump(&mut a, &mut b, &m, out.into_iter().map(|o| (da.clone(), o)).collect());
    let data = a.peers.send(&m, &db_, b"two").unwrap();
    let frame = data[0].1.clone();
    assert_eq!(pump(&mut a, &mut b, &m, vec![(da.clone(), data[0].clone())]).len(), 1);
    // The relay sends the same frame again: refused, and the session is reset on both sides.
    let got = pump(&mut a, &mut b, &m, vec![(da.clone(), (db_.clone(), frame))]);
    assert!(got.is_empty());
    let out = a.peers.send(&m, &db_, b"three").unwrap();
    assert_eq!(out[0].1[0], 1, "a new handshake");
    let got = pump(&mut a, &mut b, &m, out.into_iter().map(|o| (da.clone(), o)).collect());
    assert_eq!(got[0].2, b"three");
}

#[test]
fn frames_stamped_with_another_device_or_from_outside_the_chain_go_nowhere() {
    let (mut a, mut b, c) = (node(), node(), node());
    let m = members(&[&a, &b, &c]);
    let (da, db_, dc) = (a.id.device(), b.id.device(), c.id.device());
    let out = a.peers.send(&m, &db_, b"hi").unwrap();
    // The relay claims c sent a's handshake: the prologue and c's static key don't match, nothing comes of it.
    let got = pump(&mut a, &mut b, &m, out.iter().map(|o| (dc.clone(), o.clone())).collect());
    assert!(got.is_empty());
    // b no longer counts a as a member: a's frames are dropped before any crypto.
    let without_a = members(&[&b, &c]);
    let (replies, done) = b.peers.receive(&without_a, &da, &out[0].1);
    assert!(replies.is_empty() && done.is_empty());
    // And a can't open a session to a device outside the chain.
    assert_eq!(a.peers.send(&members(&[&a]), &db_, b"x").unwrap_err(), "not_member");
}
