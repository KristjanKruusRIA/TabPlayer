//! Writes `TABPLAYER_PLUGIN_BUILD_ID`: the crate version and a hash of the protocol and helper sources and the lock file.
//! The git commit is left out on purpose: Cargo reruns this script per profile and target folder, and only when a watched
//! file changes, so a commit stamped into one build goes stale and would split identical sources into different ids. The app and the helper both compile this crate, so a helper rebuilt from different sources, or an
//! old one left in `binaries/` or `target/`, cannot present the id the app expects (preflight ruling P33).
use std::fs;
use std::path::{Path, PathBuf};

mod build_id;

fn collect(dir: &Path, root: &Path, out: &mut Vec<(String, Vec<u8>)>) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let Ok(read) = fs::read_dir(dir) else { return };
    let mut paths: Vec<PathBuf> = read.filter_map(|e| e.ok().map(|e| e.path())).collect();
    paths.sort();
    for path in paths {
        if path.is_dir() {
            collect(&path, root, out);
        } else if let Ok(bytes) = fs::read(&path) {
            let name = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            out.push((name, bytes));
        }
    }
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let workspace = manifest_dir.parent().unwrap().to_path_buf();
    let mut files = Vec::new();
    for part in ["plugin-protocol/src", "plugin-host/src"] {
        collect(&workspace.join(part), &workspace, &mut files);
    }
    for file in [
        "plugin-protocol/Cargo.toml",
        "plugin-protocol/build.rs",
        "plugin-protocol/build_id.rs",
        "plugin-host/Cargo.toml",
        "Cargo.lock",
    ] {
        let path = workspace.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        files.push((file.to_string(), fs::read(&path).unwrap_or_default()));
    }
    let version = std::env::var("CARGO_PKG_VERSION").unwrap();
    println!(
        "cargo:rustc-env=TABPLAYER_PLUGIN_BUILD_ID={version}+{}",
        build_id::fingerprint(&files)
    );
}
