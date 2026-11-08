//! The build fingerprint, shared by `build.rs` (which computes it) and the unit tests (which check it).
//!
//! It is FNV-1a over file names and bytes. That is a staleness check between two binaries built on one machine, not a
//! security boundary, so a small hash with no dependency is enough, and the same answer on every toolchain.

const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const PRIME: u64 = 0x0000_0100_0000_01b3;

fn feed(state: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *state ^= u64::from(*byte);
        *state = state.wrapping_mul(PRIME);
    }
}

/// A hash of `files` (a name and its bytes each, in the order given). Names and lengths are mixed in, so moving bytes
/// between files, renaming a file or reordering them all change the answer.
#[allow(dead_code)]
pub fn fingerprint<N: AsRef<str>, B: AsRef<[u8]>>(files: &[(N, B)]) -> String {
    let mut state = OFFSET;
    for (name, bytes) in files {
        feed(&mut state, &(name.as_ref().len() as u64).to_le_bytes());
        feed(&mut state, name.as_ref().as_bytes());
        feed(&mut state, &(bytes.as_ref().len() as u64).to_le_bytes());
        feed(&mut state, bytes.as_ref());
    }
    format!("{state:016x}")
}

#[cfg(test)]
mod tests {
    use super::fingerprint;

    #[test]
    fn one_changed_byte_changes_the_fingerprint() {
        let base = [
            ("a.rs", b"fn main() {}".to_vec()),
            ("b.rs", b"mod x;".to_vec()),
        ];
        let mut changed = base.clone();
        changed[1].1[0] ^= 1;
        assert_ne!(fingerprint(&base), fingerprint(&changed));
        assert_eq!(fingerprint(&base), fingerprint(&base.clone()));
    }

    #[test]
    fn names_order_and_file_boundaries_matter() {
        let split = [("a", b"xy".to_vec()), ("b", b"z".to_vec())];
        let moved = [("a", b"x".to_vec()), ("b", b"yz".to_vec())];
        let renamed = [("c", b"xy".to_vec()), ("b", b"z".to_vec())];
        let reordered = [("b", b"z".to_vec()), ("a", b"xy".to_vec())];
        let base = fingerprint(&split);
        assert_ne!(base, fingerprint(&moved));
        assert_ne!(base, fingerprint(&renamed));
        assert_ne!(base, fingerprint(&reordered));
    }
}
