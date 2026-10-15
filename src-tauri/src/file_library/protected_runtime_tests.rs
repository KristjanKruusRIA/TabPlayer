use super::*;

fn protected_audio(root: &Path) -> NativeAudio {
    NativeAudio::new(PathBuf::new(), Arc::new(|_| {}))
        .with_protected_paths(ProtectedPaths::new(vec![root.to_owned()]).unwrap())
}

fn address(workspace: &Mutex<DocumentWorkspace>) -> DocumentRevision {
    let workspace = workspace.lock().unwrap();
    DocumentRevision {
        document_id: workspace.active_owner().document_id.clone(),
        revision: 0,
    }
}

fn alias_directory(alias: &Path, target: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, alias).unwrap();
    #[cfg(windows)]
    if let Err(error) = std::os::windows::fs::symlink_dir(target, alias) {
        assert_eq!(error.raw_os_error(), Some(1314));
        let result = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(alias)
            .arg(target)
            .output()
            .unwrap();
        assert!(result.status.success(), "{result:?}");
    }
}

#[test]
fn protected_runtime_admission_rejects_pdf_wav_and_stems_before_running_job() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("file-library-v1");
    std::fs::create_dir(&root).unwrap();
    let audio = protected_audio(&root);
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let document = address(&workspace);
    let jobs = ExportJobs::default();
    for name in ["score.pdf", "score.wav", "stem set Ä"] {
        let path = root.join(name);
        let result = audio.launch_export(&jobs, &workspace, &document, Some(&path), None, None, 0);
        assert!(result.is_err(), "accepted protected destination {name}");
        assert!(!jobs.has_running().unwrap());
        assert!(!path.exists());
    }
}

#[test]
fn protected_runtime_capture_rechecks_namespace_aliases_after_admission() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("library");
    let output = directory.path().join("output Ä");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&output).unwrap();
    let audio = protected_audio(&root);
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let jobs = ExportJobs::default();
    let capture = audio
        .launch_export(
            &jobs,
            &workspace,
            &address(&workspace),
            Some(&output.join("score.pdf")),
            None,
            None,
            0,
        )
        .unwrap();
    std::fs::remove_dir(&output).unwrap();
    alias_directory(&output, &root);
    for name in ["score.pdf", "score.wav"] {
        assert!(capture.protect_destination(&output.join(name)).is_err());
        assert!(!root.join(name).exists());
    }
    assert!(
        capture
            .protect_stem_destination(&output.join("stems"))
            .is_err()
    );
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
    capture.job.finish(Ok(()));
}

#[test]
fn protected_runtime_stem_parent_is_checked_even_when_destination_alias_leads_outside() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("library");
    let external = directory.path().join("external");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&external).unwrap();
    let audio = protected_audio(&root);
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let jobs = ExportJobs::default();
    let capture = audio
        .launch_export(&jobs, &workspace, &address(&workspace), None, None, None, 0)
        .unwrap();
    let parent = root.join("redirected-parent");
    alias_directory(&parent, &external);
    let destination = parent.join("new-stems");
    assert!(capture.protect_destination(&destination).is_ok());
    assert!(capture.protect_stem_destination(&destination).is_err());
    assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    assert_eq!(std::fs::read_dir(&external).unwrap().count(), 0);
    capture.job.finish(Ok(()));
}

#[test]
fn protected_runtime_fixed_print_cache_remains_usable_and_protected_alias_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("file-library-v1");
    std::fs::create_dir(&root).unwrap();
    let audio = protected_audio(&root);
    let cache = directory.path().join("app-cache/print");
    audio.protect_destination(&cache).unwrap();
    let workspace = Mutex::new(DocumentWorkspace::new().unwrap());
    let jobs = ExportJobs::default();
    let capture = audio
        .launch_export(&jobs, &workspace, &address(&workspace), None, None, None, 0)
        .unwrap();
    let canonical_cache = capture.print_cache(&cache).unwrap();
    let pdf =
        crate::export::print::prepare_pdf(b"%PDF-1.7\nretained fixture", &canonical_cache).unwrap();
    assert_eq!(std::fs::read(&pdf).unwrap(), b"%PDF-1.7\nretained fixture");
    let redirected_cache = directory.path().join("redirected-cache");
    alias_directory(&redirected_cache, &root);
    assert!(
        audio
            .protect_destination(&redirected_cache.join("print"))
            .is_err()
    );
    assert!(
        capture
            .print_cache(&redirected_cache.join("print"))
            .is_err()
    );
    assert!(!root.join("print").exists());
    assert!(pdf.exists());
    capture.job.finish(Ok(()));
}
