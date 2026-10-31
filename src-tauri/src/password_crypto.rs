//! Password protection for TabPlayer projects: the cryptography only.
//!
//! Two protections use the same password-based key derivation (Argon2id) and differ in what they can promise:
//!
//! * **Password to open** is real encryption. The project's JSON is sealed with XChaCha20-Poly1305 under a key derived from
//!   the password, so a file without its password reveals neither the score nor the edit history, and any change to it is
//!   detected. There is no recovery path: a forgotten password cannot be reset by anyone.
//! * **Password to edit** cannot be encryption, because the score has to stay readable for the file to play. The file keeps
//!   a salted Argon2id verifier, so the password itself is not recoverable from it, and TabPlayer refuses edits until the
//!   password is given. Anyone who edits the file by hand, or uses another program, can still bypass it. It is a deterrent.
//!
//! Everything read from a file is untrusted: the sizes and key-derivation costs it names are bounded before any work is done.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::STANDARD};
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use serde::{Deserialize, Deserializer, Serialize};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

/// The only message a wrong password to open gives. A wrong password and a changed or cut-short file are
/// indistinguishable by design, so it names both.
pub const WRONG_OPEN_PASSWORD: &str = "The password is incorrect, or this file is damaged.";
/// The only message a wrong password to edit, or to change a protection, gives.
pub const WRONG_PASSWORD: &str = "That password is not correct.";
pub const DAMAGED_FILE: &str =
    "This password-protected file is damaged, or was made by a newer version of TabPlayer.";
pub const PASSWORD_RULE: &str = "Choose a password of 8 to 128 characters.";

const MIN_PASSWORD_CHARS: usize = 8;
const MAX_PASSWORD_CHARS: usize = 128;
/// A longer password is never a real one; it is refused before the key derivation spends time on it.
const MAX_PASSWORD_BYTES: usize = 1024;

const MAGIC: &[u8; 8] = b"TABPLOCK";
const FORMAT_VERSION: u8 = 1;
const KDF_ARGON2ID: u8 = 1;
const CIPHER_XCHACHA20_POLY1305: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const KEY_LEN: usize = 32;
/// Magic, version, key derivation, cipher, reserved byte, three cost words, salt and nonce. All of it is authenticated.
const HEADER_LEN: usize = 8 + 4 + 12 + SALT_LEN + NONCE_LEN;

pub type Salt = [u8; SALT_LEN];

/// Argon2id costs. The defaults are the strongest the app asks of a computer in a moment's wait; a file may name
/// others, but only within the bounds below, so a hostile file cannot make opening it run out of memory or time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KdfParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl KdfParams {
    /// 128 MiB, three passes, one lane: well above the OWASP minimums for Argon2id, and a fraction of a second on a desktop.
    pub const DEFAULT: Self = Self {
        memory_kib: 128 * 1024,
        iterations: 3,
        parallelism: 1,
    };
    pub const MAX_MEMORY_KIB: u32 = 256 * 1024;
    pub const MAX_ITERATIONS: u32 = 10;
    pub const MAX_PARALLELISM: u32 = 8;

    /// Checked costs. Used for every value read from a file and for the small values tests choose.
    pub fn new(memory_kib: u32, iterations: u32, parallelism: u32) -> Result<Self, String> {
        let params = Self {
            memory_kib,
            iterations,
            parallelism,
        };
        params.validate()?;
        Ok(params)
    }

    pub fn validate(&self) -> Result<(), String> {
        let lanes = (1..=Self::MAX_PARALLELISM).contains(&self.parallelism);
        if !lanes
            || !(1..=Self::MAX_ITERATIONS).contains(&self.iterations)
            || self.memory_kib < 8 * self.parallelism
            || self.memory_kib > Self::MAX_MEMORY_KIB
        {
            return Err(DAMAGED_FILE.into());
        }
        Ok(())
    }
}

/// A password from the interface. It is wiped when dropped, and never printed.
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(Zeroizing::new(value.into()))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Secret(..)")
    }
}

impl<'de> Deserialize<'de> for Secret {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(Secret::new)
    }
}

