//! Stores the user's consent for plug-ins and their states (THE-71).
//!
//! The store is a read-modify-write of one file. Callers in one process must serialize it (the plug-in service holds a
//! lock around every open and grant); the temp file of each write is unique, so two writes never share one.
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tabplayer_plugin_protocol::validate::valid_class_id;

pub const MAX_CONSENT_PAIRS: usize = 4096;
pub const MAX_FILE_BYTES: usize = 1 << 20; // 1 MiB
pub const FORMAT_VERSION: u32 = 1;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize)]
struct ConsentFile {
    version: u32,
    pairs: Vec<[String; 2]>,
}

#[derive(Debug, Clone)]
pub struct ConsentStore {
    path: PathBuf,
    pairs: VecDeque<(String, String)>,
    /// The file on disk could not be read as a consent file (damaged, oversized or from a newer version). It is kept
    /// aside as `<name>.damaged` before the next grant replaces it, so earlier consent is not lost without a trace.
    damaged: bool,
}

fn valid_state_id(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn read_capped(reader: impl Read, cap: usize) -> io::Result<Option<Vec<u8>>> {
    let mut bytes = Vec::new();
    reader.take(cap as u64 + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() <= cap).then_some(bytes))
}

impl ConsentStore {
    fn empty(path: PathBuf, damaged: bool) -> Self {
        Self {
            path,
            pairs: VecDeque::new(),
            damaged,
        }
    }

