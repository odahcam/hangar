// Remote control over the internet: this machine's device identity, the account's device chain, and (in the modules
// that follow) the session with auth.odahcam.com and the relay at hangar.odahcam.com.
pub mod chain;
pub mod identity;
pub mod link;
pub mod oauth;
pub mod peer;
pub mod secrets;
pub mod service;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;

pub(crate) fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn unb64(s: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).ok()
}

#[cfg(test)]
mod oauth_tests;
#[cfg(test)]
mod peer_tests;
#[cfg(test)]
mod tests;