/// Whether a new password is acceptable. Eight characters is the least that makes the opening lock worth having; the
/// upper bound only keeps the interface honest.
pub fn check_new_password(password: &str) -> Result<(), String> {
    let count = password.chars().count();
    if !(MIN_PASSWORD_CHARS..=MAX_PASSWORD_CHARS).contains(&count)
        || password.len() > MAX_PASSWORD_BYTES
    {
        return Err(PASSWORD_RULE.into());
    }
    Ok(())
}

fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0; N];
    getrandom::fill(&mut bytes)
        .map_err(|_| "The system could not provide random bytes.".to_string())?;
    Ok(bytes)
}

fn derive(
    password: &str,
    salt: &Salt,
    params: KdfParams,
) -> Result<Zeroizing<[u8; KEY_LEN]>, String> {
    params.validate()?;
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(PASSWORD_RULE.into());
    }
    let costs = Params::new(
        params.memory_kib,
        params.iterations,
        params.parallelism,
        Some(KEY_LEN),
    )
    .map_err(|_| DAMAGED_FILE.to_string())?;
    let mut key = Zeroizing::new([0; KEY_LEN]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, costs)
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| "The password could not be processed.".to_string())?;
    Ok(key)
}

/// The edit lock as stored in a project: a salted Argon2id hash, never the password. Whoever can read the file can
/// try passwords against it offline, which the slow derivation makes expensive but not impossible.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PasswordVerifier {
    kdf: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
    hash: String,
}

impl PasswordVerifier {
    pub fn create(password: &str, params: KdfParams) -> Result<Self, String> {
        check_new_password(password)?;
        let salt = random::<SALT_LEN>()?;
        let hash = derive(password, &salt, params)?;
        Ok(Self {
            kdf: "argon2id".into(),
            memory_kib: params.memory_kib,
            iterations: params.iterations,
            parallelism: params.parallelism,
            salt: STANDARD.encode(salt),
            hash: STANDARD.encode(hash.as_slice()),
        })
    }

    fn decoded(&self) -> Result<(KdfParams, Salt, [u8; KEY_LEN]), String> {
        if self.kdf != "argon2id" {
            return Err(
                "This project uses a password protection this version does not know.".into(),
            );
        }
        let params = KdfParams::new(self.memory_kib, self.iterations, self.parallelism)?;
        let salt: Salt = STANDARD
            .decode(&self.salt)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or("This project's edit protection is damaged.")?;
        let hash: [u8; KEY_LEN] = STANDARD
            .decode(&self.hash)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or("This project's edit protection is damaged.")?;
        Ok((params, salt, hash))
    }

    /// Checked when a project is read: the costs it names are bounded and the encodings have their lengths.
    pub fn validate(&self) -> Result<(), String> {
        self.decoded().map(|_| ())
    }

    pub fn verify(&self, password: &Secret) -> Result<(), String> {
        let (params, salt, hash) = self.decoded()?;
        if password.expose().len() > MAX_PASSWORD_BYTES {
            return Err(WRONG_PASSWORD.into());
        }
        let candidate = derive(password.expose(), &salt, params)?;
        if bool::from(candidate.as_slice().ct_eq(&hash)) {
            Ok(())
        } else {
            Err(WRONG_PASSWORD.into())
        }
    }
}

/// The key a project is sealed under, kept while the document is open so that saving needs no password and the
/// password itself is not kept. It is never written to disk, never serialized, and wiped when dropped.
#[derive(Clone)]
pub struct OpenLock {
    key: Zeroizing<[u8; KEY_LEN]>,
    salt: Salt,
    params: KdfParams,
}

impl OpenLock {
    pub fn create(password: &str, params: KdfParams) -> Result<Self, String> {
        check_new_password(password)?;
        let salt = random::<SALT_LEN>()?;
        let key = derive(password, &salt, params)?;
        Ok(Self { key, salt, params })
    }

    /// Names this lock without revealing the key: a change of password makes a new salt.
    pub fn salt(&self) -> Salt {
        self.salt
    }

