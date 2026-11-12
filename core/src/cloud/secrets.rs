// The device's secrets: its Ed25519 identity seed, its X25519 Noise key and the account's refresh token, kept together
// in one item of the OS credential store (Keychain on macOS, Credential Manager on Windows). One item means one
// "allow" prompt after an update re-signs the app, not three. On macOS the item is created by Hangar, so its ACL
// trusts only Hangar's code signature; other processes of the user get a prompt instead of a silent read. On Windows
// the Credential Manager has no per-app ACL: any process of the user can read the item.
//
// HANGAR_SECRETS_DIR swaps the store for a plain file in that folder, in debug builds only (the test suites): a
// release build ignores it, so whoever can set the user's environment can't move the secrets out of the store.
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
    /// The device chain as this machine last accepted it (chain::Pin as JSON), empty before pairing. Kept here and
    /// not in state.db, so a local process that can write Hangar's data folder can't rewrite what is trusted.
    #[serde(default)]
    pub pin: String,
    /// When a refresh request was sent whose answer hasn't been stored yet (ms since the epoch), 0 when none. If the
    /// answer never arrived, the server may have rotated the token already: past its reuse grace the old one must not
    /// be sent again, since a retired token's reuse revokes every machine of the account.
    #[serde(default)]
    pub refresh_sent_at: i64,
    /// The person asked, on this machine, to recover the account's device chain (every machine lost): once the
    /// relay resets it, this machine drops its pin and roots the new chain.
    #[serde(default)]
    pub recovering: bool,
}

fn test_dir() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
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

/// Every read-modify-write of the item goes through `update`, under this lock: the refresh token and the pin share
/// the item, and two writers each starting from their own read would put back the other's old value.
static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Reads the item, lets `f` change it and stores it, all under the process-wide lock. `f` gets None when there is no
/// item yet; it returns the item to store (None leaves the store as it was) and a value for the caller.
pub fn update<T>(f: impl FnOnce(Option<Secrets>) -> Result<(Option<Secrets>, T), String>) -> Result<T, String> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (next, out) = f(load()?)?;
    if let Some(s) = next {
        store(&s)?;
    }
    Ok(out)
}

/// Replaces the item as a whole: a rotated refresh token is stored before it is used, so a crash can't leave the
/// store holding a token the server has already retired. Only `update` calls it.
fn store(s: &Secrets) -> Result<(), String> {
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
