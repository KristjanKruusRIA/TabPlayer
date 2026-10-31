//! The cabinet responses that ship with TabPlayer: every one is listed, makes a kernel at both usual rates, plays
//! through a track's cabinet, and cannot be removed or copied into the user's library.
use std::path::PathBuf;
use tabplayer_lib::audio::{
    cabinet_ir::{self, IrLibrary},
    dsp::{CabinetIr, FxSettings, TrackDsp},
};

fn bundled() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/cabinet-irs")
}
fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!(
        "tabplayer-bundled-ir-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    directory
}

#[test]
fn every_bundled_response_is_listed_and_makes_a_kernel_at_each_rate() {
    let library = IrLibrary::with_bundled(scratch("kernels"), Some(bundled()));
    let entries = library.list();
    assert_eq!(entries.len(), 58, "the bundled set is complete");
    assert!(
        entries.iter().any(|entry| entry.name.contains("1.00in")),
        "a distance in a display name keeps its dot"
    );
    for entry in &entries {
        assert!(entry.bundled, "{} is read-only", entry.name);
        assert!(
            !entry.name.is_empty() && entry.name.len() <= 64,
            "{}",
            entry.id
        );
        assert!(entry.duration_ms > 0.0 && entry.bytes > 0, "{}", entry.name);
        for rate in [44_100, 48_000] {
            library
                .kernel(&entry.id, rate)
                .unwrap_or_else(|problem| panic!("{} at {rate}: {problem}", entry.name));
        }
    }
}

#[test]
fn a_bundled_response_plays_and_cannot_be_removed_or_copied() {
    let user = scratch("play");
    let library = cabinet_ir::install(user.clone(), Some(bundled()));
    let entries = library.list();
    let first = entries.first().expect("a bundled response");
    assert!(first.bundled);

    let mut fx = FxSettings::default();
    fx.cabinet.enabled = true;
    fx.cabinet.ir = Some(CabinetIr {
        id: first.id.clone(),
        name: first.name.clone(),
        level_db: 0.0,
    });
    let mut dsp = TrackDsp::new(fx, 48_000, 1.0).unwrap();
    let mut peak = 0.0f32;
    for n in 0..48_000 {
        let x = (n as f32 * 0.05).sin() * 0.2;
        let y = dsp.process([x; 2], 120.0);
        assert!(y[0].is_finite() && y[1].is_finite());
        peak = peak.max(y[0].abs());
    }
    assert!(peak > 0.01, "the bundled response is heard: {peak}");

    assert!(
        library.remove(&first.id).is_err(),
        "a bundled response is read-only"
    );
    assert!(library.taps(&first.id, 48_000).is_ok());

    // Importing the same bytes offers the bundled response and writes nothing into the user's folder.
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(bundled().join("manifest.json")).unwrap()).unwrap();
    let file = manifest["irs"][0]["file"].as_str().unwrap();
    let bytes = std::fs::read(bundled().join(file)).unwrap();
    let imported = library.import_bytes(&bytes, "Copy.wav").unwrap();
    assert!(imported.bundled);
    assert_eq!(imported.id, manifest["irs"][0]["id"].as_str().unwrap());
    assert!(
        !user.join(format!("{}.wav", imported.id)).exists(),
        "the bundled bytes are not copied"
    );
}
