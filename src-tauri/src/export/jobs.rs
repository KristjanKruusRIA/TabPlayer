use serde::Serialize;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Running,
    Complete,
    Cancelled,
    Failed,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub id: String,
    pub frames: u64,
    pub total_frames: u64,
    pub status: JobStatus,
    pub error: Option<String>,
}
struct Job {
    document_id: String,
    progress: ExportProgress,
    cancel: Arc<AtomicBool>,
}
#[derive(Default, Clone)]
pub struct ExportJobs {
    current: Arc<Mutex<Option<Job>>>,
}
pub struct JobHandle {
    pub id: String,
    pub cancel: Arc<AtomicBool>,
    jobs: ExportJobs,
}
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
impl ExportJobs {
    pub fn start(&self, document_id: &str, total_frames: u64) -> Result<JobHandle, String> {
        let mut slot = self.current.lock().map_err(|e| e.to_string())?;
        if slot
            .as_ref()
            .is_some_and(|j| j.progress.status == JobStatus::Running)
        {
            return Err("An export is already running.".into());
        }
        let id = format!("export-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed));
        let cancel = Arc::new(AtomicBool::new(false));
        *slot = Some(Job {
            document_id: document_id.into(),
            progress: ExportProgress {
                id: id.clone(),
                frames: 0,
                total_frames,
                status: JobStatus::Running,
                error: None,
            },
            cancel: cancel.clone(),
        });
        Ok(JobHandle {
            id,
            cancel,
            jobs: self.clone(),
        })
    }
    pub fn has_running(&self) -> Result<bool, String> {
        Ok(self
            .current
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .is_some_and(|job| job.progress.status == JobStatus::Running))
    }
    pub fn status(&self, document_id: &str, id: &str) -> Option<ExportProgress> {
        self.current
            .lock()
            .ok()?
            .as_ref()
            .filter(|j| j.document_id == document_id && j.progress.id == id)
            .map(|j| j.progress.clone())
    }
    pub fn cancel(&self, document_id: &str, id: &str) -> Result<(), String> {
        let slot = self.current.lock().map_err(|e| e.to_string())?;
        let job = slot
            .as_ref()
            .filter(|j| j.document_id == document_id && j.progress.id == id)
            .ok_or("Export job is no longer active.")?;
        if job.progress.status == JobStatus::Running {
            job.cancel.store(true, Ordering::Release);
        }
        Ok(())
    }
}
impl JobHandle {
    pub fn total_frames(&self, total: u64) {
        if let Ok(mut slot) = self.jobs.current.lock() {
            if let Some(job) = slot
                .as_mut()
                .filter(|j| j.progress.id == self.id && j.progress.status == JobStatus::Running)
            {
                job.progress.total_frames = total;
            }
        }
    }
    pub fn progress(&self, frames: u64) {
        if let Ok(mut slot) = self.jobs.current.lock() {
            if let Some(job) = slot
                .as_mut()
                .filter(|j| j.progress.id == self.id && j.progress.status == JobStatus::Running)
            {
                job.progress.frames = frames;
            }
        }
    }
    pub fn finish(&self, result: Result<(), String>) {
        if let Ok(mut slot) = self.jobs.current.lock() {
            if let Some(job) = slot.as_mut().filter(|j| j.progress.id == self.id) {
                job.progress.status = if result.is_ok() {
                    JobStatus::Complete
                } else if self.cancel.load(Ordering::Acquire) {
                    JobStatus::Cancelled
                } else {
                    JobStatus::Failed
                };
                job.progress.error = result.err();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;
    #[test]
    fn cancelled_job_releases_slot_and_stale_status_cannot_replace_new_job() {
        let jobs = ExportJobs::default();
        let handle = jobs.start("document-a", 100).unwrap();
        handle.total_frames(120);
        assert_eq!(
            jobs.status("document-a", &handle.id).unwrap().total_frames,
            120
        );
        handle.progress(20);
        let id = handle.id.clone();
        assert_eq!(jobs.status("document-a", &id).unwrap().frames, 20);
        jobs.cancel("document-a", &id).unwrap();
        assert!(handle.cancel.load(Ordering::Acquire));
        handle.finish(Err("cancelled".into()));
        assert_eq!(
            jobs.status("document-a", &id).unwrap().status,
            JobStatus::Cancelled
        );
        let next = jobs.start("document-a", 10).unwrap();
        assert_ne!(next.id, id);
        assert!(jobs.status("document-a", &id).is_none());
        next.finish(Ok(()));
        assert_eq!(
            jobs.status("document-a", &next.id).unwrap().status,
            JobStatus::Complete
        );
    }

    #[test]
    fn origin_capture_survives_picker_and_export_cancel() {
        let jobs = ExportJobs::default();
        let handle = jobs.start("document-a", 100).unwrap();
        assert!(jobs.status("document-b", &handle.id).is_none());
        assert!(jobs.cancel("document-b", &handle.id).is_err());
        assert!(!handle.cancel.load(Ordering::Acquire));
        assert!(jobs.has_running().unwrap());
        jobs.cancel("document-a", &handle.id).unwrap();
        assert!(jobs.has_running().unwrap());
        assert!(jobs.start("document-b", 1).is_err());
        handle.finish(Err("cancelled".into()));
        assert!(!jobs.has_running().unwrap());
        assert_eq!(
            jobs.status("document-a", &handle.id).unwrap().status,
            JobStatus::Cancelled
        );
        let next = jobs.start("document-b", 10).unwrap();
        handle.progress(99);
        handle.finish(Ok(()));
        assert_eq!(jobs.status("document-b", &next.id).unwrap().frames, 0);
        assert_eq!(
            jobs.status("document-b", &next.id).unwrap().status,
            JobStatus::Running
        );
    }
}