    /// Opens the consent store at `path`. A missing file is an empty store. A damaged, oversized or newer file is
    /// read as an empty store and left as it is until the next grant, which keeps it aside first. A file that cannot
    /// be opened at all is an error.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        if !path.exists() {
            return Ok(Self::empty(path, false));
        }

        let file = File::open(&path).map_err(|e| e.to_string())?;
        let bytes = match read_capped(file, MAX_FILE_BYTES).map_err(|e| e.to_string())? {
            Some(b) => b,
            None => return Ok(Self::empty(path, true)),
        };

        let Ok(data) = serde_json::from_slice::<ConsentFile>(&bytes) else {
            return Ok(Self::empty(path, true));
        };

        if data.version != FORMAT_VERSION {
            return Ok(Self::empty(path, true));
        }

        let mut pairs = VecDeque::new();
        for [class_id, state_id] in data.pairs {
            if valid_class_id(&class_id) && valid_state_id(&state_id) {
                let norm_class = class_id.to_ascii_uppercase();
                let norm_state = state_id.to_ascii_lowercase();
                if !pairs
                    .iter()
                    .any(|(c, s)| c == &norm_class && s == &norm_state)
                {
                    pairs.push_back((norm_class, norm_state));
                    if pairs.len() == MAX_CONSENT_PAIRS {
                        break;
                    }
                }
            }
        }

        Ok(Self {
            path,
            pairs,
            damaged: false,
        })
    }

    /// Whether the user has consented to run `class_id` with `state_id`.
    pub fn allowed(&self, class_id: &str, state_id: &str) -> bool {
        let norm_class = class_id.to_ascii_uppercase();
        let norm_state = state_id.to_ascii_lowercase();
        self.pairs
            .iter()
            .any(|(c, s)| c == &norm_class && s == &norm_state)
    }

    /// Grants consent to `pairs`. At most [`MAX_CONSENT_PAIRS`] pairs are retained, with the oldest
    /// dropped first. Writes atomically to disk.
    pub fn grant(
        &mut self,
        pairs: impl IntoIterator<Item = (String, String)>,
    ) -> Result<(), String> {
        let mut changed = false;
        for (class_id, state_id) in pairs {
            if !valid_class_id(&class_id) || !valid_state_id(&state_id) {
                continue;
            }
            let norm_class = class_id.to_ascii_uppercase();
            let norm_state = state_id.to_ascii_lowercase();

            // If already present, remove it so it can be re-appended to the back as most recent
            if let Some(pos) = self
                .pairs
                .iter()
                .position(|(c, s)| c == &norm_class && s == &norm_state)
            {
                self.pairs.remove(pos);
            }
            self.pairs.push_back((norm_class, norm_state));
            changed = true;

            while self.pairs.len() > MAX_CONSENT_PAIRS {
                self.pairs.pop_front();
            }
        }

        if !changed && self.path.exists() {
            return Ok(());
        }

        self.commit()
    }

    fn commit(&mut self) -> Result<(), String> {
        let data = ConsentFile {
            version: FORMAT_VERSION,
            pairs: self
                .pairs
                .iter()
                .map(|(c, s)| [c.clone(), s.clone()])
                .collect(),
        };

        let encoded = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        if self.damaged && self.path.is_file() {
            let mut aside = self.path.clone().into_os_string();
            aside.push(".damaged");
            fs::copy(&self.path, PathBuf::from(aside)).map_err(|e| e.to_string())?;
        }

        let tmp = self.path.with_extension(format!(
            "tmp-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        {
            let mut file = File::create(&tmp).map_err(|e| e.to_string())?;
            file.write_all(&encoded).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }

        fs::rename(&tmp, &self.path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            e.to_string()
        })?;
        self.damaged = false;

        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_states_are_consented() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("consent.json");
        let mut store = ConsentStore::open(&path).unwrap();
        let class = "0123456789ABCDEF0123456789ABCDEF";
        let state = "a".repeat(64);
        assert!(!store.allowed(class, &state));
        store.grant([(class.to_string(), state.clone())]).unwrap();
        assert!(store.allowed(class, &state));
    }

    #[test]
    fn foreign_pairs_need_consent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("consent.json");
        let store = ConsentStore::open(&path).unwrap();
        let class = "0123456789ABCDEF0123456789ABCDEF";
        let state = "b".repeat(64);
        assert!(!store.allowed(class, &state));
    }

    #[test]
    fn grant_covers_all_pairs_in_the_document_history() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("consent.json");
        let mut store = ConsentStore::open(&path).unwrap();
        let pairs: Vec<(String, String)> = (0..5)
            .map(|i| (format!("{i:X}").repeat(32), format!("{i:x}").repeat(64)))
            .collect();
        store.grant(pairs.clone()).unwrap();
        for (c, s) in &pairs {
            assert!(store.allowed(c, s));
        }
    }

    #[test]
    fn a_damaged_file_is_kept_aside_before_a_grant_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("consent.json");
        std::fs::write(&path, b"{ not json").unwrap();
        let mut store = ConsentStore::open(&path).unwrap();
        let class = "0123456789ABCDEF0123456789ABCDEF";
        store.grant([(class.to_string(), "c".repeat(64))]).unwrap();
        assert_eq!(
            std::fs::read(path.with_extension("json.damaged")).unwrap(),
            b"{ not json"
        );
        assert!(
            ConsentStore::open(&path)
                .unwrap()
                .allowed(class, &"c".repeat(64))
        );
    }

    #[test]
    fn commits_in_one_process_do_not_share_a_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("consent.json");
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let path = path.clone();
                std::thread::spawn(move || {
                    for j in 0..20 {
                        let mut store = ConsentStore {
                            path: path.clone(),
                            pairs: VecDeque::new(),
                            damaged: false,
                        };
                        store
                            .grant([(format!("{i:X}").repeat(32), format!("{j:x}").repeat(64))])
                            .map(|_| ())
                            .or_else(|error| {
                                // Renaming over a file another thread is renaming can be refused on Windows; a
                                // collision on the temp file is what this test is about.
                                if error.contains("os error 5") || error.contains("os error 32") {
                                    Ok(())
                                } else {
                                    Err(error)
                                }
                            })
                            .unwrap();
                    }
                })
            })
            .collect();
        for thread in threads {
            thread.join().unwrap();
        }
    }

    #[test]
    fn consent_file_is_capped_and_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("consent.json");
        let mut store = ConsentStore::open(&path).unwrap();
        let pairs: Vec<(String, String)> = (0..5000)
            .map(|i| (format!("{:032X}", i), format!("{:064x}", i)))
            .collect();
        store.grant(pairs).unwrap();
        // File must not exceed MAX_CONSENT_PAIRS
        let reloaded = ConsentStore::open(&path).unwrap();
        assert_eq!(reloaded.pairs.len(), MAX_CONSENT_PAIRS);
    }
}
