//! Score files the operating system asks TabPlayer to open: paths on the command line at launch, paths a second launch
//! passes to the running app, and macOS open-document events. They wait here until the workspace is ready, then go
//! through the same checked intake as dropped files, so a file opened before startup finishes is not lost.
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::Mutex,
};

/// The most files the queue keeps; more are counted and reported.
const MOST_PENDING: usize = 128;

/// A file handed out as a drop batch of its own, kept until it is staged or settled so it is never lost in between.
struct Loan {
    token: String,
    path: PathBuf,
    staged: bool,
}

#[derive(Default)]
struct Queue {
    pending: Vec<PathBuf>,
    lent: Option<Loan>,
    /// Files refused because the queue was full, not yet reported.
    overflow: usize,
}

impl Queue {
    /// Puts an unstaged loan back at the front; a staged one is finished.
    fn recover(&mut self) -> bool {
        match self.lent.take() {
            Some(loan) if !loan.staged => {
                self.pending.insert(0, loan.path);
                true
            }
            _ => false,
        }
    }
}

/// Files waiting for the workspace. They are handed out one at a time, each as its own drop batch, so a slow open (a
/// password prompt) never lets the 30-second drop token of the next file run out.
#[derive(Default)]
pub struct LaunchFiles(Mutex<Queue>);

impl LaunchFiles {
    /// Queues `paths`. Past [`MOST_PENDING`] files they are counted instead, and the count is reported on the next take.
    pub fn push(&self, paths: Vec<PathBuf>) {
        if let Ok(mut queue) = self.0.lock() {
            queue.pending.extend(paths);
            let excess = queue.pending.len().saturating_sub(MOST_PENDING);
            queue.overflow += excess;
            queue.pending.truncate(MOST_PENDING);
        }
    }
    /// Takes the next file, or `None` when none waits, with the count of files refused since the last take. An
    /// earlier loan that was never staged (its settle failed, or the page reloaded) goes back first, so it comes next.
    pub fn take(&self) -> (Option<PathBuf>, usize) {
        let Ok(mut queue) = self.0.lock() else {
            return (None, 0);
        };
        queue.recover();
        let overflow = std::mem::take(&mut queue.overflow);
        let next = (!queue.pending.is_empty()).then(|| queue.pending.remove(0));
        (next, overflow)
    }
    /// Puts back a file that was taken but could not be captured, ahead of files queued since.
    pub fn put_back(&self, path: PathBuf) {
        if let Ok(mut queue) = self.0.lock() {
            queue.pending.insert(0, path);
        }
    }
    /// Records that `path` went out as drop batch `token`.
    pub fn lend(&self, token: String, path: PathBuf) {
        if let Ok(mut queue) = self.0.lock() {
            queue.lent = Some(Loan {
                token,
                path,
                staged: false,
            });
        }
    }
    /// Marks the loan of drop batch `token` as staged: its file was handed to the intake, so it is never given back.
    pub fn staged(&self, token: &str) {
        if let Ok(mut queue) = self.0.lock() {
            if let Some(loan) = queue.lent.as_mut().filter(|loan| loan.token == token) {
                loan.staged = true;
            }
        }
    }
    /// Ends the loan of drop batch `token` once its open has finished, whatever the outcome. A file that was never
    /// staged (the open was refused, or its drop batch expired or was replaced first) goes back to the front.
    /// Returns whether it did. Another token changes nothing.
    pub fn settle(&self, token: &str) -> bool {
        let Ok(mut queue) = self.0.lock() else {
            return false;
        };
        if queue.lent.as_ref().is_none_or(|loan| loan.token != token) {
            return false;
        }
        queue.recover()
    }
}

/// The file paths among the arguments a launch received, the program name already removed. Options (`-x`, `--x`) are
/// skipped, a `file://` URI (as Linux desktops may pass) becomes its path, and a relative path is taken from
/// `directory`, the folder the launch ran in.
pub fn file_arguments(
    arguments: impl IntoIterator<Item = OsString>,
    directory: &Path,
) -> Vec<PathBuf> {
    arguments
        .into_iter()
        .filter(|argument| !argument.is_empty() && !argument.to_string_lossy().starts_with('-'))
        .filter_map(|argument| {
            let text = argument.to_string_lossy();
            if text.starts_with("file://") {
                return tauri::Url::parse(&text).ok()?.to_file_path().ok();
            }
            let path = PathBuf::from(argument);
            Some(if path.is_absolute() {
                path
            } else {
                directory.join(path)
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_file_paths_and_resolves_relative_ones_from_the_launch_folder() {
        let folder = std::env::temp_dir().join("launch-folder");
        let absolute = folder.join("elsewhere").join("song.gp");
        let paths = file_arguments(
            [
                OsString::from("--flag"),
                OsString::from(""),
                OsString::from("riff.gp5"),
                absolute.clone().into_os_string(),
                OsString::from("-v"),
            ],
            &folder,
        );
        assert_eq!(paths, vec![folder.join("riff.gp5"), absolute.clone()]);
        let uri = tauri::Url::from_file_path(&absolute).unwrap();
        assert_eq!(
            file_arguments([OsString::from(uri.as_str())], &folder),
            vec![absolute],
            "a file URI becomes its path"
        );
    }

    #[test]
    fn files_go_out_one_at_a_time_and_overflow_is_counted() {
        let folder = std::env::temp_dir();
        let many = (0..200).map(|index| OsString::from(format!("{index}.gp")));
        assert_eq!(
            file_arguments(many, &folder).len(),
            200,
            "the queue, not the arguments, counts what it cannot keep"
        );
        let files = LaunchFiles::default();
        files.push(
            (0..130)
                .map(|index| PathBuf::from(format!("{index}.gp")))
                .collect(),
        );
        assert_eq!(files.take(), (Some(PathBuf::from("0.gp")), 2));
        assert_eq!(
            files.take(),
            (Some(PathBuf::from("1.gp")), 0),
            "overflow is reported once"
        );
        for _ in 2..130 - 2 {
            assert!(files.take().0.is_some());
        }
        assert_eq!(files.take(), (None, 0), "taking empties the queue");
        files.push(vec![PathBuf::from("later.gp")]);
        files.put_back(PathBuf::from("returned.gp"));
        assert_eq!(files.take().0, Some(PathBuf::from("returned.gp")));
        assert_eq!(files.take().0, Some(PathBuf::from("later.gp")));
    }

    #[test]
    fn an_unstaged_loan_comes_back_and_a_staged_one_does_not() {
        let files = LaunchFiles::default();
        files.push(vec![PathBuf::from("a.gp"), PathBuf::from("b.gp")]);
        let (a, _) = files.take();
        files.lend("drop-1".into(), a.unwrap());
        assert!(!files.settle("drop-2"), "another token changes nothing");
        assert!(files.settle("drop-1"), "an unstaged file goes back");
        assert!(!files.settle("drop-1"), "a loan settles once");
        let (again, _) = files.take();
        assert_eq!(again, Some(PathBuf::from("a.gp")));
        files.lend("drop-3".into(), again.unwrap());
        files.staged("drop-4");
        files.staged("drop-3");
        assert!(!files.settle("drop-3"), "a staged file is finished");
        assert_eq!(files.take().0, Some(PathBuf::from("b.gp")));
        // A loan never settled (a failed settle, a reload) comes back on the next take.
        files.lend("drop-5".into(), PathBuf::from("b.gp"));
        assert_eq!(files.take().0, Some(PathBuf::from("b.gp")));
        assert_eq!(files.take().0, None);
    }
}
