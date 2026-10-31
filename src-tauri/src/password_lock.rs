//! The password protections of an open document and of a sealed file waiting to open.
//!
//! The key derivation takes a fraction of a second by design. Every function here copies what it must check against out of
//! the document workspace, releases the workspace, does the slow work, and only then takes the workspace again to make
//! the change, which is refused if the document was changed in the meantime. A password attempt never stalls the app.

use crate::{
    password_crypto::{
        KdfParams, OpenLock, PasswordVerifier, Secret, WRONG_PASSWORD, check_new_password, unseal,
    },
    project::{Project, ProtectionChange},
    workspace::{DocumentIntake, DocumentRevision, DocumentSnapshot, DocumentWorkspace},
};
use serde::Deserialize;
use std::sync::Mutex;

/// What the person asked of a document's protection. Each change to an existing password names the current one.
#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProtectionRequest {
    /// Give the password to edit for this session.
    UnlockEditing {
        password: Secret,
    },
    /// Refuse edits again without closing the score.
    LockEditing,
    SetEditPassword {
        current: Option<Secret>,
        password: Secret,
    },
    RemoveEditPassword {
        current: Secret,
    },
    SetOpenPassword {
        current: Option<Secret>,
        password: Secret,
    },
    RemoveOpenPassword {
        current: Secret,
    },
}

fn lock<T>(
    workspace: &Mutex<DocumentWorkspace>,
    action: impl FnOnce(&mut DocumentWorkspace) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = workspace.lock().map_err(|error| error.to_string())?;
    action(&mut guard)
}

pub fn apply_protection(
    workspace: &Mutex<DocumentWorkspace>,
    address: &DocumentRevision,
    request: ProtectionRequest,
) -> Result<DocumentSnapshot, String> {
    apply_protection_with(workspace, address, request, KdfParams::DEFAULT)
}

/// As `apply_protection`, with the costs a new password is made under. Tests choose small ones.
pub fn apply_protection_with(
    workspace: &Mutex<DocumentWorkspace>,
    address: &DocumentRevision,
    request: ProtectionRequest,
    params: KdfParams,
) -> Result<DocumentSnapshot, String> {
    let state = lock(workspace, |workspace| workspace.protection_state(address))?;
    let verify_edit = |password: &Secret| -> Result<PasswordVerifier, String> {
        let verifier = state
            .edit
            .clone()
            .ok_or("This score has no password to edit.")?;
        verifier.verify(password)?;
        Ok(verifier)
    };
    let verify_open = |password: &Secret| -> Result<OpenLock, String> {
        let current = state
            .open
            .clone()
            .ok_or("This score has no password to open.")?;
        if current.accepts(password) {
            Ok(current)
        } else {
            Err(WRONG_PASSWORD.into())
        }
    };
    let change = match request {
        ProtectionRequest::UnlockEditing { password } => ProtectionChange::UnlockEditing {
            verifier: verify_edit(&password)?,
        },
        ProtectionRequest::LockEditing => ProtectionChange::LockEditing,
        ProtectionRequest::SetEditPassword { current, password } => {
            check_new_password(password.expose())?;
            if state.edit.is_some() {
                verify_edit(&current.ok_or(WRONG_PASSWORD)?)?;
            }
            ProtectionChange::SetEdit {
                replacing: state.edit.clone(),
                verifier: PasswordVerifier::create(password.expose(), params)?,
            }
        }
        ProtectionRequest::RemoveEditPassword { current } => ProtectionChange::RemoveEdit {
            verifier: verify_edit(&current)?,
        },
        ProtectionRequest::SetOpenPassword { current, password } => {
            check_new_password(password.expose())?;
            if state.open.is_some() {
                verify_open(&current.ok_or(WRONG_PASSWORD)?)?;
            }
            ProtectionChange::SetOpen {
                replacing: state.open.as_ref().map(OpenLock::salt),
                lock: OpenLock::create(password.expose(), params)?,
            }
        }
        ProtectionRequest::RemoveOpenPassword { current } => ProtectionChange::RemoveOpen {
            replacing: verify_open(&current)?.salt(),
        },
    };
    lock(workspace, |workspace| {
        workspace.change_protection(address, change)
    })
}

/// Opens the sealed file waiting under `token`. A wrong password leaves the file waiting, so another may be tried;
/// the only error it gives is the one every failure to decrypt gives.
pub fn unlock_document(
    workspace: &Mutex<DocumentWorkspace>,
    token: &str,
    password: &Secret,
) -> Result<DocumentIntake, String> {
    let (_, bytes, _) = lock(workspace, |workspace| workspace.locked_intake(token))?;
    let (plaintext, open_lock) = unseal(&bytes, password)?;
    // The seal authenticated these bytes, so a failure here is a file from a build this one does not understand,
    // not a guess at the password.
    let mut project: Project =
        serde_json::from_slice(&plaintext).map_err(|error| format!("Invalid project: {error}"))?;
    drop(plaintext);
    project.validate()?;
    project.open_lock = Some(open_lock);
    lock(workspace, |workspace| {
        workspace.finish_locked(token, project)
    })
    .map(|candidate| DocumentIntake::Candidate { candidate })
}