    /// Whether `password` is the one this lock was made from.
    pub fn accepts(&self, password: &Secret) -> bool {
        if password.expose().len() > MAX_PASSWORD_BYTES {
            return false;
        }
        derive(password.expose(), &self.salt, self.params)
            .is_ok_and(|key| bool::from(key.as_slice().ct_eq(self.key.as_slice())))
    }
}

impl PartialEq for OpenLock {
    fn eq(&self, other: &Self) -> bool {
        self.salt == other.salt
            && self.params == other.params
            && bool::from(self.key.as_slice().ct_eq(other.key.as_slice()))
    }
}

impl std::fmt::Debug for OpenLock {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("OpenLock(..)")
    }
}

/// Whether these bytes are a password-protected project rather than plain JSON or a score.
pub fn is_sealed(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

struct Header {
    params: KdfParams,
    salt: Salt,
    nonce: [u8; NONCE_LEN],
}

fn parse(bytes: &[u8]) -> Result<Header, String> {
    if bytes.len() < HEADER_LEN + TAG_LEN || !is_sealed(bytes) {
        return Err(DAMAGED_FILE.into());
    }
    if bytes[8] != FORMAT_VERSION
        || bytes[9] != KDF_ARGON2ID
        || bytes[10] != CIPHER_XCHACHA20_POLY1305
        || bytes[11] != 0
    {
        return Err(DAMAGED_FILE.into());
    }
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().expect("four bytes"));
    let params = KdfParams::new(word(12), word(16), word(20))?;
    Ok(Header {
        params,
        salt: bytes[24..24 + SALT_LEN].try_into().expect("salt length"),
        nonce: bytes[24 + SALT_LEN..HEADER_LEN]
            .try_into()
            .expect("nonce length"),
    })
}

/// Checks the file's structure without a password, so a file that can never open is reported before anyone is asked
/// for one. It reveals nothing about the password.
pub fn check_sealed(bytes: &[u8]) -> Result<(), String> {
    parse(bytes).map(|_| ())
}

/// Seals `plaintext` under `lock` with a fresh random nonce. The header, including the costs, is authenticated.
pub fn seal(lock: &OpenLock, plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let nonce = random::<NONCE_LEN>()?;
    let mut sealed = Vec::with_capacity(HEADER_LEN + plaintext.len() + TAG_LEN);
    sealed.extend_from_slice(MAGIC);
    sealed.extend_from_slice(&[FORMAT_VERSION, KDF_ARGON2ID, CIPHER_XCHACHA20_POLY1305, 0]);
    for cost in [
        lock.params.memory_kib,
        lock.params.iterations,
        lock.params.parallelism,
    ] {
        sealed.extend_from_slice(&cost.to_le_bytes());
    }
    sealed.extend_from_slice(&lock.salt);
    sealed.extend_from_slice(&nonce);
    debug_assert_eq!(sealed.len(), HEADER_LEN);
    let cipher = XChaCha20Poly1305::new(lock.key.as_slice().into());
    let body = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &sealed,
            },
        )
        .map_err(|_| "The project could not be encrypted.".to_string())?;
    sealed.extend_from_slice(&body);
    Ok(sealed)
}

/// Opens a sealed project. Every failure after the structure check, a wrong password or a changed or cut-short file,
/// is the same error, so nothing is learned about the password except whether it was right.
pub fn unseal(bytes: &[u8], password: &Secret) -> Result<(Zeroizing<Vec<u8>>, OpenLock), String> {
    let header = parse(bytes)?;
    if password.expose().len() > MAX_PASSWORD_BYTES {
        return Err(WRONG_OPEN_PASSWORD.into());
    }
    let key = derive(password.expose(), &header.salt, header.params)?;
    let cipher = XChaCha20Poly1305::new(key.as_slice().into());
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&header.nonce),
            Payload {
                msg: &bytes[HEADER_LEN..],
                aad: &bytes[..HEADER_LEN],
            },
        )
        .map_err(|_| WRONG_OPEN_PASSWORD.to_string())?;
    Ok((
        Zeroizing::new(plaintext),
        OpenLock {
            key,
            salt: header.salt,
            params: header.params,
        },
    ))
}

/// A field that may be absent but never null: a null would read as unprotected and lose the protection on save.
pub fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}
