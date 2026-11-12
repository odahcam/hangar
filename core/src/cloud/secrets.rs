// The device's secrets: its Ed25519 identity seed, its X25519 Noise key and the account's refresh token, kept together
// in one item of the OS credential store (Keychain on macOS, Credential Manager on Windows). One item means one
// "allow" prompt after an update re-signs the app, not three. The Keychain item is created by Hangar, so its ACL
// trusts only Hangar's code signature; other processes of the user get a prompt instead of a silent read.
//
// HANGAR_SECRETS_DIR swaps the store for a plain file in that folder: tests only, never set by the app.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use zeroize::{Zeroize, ZeroizeOnDrop};

const SERVICE: &str = "com.odahcam.hangar";
const ITEM: &str = "cloud";

#[derive(Serialize, Deserialize, Default, Clone, Zeroize, ZeroizeOnDrop)]
pub struct Secrets {
    /// Ed25519 seed, base64url.
    pub ed25519: String,
    /// X25519 private key for Noise, base64url.
    pub x25519: String,
    /// The current refresh token of auth.odahcam.com, empty when signed out.
    #[serde(default)]
    pub refresh: String,
}

fn test_dir() -> Option<PathBuf> {
    std::env::var_os("HANGAR_SECRETS_DIR").filter(|v| !v.is_empty()).map(PathBuf::from)
}

pub fn load() -> Result<Option<Secrets>, String> {
    let mut text = match test_dir() {
        Some(dir) => match std::fs::read_to_string(dir.join("secrets.json")) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        },
        None => match keyring::Entry::new(SERVICE, ITEM).and_then(|e| e.get_password()) {
            Ok(t) => t,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(e) => return Err(e.to_string()),
        },
    };
    let parsed = serde_json::from_str(&text).map_err(|e| e.to_string());
    text.zeroize();
    parsed.map(Some)
}

/// Replaces the item as a whole: a rotated refresh token is stored before it is used, so a crash can't leave the
/// store holding a token the server has already retired.
pub fn store(s: &Secrets) -> Result<(), String> {
    let mut text = serde_json::to_string(s).map_err(|e| e.to_string())?;
    let r = match test_dir() {
        Some(dir) => {
            let tmp = dir.join("secrets.json.tmp");
            std::fs::write(&tmp, &text).and_then(|_| std::fs::rename(&tmp, dir.join("secrets.json"))).map_err(|e| e.to_string())
        }
        None => keyring::Entry::new(SERVICE, ITEM).and_then(|e| e.set_password(&text)).map_err(|e| e.to_string()),
    };
    text.zeroize();
    r
}
