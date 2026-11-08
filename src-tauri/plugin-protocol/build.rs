//! Writes `TABPLAYER_PLUGIN_BUILD_ID`: the crate version, the git commit when there is one, and a hash of the protocol
//! and helper sources. The app and the helper both compile this crate, so a helper rebuilt from different sources, or an
//! old one left in `binaries/` or `target/`, cannot present the id the app expects (preflight ruling P33).
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

fn git(manifest_dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(manifest_dir)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|text| !text.is_empty())
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
    ] {
        let path = workspace.join(file);
        println!("cargo:rerun-if-changed={}", path.display());
        files.push((file.to_string(), fs::read(&path).unwrap_or_default()));
    }
    let commit =
        git(&manifest_dir, &["rev-parse", "--short=12", "HEAD"]).unwrap_or_else(|| "nogit".into());
    if let Some(head) = git(&manifest_dir, &["rev-parse", "--git-path", "HEAD"]) {
        println!(
            "cargo:rerun-if-changed={}",
            manifest_dir.join(head).display()
        );
    }
    let version = std::env::var("CARGO_PKG_VERSION").unwrap();
    println!(
        "cargo:rustc-env=TABPLAYER_PLUGIN_BUILD_ID={version}+{commit}-{}",
        build_id::fingerprint(&files)
    );
}
