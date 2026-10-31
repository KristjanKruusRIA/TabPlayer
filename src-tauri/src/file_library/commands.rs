use super::{service::FileLibrary, types::*};
use crate::workspace::{DocumentIntake, DocumentRevision, DocumentWorkspace};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

pub(crate) fn admit_app(app: &AppHandle) -> Result<(), String> {
    let frozen = app
        .state::<Arc<Mutex<DocumentWorkspace>>>()
        .lock()
        .map_err(|error| error.to_string())?
        .is_frozen();
    if frozen {
        return Err("Finish the current session transition before using the Library.".into());
    }
    app.state::<FileLibrary>().admit().map(|_| ())
}

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        admit_app(&app)?;
        action(app)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn file_library_snapshot(app: AppHandle) -> Result<LibrarySnapshot, String> {
    blocking(app, |app| app.state::<FileLibrary>().snapshot()).await
}
#[tauri::command]
pub(crate) async fn file_library_retry(app: AppHandle) -> Result<LibrarySnapshot, String> {
    blocking(app, |app| app.state::<FileLibrary>().retry()).await
}
#[tauri::command]
pub(crate) async fn file_library_change(
    expected_revision: u64,
    change: LibraryChange,
    app: AppHandle,
) -> Result<LibrarySnapshot, String> {
    blocking(app, move |app| {
        app.state::<FileLibrary>().change(expected_revision, change)
    })
    .await
}
#[tauri::command]
pub(crate) async fn file_library_root_pick(
    expected_revision: u64,
    app: AppHandle,
) -> Result<Option<LibrarySnapshot>, String> {
    blocking(app, move |app| {
        let selected = app.dialog().file().blocking_pick_folder();
        let Some(selected) = selected else {
            return Ok(None);
        };
        admit_app(&app)?;
        app.state::<FileLibrary>()
            .add_root(
                expected_revision,
                selected.into_path().map_err(|error| error.to_string())?,
            )
            .map(Some)
    })
    .await
}
#[tauri::command]
pub(crate) async fn file_library_template_save(
    expected_revision: u64,
    document: DocumentRevision,
    name: String,
    app: AppHandle,
) -> Result<LibrarySnapshot, String> {
    blocking(app, move |app| {
        app.state::<FileLibrary>().save_template(
            expected_revision,
            &document,
            name,
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
        )
    })
    .await
}
#[tauri::command]
pub(crate) async fn file_library_metadata_ack(
    document: DocumentRevision,
    metadata: LibraryMetadata,
    app: AppHandle,
) -> Result<LibrarySnapshot, String> {
    blocking(app, move |app| {
        app.state::<FileLibrary>().metadata_ack(
            &document,
            metadata,
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
        )
    })
    .await
}
#[tauri::command]
pub(crate) async fn file_library_stage(
    source: LibrarySource,
    app: AppHandle,
) -> Result<DocumentIntake, String> {
    blocking(app, move |app| {
        app.state::<FileLibrary>()
            .stage(&source, &app.state::<Arc<Mutex<DocumentWorkspace>>>())
    })
    .await
}
#[tauri::command]
pub(crate) async fn file_library_scan_begin(
    root_id: String,
    app: AppHandle,
) -> Result<LibraryScan, String> {
    blocking(app, move |app| {
        app.state::<FileLibrary>().scan_begin(&root_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn file_library_scan_next(
    job_id: String,
    app: AppHandle,
) -> Result<LibraryBatch, String> {
    blocking(app, move |app| {
        app.state::<FileLibrary>().scan_next(&job_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn file_library_scan_read(
    job_id: String,
    file_id: String,
    app: AppHandle,
) -> Result<MetadataInput, String> {
    blocking(app, move |app| {
        app.state::<FileLibrary>().scan_read(&job_id, &file_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn file_library_scan_accept(
    job_id: String,
    file_id: String,
    result: MetadataResult,
    app: AppHandle,
) -> Result<LibraryScan, String> {
    blocking(app, move |app| {
        app.state::<FileLibrary>()
            .scan_accept(&job_id, &file_id, result)
    })
    .await
}
#[tauri::command]
pub(crate) async fn file_library_scan_finish(
    job_id: String,
    app: AppHandle,
) -> Result<LibrarySnapshot, String> {
    blocking(app, move |app| {
        app.state::<FileLibrary>().scan_finish(&job_id)
    })
    .await
}
#[tauri::command]
pub(crate) async fn file_library_scan_cancel(job_id: String, app: AppHandle) -> Result<(), String> {
    // Retirement must remain callable while a session transition is draining work.
    tauri::async_runtime::spawn_blocking(move || app.state::<FileLibrary>().scan_cancel(&job_id))
        .await
        .map_err(|error| error.to_string())?
}
#[tauri::command]
pub(crate) async fn file_library_search(
    query: LibraryQuery,
    app: AppHandle,
) -> Result<LibraryPage, String> {
    blocking(app, move |app| app.state::<FileLibrary>().search(&query)).await
}
#[tauri::command]
pub(crate) async fn file_library_reveal(
    document: DocumentRevision,
    app: AppHandle,
) -> Result<(), String> {
    blocking(app, move |app| {
        let library = app.state::<FileLibrary>();
        let epoch = library.admit()?;
        let path = {
            let workspace = app.state::<Arc<Mutex<DocumentWorkspace>>>();
            let workspace = workspace.lock().map_err(|error| error.to_string())?;
            if workspace.is_frozen() {
                return Err("Finish the current session transition first.".into());
            }
            let record = workspace.document(&document.document_id)?;
            if record.revision != document.revision {
                return Err("Document changed; retry with its current revision.".into());
            }
            record
                .snapshot
                .path
                .ok_or("Save this score before opening its containing folder.")?
        };
        library.check_epoch(epoch)?;
        crate::reveal::reveal_saved(std::path::Path::new(&path))
    })
    .await
}
#[tauri::command]
pub(crate) async fn workspace_drop_stage(
    drop_token: String,
    index: u32,
    app: AppHandle,
) -> Result<DocumentIntake, String> {
    blocking(app, move |app| {
        app.state::<FileLibrary>().drop_stage(
            &drop_token,
            index,
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
        )
    })
    .await
}

struct DropBatch {
    token: String,
    created: Instant,
    items: Vec<Option<Result<PathBuf, String>>>,
}

#[derive(Default)]
pub(super) struct DropTokens {
    batch: Option<DropBatch>,
}

impl DropTokens {
    pub(super) fn capture(
        &mut self,
        paths: Vec<PathBuf>,
        now: Instant,
        ready: bool,
    ) -> Result<ScoreFilesDroppedEvent, String> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let token = format!(
            "drop-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let items = if !ready {
            vec![Some(Err(
                "Finish the current session transition before dropping scores.".into(),
            ))]
        } else if paths.len() > 32 {
            vec![Some(Err(
                "Drop at most 32 scores at once. This batch was not opened.".into(),
            ))]
        } else if paths.is_empty() {
            return Err("No score files were dropped.".into());
        } else {
            paths
                .into_iter()
                .map(|path| {
                    let supported = path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| {
                            [
                                "tabplayer",
                                "gp",
                                "gpx",
                                "gp3",
                                "gp4",
                                "gp5",
                                "ptb",
                                "tef",
                                "xml",
                                "musicxml",
                                "mxl",
                            ]
                            .iter()
                            .any(|value| extension.eq_ignore_ascii_case(value))
                        });
                    Some(if supported {
                        Ok(path)
                    } else {
                        Err(format!(
                            "Unsupported score file: {}",
                            path.file_name().unwrap_or_default().to_string_lossy()
                        ))
                    })
                })
                .collect()
        };
        let count = items.len() as u32;
        self.batch = Some(DropBatch {
            token: token.clone(),
            created: now,
            items,
        });
        Ok(ScoreFilesDroppedEvent {
            drop_token: token,
            count,
        })
    }

    pub(super) fn take(
        &mut self,
        token: &str,
        index: u32,
        now: Instant,
    ) -> Result<PathBuf, String> {
        if self.batch.as_ref().is_some_and(|batch| {
            now.checked_duration_since(batch.created)
                .is_none_or(|age| age >= Duration::from_secs(30))
        }) {
            self.retire();
        }
        let batch = self
            .batch
            .as_mut()
            .filter(|batch| batch.token == token)
            .ok_or("Drop token expired or was retired. Drop the files again.")?;
        batch
            .items
            .get_mut(index as usize)
            .and_then(Option::take)
            .ok_or_else(|| {
                "Dropped item was already consumed or is outside this batch.".to_string()
            })?
    }

    pub(super) fn retire(&mut self) {
        self.batch = None;
    }
}

#[cfg(test)]
mod drop_tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn drop_keeps_order_and_reports_unsupported_items_without_paths_from_the_caller() {
        let mut tokens = DropTokens::default();
        let now = Instant::now();
        let event = tokens
            .capture(
                vec![
                    "one.gp".into(),
                    "unsupported.txt".into(),
                    "three.MUSICXML".into(),
                    "song.PTB".into(),
                    "song.tef".into(),
                ],
                now,
                true,
            )
            .unwrap();
        assert_eq!(event.count, 5);
        assert_eq!(
            tokens.take(&event.drop_token, 3, now).unwrap(),
            PathBuf::from("song.PTB")
        );
        assert_eq!(
            tokens.take(&event.drop_token, 4, now).unwrap(),
            PathBuf::from("song.tef")
        );
        assert_eq!(
            tokens.take(&event.drop_token, 0, now).unwrap(),
            PathBuf::from("one.gp")
        );
        assert!(
            tokens
                .take(&event.drop_token, 1, now)
                .unwrap_err()
                .contains("Unsupported")
        );
        assert_eq!(
            tokens.take(&event.drop_token, 2, now).unwrap(),
            PathBuf::from("three.MUSICXML")
        );
        assert!(tokens.take(&event.drop_token, 0, now).is_err());
        assert!(tokens.take(&event.drop_token, 1, now).is_err());
    }

    #[test]
    fn overflow_rejects_whole_batch_as_one_bounded_issue() {
        let mut tokens = DropTokens::default();
        let now = Instant::now();
        let event = tokens
            .capture(
                (0..33).map(|index| format!("{index}.gp").into()).collect(),
                now,
                true,
            )
            .unwrap();
        assert_eq!(event.count, 1);
        assert!(
            tokens
                .take(&event.drop_token, 0, now)
                .unwrap_err()
                .contains("32")
        );
        assert!(tokens.take(&event.drop_token, 1, now).is_err());
        assert!(tokens.batch.as_ref().unwrap().items.len() <= 32);
    }

    #[test]
    fn startup_or_shutdown_drop_never_retains_score_paths_for_later() {
        let mut tokens = DropTokens::default();
        let now = Instant::now();
        let event = tokens
            .capture(vec!["private.gp".into()], now, false)
            .unwrap();
        assert_eq!(event.count, 1);
        assert!(
            tokens
                .take(&event.drop_token, 0, now)
                .unwrap_err()
                .contains("session")
        );
        assert!(
            tokens
                .batch
                .as_ref()
                .unwrap()
                .items
                .iter()
                .all(|item| !matches!(item, Some(Ok(_))))
        );
    }

    #[test]
    fn expired_replaced_or_retired_tokens_cannot_be_replayed() {
        let mut tokens = DropTokens::default();
        let now = Instant::now();
        let first = tokens.capture(vec!["first.gp".into()], now, true).unwrap();
        assert!(tokens.take(&first.drop_token, 9, now).is_err());
        assert!(tokens.take("caller-made-token", 0, now).is_err());
        assert_eq!(
            tokens
                .take(&first.drop_token, 0, now + Duration::from_secs(29))
                .unwrap(),
            PathBuf::from("first.gp")
        );
        let second = tokens.capture(vec!["second.gp".into()], now, true).unwrap();
        assert!(tokens.take(&first.drop_token, 0, now).is_err());
        assert!(
            tokens
                .take(&second.drop_token, 0, now + Duration::from_secs(30))
                .is_err()
        );
        let third = tokens.capture(vec!["third.gp".into()], now, true).unwrap();
        tokens.retire();
        assert!(tokens.take(&third.drop_token, 0, now).is_err());
    }
}
