// This machine's device identity: an Ed25519 key that names it in the device chain and proves it to the relay, and
// an X25519 key for the Noise sessions with the account's other machines. Both are created on first use and live in
// the OS credential store (secrets.rs), never in Hangar's data folder.
use super::secrets::{self, Secrets};
use super::{b64, unb64};
use ed25519_dalek::{Signer, SigningKey};
use snow::params::DHChoice;
use snow::resolvers::{CryptoResolver, DefaultResolver};
use zeroize::Zeroizing;

pub struct Identity {
    signing: SigningKey,
    x25519: Zeroizing<[u8; 32]>,
    x25519_public: [u8; 32],
}

impl Identity {
    /// The stored identity, or a new one stored before it is returned.
    pub fn load_or_create() -> Result<Identity, String> {
        if let Some(s) = secrets::load()? {
            return Identity::from_secrets(&s);
        }
        let mut seed = Zeroizing::new([0u8; 32]);
        let mut dh = Zeroizing::new([0u8; 32]);
        getrandom::fill(seed.as_mut()).and_then(|_| getrandom::fill(dh.as_mut())).map_err(|e| e.to_string())?;
        let s = Secrets { ed25519: b64(seed.as_ref()), x25519: b64(dh.as_ref()), refresh: String::new() };
        secrets::store(&s)?;
        Identity::from_secrets(&s)
    }

    pub fn from_secrets(s: &Secrets) -> Result<Identity, String> {
        let key32 = |v: &str| -> Result<Zeroizing<[u8; 32]>, String> {
            let bytes = Zeroizing::new(unb64(v).ok_or("secrets: base64")?);
            <[u8; 32]>::try_from(bytes.as_slice()).map(Zeroizing::new).map_err(|_| "secrets: key length".to_string())
        };
        let seed = key32(&s.ed25519)?;
        let x25519 = key32(&s.x25519)?;
        let mut dh = DefaultResolver.resolve_dh(&DHChoice::Curve25519).ok_or("x25519")?;
        dh.set(x25519.as_ref());
        let x25519_public = <[u8; 32]>::try_from(dh.pubkey()).map_err(|_| "x25519")?;
        Ok(Identity { signing: SigningKey::from_bytes(&seed), x25519, x25519_public })
    }

    /// The device's name in the chain and at the relay: its Ed25519 public key, base64url.
    pub fn device(&self) -> String {
        b64(&self.signing.verifying_key().to_bytes())
    }

    /// The X25519 public key other devices use to open Noise sessions with this one, base64url.
    pub fn dh(&self) -> String {
        b64(&self.x25519_public)
    }

    pub fn dh_private(&self) -> &[u8; 32] {
        &self.x25519
    }

    pub fn sign(&self, data: &[u8]) -> String {
        b64(&self.signing.sign(data).to_bytes())
    }

    /// The answer to the relay's challenge: binds this socket to the account and the device key.
    pub fn prove(&self, sub: &str, nonce: &str) -> String {
        self.sign(format!("hangar-relay-v1\n{sub}\n{nonce}").as_bytes())
    }
}
