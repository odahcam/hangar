use super::chain::Pin;
use super::pairing::{normalize, is_frame, Join, JoinStep, MemberStep, Offer, CODE_LEN};

const MEMBER: &str = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMA";
const NEW: &str = "NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNA";
const NEW_DH: &str = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA";

fn pin() -> Pin {
    Pin { sub: "user-1".into(), epoch: 0, root: MEMBER.into(), len: 2, digest: "d".into() }
}

/// Runs the exchange as the relay would, stamping senders; returns what the new machine ended with.
fn run(offer: &mut Offer, code: &str) -> Option<JoinStep> {
    let (mut join, out) = Join::new(NEW, code, &[MEMBER.to_string()]);
    let mut to_member: Vec<Vec<u8>> = out.into_iter().map(|(_, f)| f).collect();
    while let Some(f) = to_member.pop() {
        assert!(is_frame(&f) && f.len() < 4096);
        let back = match offer.on_frame(MEMBER, NEW, &f) {
            MemberStep::Nothing => continue,
            MemberStep::Send(_, b) => b,
            MemberStep::Add { device, dh } => {
                assert_eq!((device.as_str(), dh.as_str()), (NEW, NEW_DH));
                offer.pin(&pin()).unwrap().1
            }
        };
        match join.on_frame(NEW_DH, MEMBER, &back) {
            JoinStep::Send(_, f) => to_member.push(f),
            JoinStep::Nothing => {}
            done => return Some(done),
        }
    }
    None
}

#[test]
fn the_right_code_adds_the_machine_and_hands_it_the_pin() {
    let mut offer = Offer::new();
    assert_eq!(offer.code().len(), CODE_LEN);
    let typed = format!(" {}-{} ", &offer.code()[..3].to_lowercase(), &offer.code()[3..]);
    match run(&mut offer, &typed) {
        Some(JoinStep::Pinned(p)) => assert_eq!(p, pin()),
        _ => panic!("not pinned"),
    }
    assert!(!offer.live(), "a code adds one machine");
}

#[test]
fn wrong_codes_are_refused_and_the_code_dies_after_three() {
    let mut offer = Offer::new();
    let wrong = if offer.code() == "000000" { "111111" } else { "000000" };
    for _ in 0..3 {
        assert!(matches!(run(&mut offer, wrong), Some(JoinStep::Refused)));
    }
    assert!(!offer.live());
    let right = offer.code().to_string();
    assert!(matches!(run(&mut offer, &right), Some(JoinStep::Refused)), "even the right code, once dead");
}

#[test]
fn a_pin_from_another_device_than_the_one_paired_with_is_ignored() {
    let mut offer = Offer::new();
    let code = offer.code().to_string();
    let (mut join, out) = Join::new(NEW, &code, &[MEMBER.to_string()]);
    let MemberStep::Send(_, answer) = offer.on_frame(MEMBER, NEW, &out[0].1) else { panic!() };
    // The relay delivers the member's answer as if another device sent it.
    assert!(matches!(join.on_frame(NEW_DH, "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXA", &answer), JoinStep::Nothing));
}

#[test]
fn codes_read_forgivingly() {
    assert_eq!(normalize("ab-c o1l "), "ABC011");
}
